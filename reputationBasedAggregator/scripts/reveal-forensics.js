#!/usr/bin/env node

/*
HARDHAT_NETWORK=base_sepolia \
node scripts/reveal-forensics.js \
  --aggregator 0x6a26f45D5BbFC3AEEd8De9bd2B8285b96554bC47 \
  --aggid      0x064e3289be2ffdda5257a7df59aab4b7e417bdb4f047d8ba0b3050091fd20857 \
  --fromaddrs  0x21ADE4d3baE4dF7df710b3B37F319C02f6775060,0x7D1F2ed1d49f2711B301982dF121dd0F4E587759,0xA2944d1Dd73DB724d9bA31a80Ea240B5dF922498,0xF02E746A8f40EAAf7dCB0a3a9B31B0ba23e0387c,0xe9ECd1aE744eD9d1d63E7e0034ffCbd7f3B0a877
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const { keccak256, toUtf8Bytes } = ethers;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const lc  = (x) => (x || "").toLowerCase();
const pad = (s, n) => String(s).padEnd(n);

function normalizeAggId(s) {
  s = (s || "").trim();
  const m = s.match(/0x[0-9a-fA-F]{64}/) || s.match(/[0-9a-fA-F]{64}/);
  if (!m) throw new Error(`--aggid must be 0x + 64 hex; got: ${s}`);
  const hex = m[0].startsWith("0x") ? m[0] : "0x" + m[0];
  return hex.toLowerCase();
}

(async () => {
  const argv = yargs(hideBin(process.argv))
    .option("aggregator", { type: "string", demandOption: true })
    .option("aggid",      { type: "string", demandOption: true })
    .option("fromaddrs",  { type: "string", default: "" })
    .option("lookahead",  { type: "number", default: 1500 })
    .strict().argv;

  const provider = ethers.provider;
  const aggAbi   = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const agg      = new ethers.Contract(argv.aggregator, aggAbi, provider);

  const AGG_ADDR    = ethers.getAddress(argv.aggregator);
  const AGG_ADDR_LC = lc(AGG_ADDR);

  const EXPECTED = (argv.fromaddrs || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .map(ethers.getAddress);
  const EXPECTED_LC = new Set(EXPECTED.map(lc));

  const aggId = normalizeAggId(argv.aggid);

  // ── Topics & ABIs ──────────────────────────────────────────────────────────
  const topicRevealReq      = agg.interface.getEvent("RevealRequestDispatched").topicHash;
  const topicRecorded       = agg.interface.getEvent("NewOracleResponseRecorded").topicHash;
  const topicEvalFailed     = agg.interface.getEvent("EvaluationFailed").topicHash;
  const topicFulfilledAgg   = agg.interface.getEvent("FulfillAIEvaluation").topicHash;
  const topicTimedOut       = agg.interface.getEvent("EvaluationTimedOut").topicHash;
  const topicOracleSel      = agg.interface.getEvent("OracleSelected").topicHash;

  const topicHashMismatch   = agg.interface.getEvent("RevealHashMismatch").topicHash;
  const topicInvalidFmt     = agg.interface.getEvent("InvalidRevealFormat").topicHash;
  const topicTooMany        = agg.interface.getEvent("RevealTooManyScores").topicHash;
  const topicWrongCount     = agg.interface.getEvent("RevealWrongScoreCount").topicHash;
  const topicTooFew         = agg.interface.getEvent("RevealTooFewScores").topicHash;

  const TOPIC_CL_REQUESTED  = keccak256(toUtf8Bytes("ChainlinkRequested(bytes32)"));
  const TOPIC_CL_FULFILLED  = keccak256(toUtf8Bytes("ChainlinkFulfilled(bytes32)"));

  // Operator events
  const topicOracleRequest  = keccak256(toUtf8Bytes(
    "OracleRequest(bytes32,address,bytes32,uint256,address,bytes4,uint256,uint256,bytes)"
  ));
  const topicOracleResponse = keccak256(toUtf8Bytes(
    "OracleResponse(bytes32)"
  ));

  // Use correct indexed-ABI for parsing
  const operatorIface = new ethers.Interface([
    "event OracleRequest(bytes32 indexed specId, address requester, bytes32 requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
    "event OracleResponse(bytes32 indexed requestId)"
  ]);

  // Manual decode fallback for OracleRequest (specId is indexed; the rest sits in data)
  const decodeOracleRequestData = (dataHex) => {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return coder.decode(
      ["address","bytes32","uint256","address","bytes4","uint256","uint256","bytes"],
      dataHex
    );
  };

  const AGG_FULFILL_SELECTOR = ethers.id("fulfill(bytes32,uint256[],string)").slice(0, 10);

  // ── Dispatches for this aggId ──────────────────────────────────────────────
  const latest    = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 50_000);

  const dispLogs = await provider.getLogs({
    address: AGG_ADDR,
    topics: [topicRevealReq, aggId],
    fromBlock, toBlock: "latest"
  });
  if (dispLogs.length === 0) {
    console.log("No RevealRequestDispatched found for this aggId in recent blocks.");
    process.exit(0);
  }
  const dispatches = dispLogs.map(l => {
    const p = agg.interface.parseLog(l);
    return { slot: Number(p.args.pollIndex), commitHash: p.args.commitHash, blockNumber: l.blockNumber, txHash: l.transactionHash };
  });
  const dispatchedSlots = [...new Set(dispatches.map(d => d.slot))].sort((a,b)=>a-b);

  // Which slots recorded?
  const recLogsRaw = await provider.getLogs({
    address: AGG_ADDR,
    topics: [topicRecorded],
    fromBlock, toBlock: "latest"
  });
  const recordedSlots = new Set();
  const recordedBySlot = new Map();
  for (const l of recLogsRaw) {
    try {
      const p = agg.interface.parseLog(l);
      const parent = (await agg.requestIdToAggregatorId(p.args.requestId)).toLowerCase();
      if (parent === aggId) {
        const s = Number(p.args.pollIndex);
        recordedSlots.add(s);
        recordedBySlot.set(s, { requestId: lc(p.args.requestId), blockNumber: l.blockNumber, txHash: l.transactionHash });
      }
    } catch {}
  }
  const missingSlots = dispatchedSlots.filter(s => !recordedSlots.has(s));

  console.log("Dispatched slots:", dispatchedSlots);
  console.log("Recorded slots  :", [...recordedSlots].sort((a,b)=>a-b));
  console.log("Missing slots   :", missingSlots);

  // slot → operator via OracleSelected
  const slotToOperator = new Map();
  const selLogs = await provider.getLogs({
    address: AGG_ADDR,
    topics: [topicOracleSel, aggId],
    fromBlock, toBlock: "latest"
  });
  for (const l of selLogs) {
    const p = agg.interface.parseLog(l);
    slotToOperator.set(Number(p.args.pollIndex), lc(p.args.oracle));
  }

  // ── Recover requestIds from CLRequested; and decode OperatorRequest per slot ─
  const slotToReq = new Map(); // slot -> { requestId, operator, dispatchBlock }
  const perSlotCb = new Map(); // slot -> { jobId, cbAddr, cbFuncId }

  for (const d of dispatches) {
    const rcpt = await provider.getTransactionReceipt(d.txHash);

    // Aggregator → ChainlinkRequested
    for (const log of rcpt.logs) {
      if (lc(log.address) !== AGG_ADDR_LC) continue;
      if (log.topics[0] !== TOPIC_CL_REQUESTED) continue;
      const requestId = (log.topics[1] || "").toLowerCase();
      const parent = (await agg.requestIdToAggregatorId(requestId)).toLowerCase();
      if (parent !== aggId) continue;
      const slot = Number(await agg.requestIdToPollIndex(requestId));
      const operator = slotToOperator.get(slot) || "-";
      slotToReq.set(slot, { requestId, operator, dispatchBlock: d.blockNumber });
    }

    // Operator → OracleRequest (decode jobId/callback target)
    for (const log of rcpt.logs) {
      if (log.topics[0] !== topicOracleRequest) continue;

      // Try ABI parse first
      let parsed = null;
      try { parsed = operatorIface.parseLog(log); } catch {}

      let specId, requester, requestId, payment, cbAddr, cbFuncId;
      if (parsed) {
        specId   = lc(parsed.args.specId);
        requester= lc(parsed.args.requester);
        requestId= lc(parsed.args.requestId);
        payment  = parsed.args.payment; // unused
        cbAddr   = lc(parsed.args.callbackAddr);
        cbFuncId = lc(ethers.hexlify(parsed.args.callbackFunctionId));
      } else {
        // Manual fallback: topics[1] is specId; data encodes the rest
        if (log.topics.length >= 2) specId = lc(log.topics[1]);
        try {
          const [reqr, rid, pay, cba, cbf/*bytes4*/, cancelExp, dataVer, dataBytes] =
            decodeOracleRequestData(log.data);
          requester= lc(reqr);
          requestId= lc(rid);
          payment  = pay;
          cbAddr   = lc(cba);
          cbFuncId = lc(ethers.hexlify(cbf));
        } catch {
          continue; // give up on this log
        }
      }

      // Only keep entries that belong to this aggId
      const parent = (await agg.requestIdToAggregatorId(requestId)).toLowerCase();
      if (parent !== aggId) continue;

      const slot = Number(await agg.requestIdToPollIndex(requestId));
      perSlotCb.set(slot, {
        jobId: specId || "-",
        cbAddr: cbAddr || "-",
        cbFuncId: cbFuncId || "-"
      });
    }
  }

  console.log("RequestIds (slot -> requestId @ operator):");
  if (slotToReq.size === 0) {
    console.log("  (none recovered; check if ChainlinkRequested is emitted in your build)");
  } else {
    [...slotToReq.entries()].sort((a,b)=>a[0]-b[0]).forEach(([slot, x]) =>
      console.log(`  ${slot}: ${x.requestId} @ ${x.operator}`)
    );
  }

  // ── Failure-guard events ───────────────────────────────────────────────────
  const failureFilter = {
    address: AGG_ADDR,
    topics: [[topicHashMismatch, topicInvalidFmt, topicTooMany, topicWrongCount, topicTooFew], aggId],
    fromBlock, toBlock: "latest"
  };
  const failureLogs = await provider.getLogs(failureFilter);
  const perSlotFailures = new Map();
  for (const l of failureLogs) {
    const p = agg.interface.parseLog(l);
    const s = Number(p.args.pollIndex);
    const name = p.name;
    const arr = perSlotFailures.get(s) || [];
    arr.push(name);
    perSlotFailures.set(s, arr);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const firstDisp   = Math.min(...dispatches.map(d => d.blockNumber));
  const lastDisp    = Math.max(...dispatches.map(d => d.blockNumber));
  const searchStart = Math.max(0, firstDisp - 600);
  const searchEnd   = lastDisp + argv.lookahead;

  async function aggregatorFulfilled(requestIdLower, aroundBlock) {
    const from = aroundBlock ? Math.max(0, aroundBlock - 6) : searchStart;
    const to   = aroundBlock ? aroundBlock + 6 : searchEnd;
    try {
      const logs = await provider.getLogs({
        address: AGG_ADDR,
        topics: [TOPIC_CL_FULFILLED, requestIdLower],
        fromBlock: from,
        toBlock: to
      });
      return logs.length > 0;
    } catch { return false; }
  }

  async function getOperatorResponseTx(operator, requestIdLower) {
    if (!operator || operator === "-") return null;
    try {
      const logs = await provider.getLogs({
        address: operator,
        topics: [topicOracleResponse, requestIdLower],
        fromBlock: searchStart,
        toBlock: searchEnd
      });
      if (logs.length === 0) return null;
      const log = logs[0];
      const rcpt = await provider.getTransactionReceipt(log.transactionHash);
      const tx   = await provider.getTransaction(log.transactionHash);
      return {
        hash: tx.hash,
        from: lc(tx.from),
        to: lc(tx.to),
        data: lc(tx.data || "0x"),
        nonce: tx.nonce,
        status: rcpt.status,
        block: rcpt.blockNumber
      };
    } catch { return null; }
  }

  async function getRevertReason(txHash) {
    try {
      const tx = await provider.getTransaction(txHash);
      await provider.call(
        { to: tx.to, from: tx.from, data: tx.data, value: tx.value },
        tx.blockNumber
      );
      return "";
    } catch (e) {
      const hex = e?.data || e?.error?.data || "";
      const dataHex = typeof hex === "string" ? hex : "";
      if (dataHex && dataHex.startsWith("0x")) {
        const selector = dataHex.slice(0, 10);
        const coder = ethers.AbiCoder.defaultAbiCoder();
        if (selector === "0x08c379a0" && dataHex.length >= 10 + 64 * 2) {
          try {
            const [reason] = coder.decode(["string"], "0x" + dataHex.slice(10));
            return String(reason);
          } catch {}
        }
        if (selector === "0x4e487b71" && dataHex.length >= 10 + 64 * 2) {
          try {
            const [code] = coder.decode(["uint256"], "0x" + dataHex.slice(10));
            return `panic code ${code}`;
          } catch {}
        }
        return `revert data ${dataHex.slice(0, 74)}…`;
      }
      return e?.message || "reverted (no reason)";
    }
  }

  function diagnose(rec, clFul, opTx, reason, cbOkAddr, cbOkFunc) {
    if (rec) return "OK";
    if (cbOkAddr === false || cbOkFunc === false)
      return `callback target mismatch${cbOkAddr === false ? " (addr)" : ""}${cbOkFunc === false ? " (funcId)" : ""}`;
    if (!opTx) return "operator did not emit OracleResponse";
    if (opTx.status === 0) return `fulfill reverted${reason ? " – " + reason : ""}`;
    if (!clFul) return "operator tx mined but aggregator did not emit ChainlinkFulfilled (callback may have reverted in another contract)";
    return "-";
  }

  function tagEOA(addrLc) {
    if (!addrLc) return "-";
    const chk = ethers.getAddress(addrLc);
    const inSet = EXPECTED_LC.has(addrLc);
    return inSet ? `${chk} (expected)` : `${chk} (UNEXPECTED)`;
  }

  // ── Print table ────────────────────────────────────────────────────────────
  console.log(`\nAggregator fulfill selector (expected by job): ${AGG_FULFILL_SELECTOR}\n`);

  console.log("Per-slot status:");
  console.log(
    pad("slot", 4),
    pad("operator", 42),
    pad("requestId", 66),
    pad("dispBlk", 8),
    pad("jobId(specId)", 22),
    pad("cbAddrOK", 8),
    pad("cbFuncOK", 8),
    pad("aggRecorded", 12),
    pad("clFulfilled", 12),
    pad("opTx(hash…)", 20),
    pad("block", 8),
    pad("lag", 5),
    pad("from (expected?)", 49),
    pad("nonce", 6),
    pad("status", 6),
    pad("op.sig", 10),
    pad("diagnosis / notes", 52)
  );

  for (const slot of dispatchedSlots) {
    const info     = slotToReq.get(slot);
    const rec      = recordedBySlot.get(slot);
    const operator = (info?.operator) || slotToOperator.get(slot) || "-";
    const dispBlk  = info?.dispatchBlock ?? dispatches.find(d => d.slot === slot)?.blockNumber ?? "-";

    const cb = perSlotCb.get(slot) || { jobId: "-", cbAddr: "-", cbFuncId: "-" };
    const cbAddrOK = cb.cbAddr === "-" ? null : (cb.cbAddr === AGG_ADDR_LC);
    const cbFuncOK = cb.cbFuncId === "-" ? null : (cb.cbFuncId === lc(AGG_FULFILL_SELECTOR));

    let clFul = "-";
    let opTx  = null;
    let reason = "";
    let notes  = perSlotFailures.get(slot)?.join(",") || "";

    if (info) {
      opTx  = await getOperatorResponseTx(operator, info.requestId);
      if (opTx) clFul = (await aggregatorFulfilled(info.requestId, opTx.block)) ? "yes" : "no";
      else      clFul = (await aggregatorFulfilled(info.requestId, null)) ? "yes" : "no";
      if (opTx && opTx.status === 0) reason = await getRevertReason(opTx.hash);
    }

    const recYes = !!rec;
    const diag   = diagnose(recYes, clFul === "yes", opTx, reason, cbAddrOK === false ? false : cbAddrOK, cbFuncOK === false ? false : cbFuncOK);
    const sig    = opTx?.data ? opTx.data.slice(0, 10) : "-";
    const lag    = (opTx && typeof dispBlk === "number") ? (opTx.block - dispBlk) : "-";

    const cbAddrMark = cbAddrOK == null ? "-" : (cbAddrOK ? "yes" : "NO");
    const cbFuncMark = cbFuncOK == null ? "-" : (cbFuncOK ? "yes" : "NO");

    console.log(
      pad(slot, 4),
      pad(operator, 42),
      pad(info ? info.requestId : "-", 66),
      pad(dispBlk, 8),
      pad(cb.jobId, 22),
      pad(cbAddrMark, 8),
      pad(cbFuncMark, 8),
      pad(recYes ? "yes" : "no", 12),
      pad(clFul, 12),
      pad(opTx ? (opTx.hash.slice(0,18) + "…") : "-", 20),
      pad(opTx ? opTx.block : "-", 8),
      pad(lag, 5),
      pad(opTx ? tagEOA(opTx.from) : "-", 49),
      pad(opTx ? opTx.nonce : "-", 6),
      pad(opTx ? opTx.status : "-", 6),
      pad(sig, 10),
      pad((notes ? notes + " | " : "") + diag, 52)
    );
  }

  // ── Outcome ────────────────────────────────────────────────────────────────
  const failed = (await provider.getLogs({
    address: AGG_ADDR,
    topics: [topicEvalFailed, aggId],
    fromBlock, toBlock: "latest"
  })).length > 0;

  const success = (await provider.getLogs({
    address: AGG_ADDR,
    topics: [topicFulfilledAgg, aggId],
    fromBlock, toBlock: "latest"
  })).length > 0;

  const timedOut = (await provider.getLogs({
    address: AGG_ADDR,
    topics: [topicTimedOut, aggId],
    fromBlock, toBlock: "latest"
  })).length > 0;

  console.log("\nOutcome:",
    success ? "COMPLETED" :
    timedOut ? "FAILED/TIMED OUT" :
    failed ? "FAILED" : "UNKNOWN (still running?)"
  );
})();

