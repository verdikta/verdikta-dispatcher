#!/usr/bin/env node
/*  scripts/reveal-forensics.js  (v2 aggregator)
    -------------------------------------------------------------------------------------------
    Per-slot forensics for ONE round: why each juror's commit and reveal did or did not count.

    v2 emits no diagnostic events for bad replies (it ignores them silently), so this script
    reconstructs every verdict itself:
      1. getRoundInfo / getJury / getSlot(aggId, i) give the jury, each slot's operator, key,
         flags (dispatched, committed, promoted, revealed, counted), qcode and stored commit;
      2. the commit and reveal request ids are computed (scripts/lib/v2-reveal.js) and checked
         against the operators' OracleRequest events in the draw and promote transactions;
      3. each operator's OracleResponse(requestId) leads to the fulfil transaction, whose calldata
         (fulfillOracleRequestV / fulfillOracleRequest2) carries (requestId, scores, "cid:salt");
      4. the replies are replayed in chain order against the aggregator's checks: deadline, phase,
         slot flags, score count, cid length, cid:salt format and the commit hash
         keccak256(abi.encode(aggId, operator, scores, salt)). The replay's verdict is compared with
         the CommitReceived / RevealReceived events of the same transaction (column "chain").
    The ArbiterOperator's OracleCallbackAttempt/Result events (gas, success, revert reason) are
    shown when present.

    HARDHAT_NETWORK=base_sepolia node scripts/reveal-forensics.js \
      --aggregator 0x... --aggid 0x000...002a --auto-discover
    (--aggid also takes a plain round number, e.g. --aggid 42)

    --auto-discover  tags each fulfil tx's sender against the operators' getAuthorizedSenders()
    --fromaddrs      comma-separated node addresses to tag against instead
    --lookahead      blocks scanned past the round deadline (late replies, settlement)
   ------------------------------------------------------------------------------------------- */
const { ethers } = require("ethers");
const { lc, getLogsChunked, makeTimestamper, decodeOperatorFulfill } = require("./lib/chain-stats-utils");
const V2 = require("./lib/v2-reveal");

const pad = (s, n) => String(s).padEnd(n);
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

const OP_IFACE = new ethers.Interface([
  "event OracleRequest(bytes32 indexed specId, address requester, bytes32 requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
  "event OracleResponse(bytes32 indexed requestId)",
  "event OracleCallbackAttempt(bytes32 indexed requestId, address callback, bytes4 selector, uint256 gasBefore)",
  "event OracleCallbackResult(bytes32 indexed requestId, bool success, bytes returnData, uint256 gasAfter)",
  "function getAuthorizedSenders() view returns (address[])",
]);

function normalizeAggId(s) {
  s = String(s || "").trim();
  if (/^\d+$/.test(s)) return V2.aggIdOf(BigInt(s));
  const m = s.match(/0x[0-9a-fA-F]{64}/) || s.match(/[0-9a-fA-F]{64}/);
  if (!m) throw new Error(`--aggid must be a round number or 0x + 64 hex; got: ${s}`);
  return lc(m[0].startsWith("0x") ? m[0] : "0x" + m[0]);
}

function hexToAscii(hex) {
  hex = (hex || "").replace(/^0x/, "");
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte >= 32 && byte < 127) out += String.fromCharCode(byte);
  }
  return out;
}

function decodeRevertData(dataHex, ifaces) {
  if (!dataHex || dataHex === "0x") return "(no data)";
  const d = dataHex.startsWith("0x") ? dataHex : "0x" + dataHex;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  try {
    if (d.startsWith("0x08c379a0")) return String(coder.decode(["string"], "0x" + d.slice(10))[0]);
    if (d.startsWith("0x4e487b71")) return `panic code ${coder.decode(["uint256"], "0x" + d.slice(10))[0]}`;
  } catch { /* fall through */ }
  for (const i of ifaces) {
    try { const p = i.parseError(d); if (p) return p.name + (p.args.length ? `(${p.args.join(", ")})` : ""); } catch { /* next */ }
  }
  return d.length > 74 ? `revert data ${d.slice(0, 74)}…` : d;
}

const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * Core: gather and replay one round. Returns a plain object (printed by printReport):
 * { aggregator, aggId, roundId, jury, info, phase, outcome, slots[], expected[] }
 * opts: { provider, aggregator, aggId, aggAbi, fromaddrs: [], autoDiscover, lookahead, toBlock, chunk }
 */
async function forensics(opts) {
  const { provider, aggAbi } = opts;
  const AGG = ethers.getAddress(opts.aggregator);
  const AGG_LC = lc(AGG);
  const aggId = normalizeAggId(opts.aggId);
  const roundId = V2.roundIdOf(aggId);
  const agg = new ethers.Contract(AGG, aggAbi, provider);
  const lookahead = opts.lookahead ?? 1500;

  const ri = await agg.getRoundInfo(aggId);
  const info = {
    phase: Number(ri.phase), requestBlock: Number(ri.requestBlock), closeBlock: Number(ri.closeBlock),
    deadline: Number(ri.deadline), windowEnd: Number(ri.windowEnd), commits: Number(ri.commits),
    requestTime: Number(ri.requestTime), sealedHash: ri.sealedHash,
  };
  if (info.phase === 0) throw new Error(`round ${roundId} unknown to aggregator ${AGG}`);
  const j = await agg.getJury(aggId);
  const jury = { K: Number(j.K), M: Number(j.M), N: Number(j.N), P: Number(j.P), timeout: Number(j.timeout) };

  /* ── scan range: request block .. deadline (estimated as a block) + lookahead ── */
  const latest = await provider.getBlockNumber();
  let to = opts.toBlock ?? latest;
  if (opts.toBlock == null && info.deadline) {
    const T = await makeTimestamper(provider, Math.max(0, info.requestBlock - 1), latest);
    const dlBlock = info.requestBlock + Math.ceil((info.deadline - info.requestTime) / Math.max(T.blockTime, 1e-3));
    to = Math.min(latest, dlBlock + lookahead);
  }
  const from = info.requestBlock;

  /* ── aggregator events for this round (all are indexed by aggId) ── */
  const names = ["JuryDrawn", "BasePayment", "SlotSkipped", "CommitReceived", "CommitWindowClosed", "CommitPhaseComplete",
    "RevealReceived", "FulfillAIEvaluation", "EvaluationFailed", "RoundSettled", "RoundCancelled"];
  const topics = names.map((n) => agg.interface.getEvent(n).topicHash);
  const logs = (await getLogsChunked(provider, { address: AGG, topics: [topics, aggId] }, from, to, opts.chunk ?? 10000, "aggregator"))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  const evs = logs.map((l) => ({ ...agg.interface.parseLog(l), pos: [l.blockNumber, l.index], tx: l.transactionHash, block: l.blockNumber }));
  const ev1 = (n) => evs.find((e) => e.name === n);
  const drawn = ev1("JuryDrawn");
  const promoted = ev1("CommitPhaseComplete");

  // phase timeline (what fulfill saw): each entry is [pos, phase]
  const timeline = [];
  if (drawn) timeline.push([drawn.pos, 3]);
  for (const e of evs) {
    if (e.name === "CommitWindowClosed") timeline.push([e.pos, 4]);
    if (e.name === "CommitPhaseComplete") timeline.push([e.pos, 5]);
    if (e.name === "FulfillAIEvaluation") timeline.push([e.pos, 6]);
    if (e.name === "EvaluationFailed") timeline.push([e.pos, 8]);
    if (e.name === "RoundSettled") timeline.push([e.pos, e.args.failed ? 8 : 7]);
  }
  const phaseAt = (pos) => { let p = 1; for (const [q, ph] of timeline) if (before(q, pos)) p = ph; return p; };

  /* ── slots ── */
  const keeper = new ethers.Contract(await agg.keeper(),
    ["function oracleJob(bytes32) view returns (address, bytes32)"], provider);
  const slots = [];
  for (let i = 0; i < jury.K; i++) {
    const s = await agg.getSlot(aggId, i);
    let jobId = null;
    if (s.key !== ethers.ZeroHash) { try { jobId = lc((await keeper.oracleJob(s.key))[1]); } catch { /* keeper changed */ } }
    slots.push({
      slot: i, operator: lc(s.oracle), key: lc(s.key), jobId, payee: lc(s.payee), flags: Number(s.flags),
      qcode: Number(s.qcode), commitHash: lc(s.commitHash), fee: s.fee,
      commitId: V2.requestIdFor(AGG, roundId, i, false), revealId: V2.requestIdFor(AGG, roundId, i, true),
      skipped: evs.filter((e) => e.name === "SlotSkipped" && Number(e.args.pollIndex) === i).map((e) => V2.SKIP_REASONS[Number(e.args.reason)] || `reason ${e.args.reason}`),
      commit: null, reveal: null,
    });
  }

  /* ── OracleRequest events in the draw and promote transactions: confirm the computed ids ── */
  const reqTopic = OP_IFACE.getEvent("OracleRequest").topicHash;
  const seenReq = new Map();   // requestId -> {operator, specId, cbAddr, cbFunc, block}
  for (const e of [drawn, promoted].filter(Boolean)) {
    const rc = await provider.getTransactionReceipt(e.tx);
    for (const l of rc.logs) {
      if (l.topics[0] !== reqTopic) continue;
      try {
        const p = OP_IFACE.parseLog(l);
        if (lc(p.args.requester) !== AGG_LC) continue;
        seenReq.set(lc(p.args.requestId), {
          operator: lc(l.address), specId: lc(p.args.specId), cbAddr: lc(p.args.callbackAddr),
          cbFunc: lc(p.args.callbackFunctionId), block: l.blockNumber,
        });
      } catch { /* not an operator request */ }
    }
  }
  const FULFILL_SEL = lc(agg.interface.getFunction("fulfill").selector);

  /* ── replies: OracleResponse(requestId) at the slot's operator -> fulfil tx ── */
  const respTopic = OP_IFACE.getEvent("OracleResponse").topicHash;
  const attempts = [];
  const blockTs = new Map();
  const tsOf = async (n) => { if (!blockTs.has(n)) blockTs.set(n, (await provider.getBlock(n)).timestamp); return blockTs.get(n); };
  for (const s of slots) {
    for (const kind of ["commit", "reveal"]) {
      const id = kind === "commit" ? s.commitId : s.revealId;
      const req = seenReq.get(id);
      const operator = req?.operator || s.operator;
      const st = { kind, requestId: id, requested: !!req, req, operator, reply: null };
      s[kind] = st;
      if (!operator || operator === lc(ethers.ZeroAddress)) continue;
      let rl = [];
      try {
        rl = await getLogsChunked(provider, { address: ethers.getAddress(operator), topics: [respTopic, id] },
          drawn ? drawn.block : from, to, opts.chunk ?? 10000, "operator");
      } catch { /* RPC refused */ }
      if (!rl.length) continue;
      const log = rl[0];
      const [tx, rc] = await Promise.all([provider.getTransaction(log.transactionHash), provider.getTransactionReceipt(log.transactionHash)]);
      const r = {
        hash: tx.hash, from: lc(tx.from), nonce: tx.nonce, status: rc.status, block: rc.blockNumber,
        ts: await tsOf(rc.blockNumber), pos: [log.blockNumber, log.index], sig: (tx.data || "0x").slice(0, 10),
        cbAttemptGas: null, cbSuccess: null, cbReason: null, dec: null, decodeError: null,
      };
      try { r.dec = decodeOperatorFulfill(tx.data); } catch (e) { r.decodeError = e.message; }
      for (const lg of rc.logs) {
        if (lc(lg.address) !== operator || lc(lg.topics[1]) !== id) continue;
        try {
          const p = OP_IFACE.parseLog(lg);
          if (p.name === "OracleCallbackAttempt") r.cbAttemptGas = p.args.gasBefore.toString();
          if (p.name === "OracleCallbackResult") {
            r.cbSuccess = p.args.success;
            if (!p.args.success) r.cbReason = decodeRevertData(p.args.returnData, [agg.interface]);
          }
        } catch { /* other event */ }
      }
      // the aggregator's own events in the same transaction for this slot
      r.chain = evs.filter((e) => e.tx === tx.hash && (e.name === "CommitReceived" || e.name === "RevealReceived") &&
        Number(e.args.pollIndex) === s.slot);
      r.refOpen = (await agg.requestRef(id)) !== 0n;   // still set: the aggregator's call reverted
      st.reply = r;
      attempts.push({ s, st, r });
    }
  }

  /* ── replay in chain order ── */
  attempts.sort((a, b) => (before(a.r.pos, b.r.pos) ? -1 : 1));
  const committed = new Set(), revealed = new Set();
  for (const { s, st, r } of attempts) {
    const v = (verdict, accepted = false, extra = {}) => Object.assign(r, { verdict, accepted, ...extra });
    if (r.cbSuccess === false) { v(`aggregator reverted: ${r.cbReason}`); continue; }
    if (r.refOpen) { v("aggregator call reverted (request still open)"); continue; }
    if (!r.dec) { v(`undecodable fulfil (${short(r.decodeError || "", 40)})`); continue; }
    if (r.dec.requestId !== st.requestId) { v("inner requestId differs"); continue; }
    if (r.dec.callback !== AGG_LC) { v("callback is not this aggregator"); continue; }
    if (info.deadline && r.ts > info.deadline) { v(`past deadline (+${r.ts - info.deadline}s)`); continue; }
    const scores = r.dec.scores;
    const ph = phaseAt(r.pos);
    r.phaseSeen = V2.PHASES[ph] || String(ph);
    if (V2.isCommitShaped(scores, r.dec.cid)) {
      r.shape = "commit";
      if (ph !== 3) v(`commit in phase ${r.phaseSeen}`);
      else if (BigInt(scores[0]) === 0n) v("zero commit hash");
      else if (committed.has(s.slot)) v("already committed");
      else { committed.add(s.slot); v("committed", true); }
    } else {
      r.shape = "reveal";
      if (ph !== 5 && ph !== 6) v(`reveal in phase ${r.phaseSeen}`);
      else if (!(s.flags & V2.SLOT_FLAGS.PROMOTED)) v("slot not promoted");
      else if (revealed.has(s.slot)) v("already revealed");
      else {
        const c = V2.checkReveal({ aggId, operator: st.operator, scores, cid: r.dec.cid, commitHash: s.commitHash });
        r.cidOnly = c.cid;
        if (!c.ok) v(c.reason);
        else {
          revealed.add(s.slot);
          v(ph === 5 ? "counted" : `late (after final, q=${V2.QCODES[s.qcode] || s.qcode})`, true, { clamped: c.clamped });
        }
      }
    }
    const want = r.shape === "commit" ? "CommitReceived" : "RevealReceived";
    const onChain = r.chain.some((e) => e.name === want);
    r.chainAgrees = onChain === r.accepted;
  }

  /* ── per-slot diagnosis ── */
  for (const s of slots) {
    const c = s.commit.reply, rv = s.reveal.reply;
    s.diagnosis =
      s.skipped.length && !(s.flags & V2.SLOT_FLAGS.DISPATCHED) ? `skipped at draw: ${s.skipped.join(", ")}` :
      !(s.flags & V2.SLOT_FLAGS.COMMITTED) ? (c ? `commit ignored: ${c.verdict}` : "no commit reply") :
      !(s.flags & V2.SLOT_FLAGS.PROMOTED) ? (promoted ? "committed, not promoted" : "committed (round not promoted)") :
      s.flags & V2.SLOT_FLAGS.COUNTED ? "OK (counted)" :
      s.flags & V2.SLOT_FLAGS.REVEALED ? `OK (late reveal, q=${V2.QCODES[s.qcode] || s.qcode})` :
      s.skipped.includes(V2.SKIP_REASONS[3]) ? "reveal dispatch reverted" :
      rv ? `reveal ignored: ${rv.verdict}` : "no reveal reply";
    if ([c, rv].some((r) => r && r.chainAgrees === false)) s.diagnosis += " | REPLAY DISAGREES WITH CHAIN";
    if (rv?.clamped) s.diagnosis += ` | ${rv.clamped} score(s) clamped to 1e34`;
  }

  /* ── expected node senders ── */
  let expected = (opts.fromaddrs || []).map((a) => lc(ethers.getAddress(a)));
  if (opts.autoDiscover) {
    const ops = [...new Set(slots.map((s) => s.operator).filter((o) => o && o !== lc(ethers.ZeroAddress)))];
    const found = new Set();
    for (const o of ops) {
      try {
        const c = new ethers.Contract(ethers.getAddress(o), OP_IFACE, provider);
        for (const a of await c.getAuthorizedSenders()) found.add(lc(a));
      } catch { /* not a Chainlink Operator */ }
    }
    expected = [...found];
  }

  const ph = info.phase;
  const failedEv = evs.find((e) => e.name === "EvaluationFailed");
  const outcome =
    ph === 6 || ph === 7 ? `COMPLETED${ph === 7 ? " (settled)" : " (awaiting settlement)"}` :
    ph === 8 ? `FAILED${failedEv ? ` in phase ${V2.PHASES[Number(failedEv.args.phase)] || failedEv.args.phase}` : ""}` :
    ph === 9 ? "CANCELLED" : `IN PROGRESS (phase ${V2.PHASES[ph] || ph})`;

  return {
    aggregator: AGG, aggId, roundId: roundId.toString(), jury, info, phase: V2.PHASES[ph] || String(ph), outcome,
    range: { from, to }, fulfillSelector: FULFILL_SEL, drawBlock: drawn?.block ?? null, promoteBlock: promoted?.block ?? null,
    finalizeBlock: ev1("FulfillAIEvaluation")?.block ?? null, slots, expected,
  };
}

function printReport(R, log = console.log) {
  const F = V2.SLOT_FLAGS;
  const list = (f) => R.slots.filter(f).map((s) => s.slot);
  log(`Round ${R.roundId} (${R.aggId}) on ${R.aggregator}`);
  log(`  jury K=${R.jury.K} M=${R.jury.M} N=${R.jury.N} P=${R.jury.P} timeout=${R.jury.timeout}s; phase ${R.phase}; ` +
    `blocks: request ${R.info.requestBlock}, draw ${R.drawBlock ?? "-"}, close ${R.info.closeBlock || "-"}, ` +
    `promote ${R.promoteBlock ?? "-"}, final ${R.finalizeBlock ?? "-"}; deadline ${R.info.deadline || "-"}; scanned ${R.range.from}..${R.range.to}`);
  log("Dispatched slots:", list((s) => s.flags & F.DISPATCHED));
  log("Committed slots :", list((s) => s.flags & F.COMMITTED));
  log("Promoted slots  :", list((s) => s.flags & F.PROMOTED));
  log("Counted slots   :", list((s) => s.flags & F.COUNTED));
  log("Late reveals    :", list((s) => (s.flags & F.REVEALED) && !(s.flags & F.COUNTED)));
  log("Missing slots   :", list((s) => (s.flags & F.PROMOTED) && !(s.flags & F.REVEALED)));
  log("RequestIds (slot -> reveal requestId @ operator):");
  for (const s of R.slots.filter((x) => x.flags & F.PROMOTED)) log(`  ${s.slot}: ${s.revealId} @ ${s.operator}`);

  const exp = new Set(R.expected);
  const tag = (a) => (!a ? "-" : !exp.size ? ethers.getAddress(a) : `${ethers.getAddress(a)} (${exp.has(a) ? "expected" : "UNEXPECTED"})`);
  const yn = (b) => (b == null ? "-" : b ? "yes" : "NO");

  log(`\nAggregator fulfill selector (expected by job): ${R.fulfillSelector}`);
  log("\nCommit stage (slot, flags DCPRK, commit request seen, reply block, lag from draw, verdict):");
  for (const s of R.slots) {
    const r = s.commit.reply;
    log(" ", pad(s.slot, 4), pad(V2.flagString(s.flags), 6), pad(yn(s.commit.requested), 4),
      pad(r ? r.block : "-", 9), pad(r && R.drawBlock != null ? r.block - R.drawBlock : "-", 6),
      r ? r.verdict + (r.chainAgrees === false ? " (chain disagrees)" : "") : (s.skipped.length ? `skipped: ${s.skipped.join(", ")}` : "no reply"));
  }

  log("\nReveal stage (promoted slots):");
  log(pad("slot", 4), pad("operator", 42), pad("requestId", 66), pad("promBlk", 8), pad("jobId", 34),
    pad("cbAddrOK", 8), pad("cbFuncOK", 8), pad("reqIdOK", 8), pad("aggCounted", 12), pad("cbAttemptGas", 12),
    pad("cbSuccess", 10), pad("reason/return", 34), pad("opTx(hash…)", 20), pad("block", 8), pad("lag", 5),
    pad("from", 53), pad("nonce", 6), pad("status", 6), pad("op.sig", 10), pad("phase", 8), pad("scores", 16),
    pad("cid", 36), pad("verdict", 28));
  for (const s of R.slots.filter((x) => x.flags & F.PROMOTED)) {
    const q = s.reveal.req, r = s.reveal.reply;
    const jobId = s.jobId || q?.specId;
    const jobShow = jobId ? `${hexToAscii(jobId) || "?"} (${jobId.slice(0, 10)}…)` : "-";
    const scores = r?.dec ? `${r.dec.scores.length}:[${r.dec.scores.slice(0, 3).join(",")}${r.dec.scores.length > 3 ? "…" : ""}]` : "-";
    const cid = r?.dec ? (r.cidOnly ?? r.dec.cid) || "(empty)" : "-";
    log(pad(s.slot, 4), pad(s.operator, 42), pad(s.revealId, 66), pad(R.promoteBlock ?? "-", 8), pad(short(jobShow, 33), 34),
      pad(q ? yn(q.cbAddr === lc(R.aggregator)) : "-", 8), pad(q ? yn(q.cbFunc === R.fulfillSelector) : "-", 8),
      pad(yn(s.reveal.requested), 8),
      pad(s.flags & F.COUNTED ? "counted" : s.flags & F.REVEALED ? "late" : "no", 12),
      pad(r?.cbAttemptGas ?? "-", 12), pad(r ? yn(r.cbSuccess) : "-", 10), pad(short(r?.cbReason || "-", 33), 34),
      pad(r ? r.hash.slice(0, 18) + "…" : "-", 20), pad(r ? r.block : "-", 8),
      pad(r && R.promoteBlock != null ? r.block - R.promoteBlock : "-", 5), pad(r ? tag(r.from) : "-", 53),
      pad(r ? r.nonce : "-", 6), pad(r ? r.status : "-", 6), pad(r ? r.sig : "-", 10), pad(r?.phaseSeen || "-", 8),
      pad(scores, 16), pad(short(cid, 35), 36), pad(s.diagnosis, 28));
  }

  log("\nPer-slot diagnosis:");
  for (const s of R.slots) log(`  ${pad(s.slot, 3)} ${pad(V2.flagString(s.flags), 6)} ${s.diagnosis}`);
  log("\nOutcome:", R.outcome);
}

if (require.main === module) {
  const yargs = require("yargs/yargs");
  const { hideBin } = require("yargs/helpers");
  const argv = yargs(hideBin(process.argv))
    .option("aggregator", { type: "string", demandOption: true })
    .option("aggid", { type: "string", demandOption: true, desc: "0x + 64 hex, or the round number" })
    .option("fromaddrs", { type: "string", default: "" })
    .option("auto-discover", { type: "boolean", default: false, description: "Tag senders against the operators' getAuthorizedSenders()" })
    .option("lookahead", { type: "number", default: 1500, desc: "blocks scanned past the round deadline" })
    .option("to-block", { type: "number" })
    .option("chunk", { type: "number", default: 10000 })
    .option("json-out", { type: "string" })
    .strict().argv;
  (async () => {
    require("dotenv").config();
    const hre = require("hardhat");
    const aggAbi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
    const R = await forensics({
      provider: hre.ethers.provider, aggregator: argv.aggregator, aggId: argv.aggid, aggAbi,
      fromaddrs: argv.fromaddrs.split(",").map((s) => s.trim()).filter(Boolean),
      autoDiscover: argv.autoDiscover, lookahead: argv.lookahead, toBlock: argv.toBlock, chunk: argv.chunk,
    });
    printReport(R);
    if (argv.jsonOut) {
      require("fs").writeFileSync(argv.jsonOut, JSON.stringify(R, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { forensics, printReport, normalizeAggId };
