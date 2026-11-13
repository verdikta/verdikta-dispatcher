#!/usr/bin/env node
/*  scripts/arbiter-stats.js
    -------------------------------------------------------------------------------------------
    Gather the arbiter statistics that selection_randomness_risk.py needs, from the chain.

    WHAT IT MEASURES (and the Params field each one sets)
      Score model, per assumption B in selection_randomness_risk.py:
          score(arbiter j, submission s, round r) = mu_s + b_j + g_js + e_jsr
            mu_s   nominal value of submission s (honest-population mean)  -> --true for that submission
            b_j    persistent lean of arbiter j (same on every submission) -> sigma_between
            g_js   arbiter x submission interaction (lean that varies by submission)
            e_jsr  run-to-run noise on a repeated identical request          -> sigma_within
        Error predicting j's lean on a new submission from its history       -> sigma_estimate
        g_js and e_jsr can only be separated when the SAME arbiter scored the SAME submission
        more than once. Historical traffic rarely has that; the `poll` command creates it.
      Race / latency (assumption E):
          commit delay (request -> CommitReceived)        -> honest_commit_median_s, honest_latency_sigma
          reveal delay (reveal dispatch -> reveal)        -> honest_reveal_median_s
          slots that never commit / reveal                -> honest_no_show_prob
      Pool and protocol (assumption D, contract config):
          eligible arbiters for the class, selection-weight range -> eligible_oracles, min/max_score_for_selection
          K, M, N, P, bonus, timeout, shortlist, median fee       -> k_commit_poll ... oracle_fee_eth
          block time                                              -> block_time_s

    WHERE THE DATA COMES FROM
      Aggregator events: RequestAIEvaluation, OracleSelected, CommitReceived, CommitPhaseComplete,
      NewOracleResponseRecorded, FulfillAIEvaluation, EvaluationTimedOut, EvaluationFailed.
      Reveal SCORES are not in any event: they are decoded from the arbiter's operator transaction
      (ArbiterOperator.fulfillOracleRequestV -> data = abi(bytes32 requestId, uint256[] scores,
      string cid)), the same way reveal-forensics.js does it.
      Registry: ReputationKeeper.registeredOracles / getOracleInfo / getOracleClasses.

    COMMANDS
      1) collect  - scan a block range and save raw rounds + registry snapshot to a JSON file
         HARDHAT_NETWORK=base node scripts/arbiter-stats.js collect \
             --aggregator 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a --days 30 --out arbiter-data.json

      2) poll     - submit the same evaluation(s) repeatedly so arbiters score identical inputs
                    several times (needed to separate noise from interaction). SPENDS ETH:
                    each request escrows maxTotalFee; the requester is charged the base fee of
                    every polled arbiter plus bonuses, and the remainder is credited back
                    (ethOwed, reused by later requests via fund-from-credit; withdraw with
                    withdrawEth). Dry-run unless --yes.
         HARDHAT_NETWORK=base node scripts/arbiter-stats.js poll \
             --aggregator 0xd8F3... --cid QmA... --cid QmB... --rounds 20 --class 128 --yes
         Then run `collect` over the blocks covering the poll (it prints the range).

      3) analyze  - fit the model and print recommendations; --params-out writes JSON that
                    selection_randomness_risk.py loads with --params-json.
         node scripts/arbiter-stats.js analyze --data arbiter-data.json --class 128 \
             --outcome-index 1 --params-out arbiter-params.json [--only-poll poll.json]
         python3 scripts/selection_randomness_risk.py --params-json arbiter-params.json \
             --true <mu of the submission you care about> --threshold <its threshold>

    CAVEATS (also printed by analyze)
      - Only valid reveals that landed BEFORE finalization are on-chain (later ones revert), so
        reveal data favors fast arbiters and reveal latency is right-censored (biased low).
        Commit latency is censored the same way once a round completes.
      - Any colluding / faulty arbiters in the data are treated as honest and inflate the spreads.
      - The score is taken as 100 * v[outcome-index] / sum(v). BountyEscrow's "accept" is index 1.
      - Leans are identified relative to the arbiter-average; with few observations per arbiter
        sigma_between is noisy. analyze reports how many observations back each estimate.
   ------------------------------------------------------------------------------------------- */
require("dotenv").config();
const fs = require("fs");
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const {
  sleep, lc, jsonSafe, pMap, withRetry, getLogsChunked, makeTimestamper, resolveRange,
  decodeOperatorFulfill, mean, variance, quantile, fmt: f,
} = require("./lib/chain-stats-utils");

/* ───────────────────────────── collect ───────────────────────────── */
async function collect(argv) {
  const provider = ethers.provider;
  const aggAbi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const keeperAbi = (await hre.artifacts.readArtifact("ReputationKeeper")).abi;
  const agg = new ethers.Contract(argv.aggregator, aggAbi, provider);

  // ---- aggregator config ----
  const cfg = {};
  for (const [k, fn] of Object.entries({
    k: "commitOraclesToPoll", m: "oraclesToPoll", n: "requiredResponses", p: "clusterSize",
    bonus: "bonusMultiplier", timeout: "responseTimeoutSeconds", maxOracleFee: "maxOracleFee",
    keeper: "reputationKeeper",
  })) {
    try { cfg[k] = (await agg[fn]()).toString(); } catch { cfg[k] = null; }
  }
  console.log("aggregator config:", cfg);

  // ---- keeper registry snapshot ----
  const registry = [];
  const keeperCfg = {};
  if (cfg.keeper) {
    const keeper = new ethers.Contract(cfg.keeper, keeperAbi, provider);
    for (const fn of ["minScoreForSelection", "maxScoreForSelection", "shortlistSize"]) {
      try { keeperCfg[fn] = (await keeper[fn]()).toString(); } catch { keeperCfg[fn] = null; }
    }
    const count = Number(await keeper.getRegisteredOraclesCount());
    console.log(`keeper ${cfg.keeper}: ${count} registered arbiter identities`);
    const rows = await pMap([...Array(count).keys()], async (i) => withRetry(async () => {
      const id = await keeper.registeredOracles(i);
      const classes = (await keeper.getOracleClasses(i)).map((c) => c.toString());
      const info = await keeper.getOracleInfo(id.oracle, id.jobId);
      return {
        oracle: id.oracle, jobId: id.jobId, classes,
        active: info.isActive, quality: info.qualityScore.toString(), timeliness: info.timelinessScore.toString(),
        callCount: info.callCount.toString(), fee: info.fee.toString(), blocked: info.blocked,
        lockedUntil: info.lockedUntil.toString(),
      };
    }), argv.concurrency);
    registry.push(...rows);
  }

  // ---- block range ----
  const { from, to } = await resolveRange(provider,
    { fromBlock: argv["from-block"], toBlock: argv["to-block"], days: argv.days });
  const T = await makeTimestamper(provider, from, to);
  console.log(`scanning blocks ${from}..${to} (block time ${T.blockTime}s${T.exact ? ", exact" : ""})`);

  // ---- logs ----
  const names = ["RequestAIEvaluation", "OracleSelected", "CommitReceived", "CommitPhaseComplete",
    "NewOracleResponseRecorded", "FulfillAIEvaluation", "EvaluationTimedOut", "EvaluationFailed"];
  const topics = names.map((n) => agg.interface.getEvent(n).topicHash);
  const raw = await getLogsChunked(provider, { address: argv.aggregator, topics: [topics] }, from, to, argv.chunk);
  console.log(`${raw.length} aggregator logs`);

  const rounds = new Map();
  const R = (id) => {
    id = lc(id);
    if (!rounds.has(id)) rounds.set(id, { aggId: id, selected: [], commits: [], reveals: [] });
    return rounds.get(id);
  };
  const revealJobs = [];
  for (const log of raw) {
    const ev = agg.interface.parseLog(log);
    if (!ev) continue;
    const a = ev.args, blk = log.blockNumber;
    switch (ev.name) {
      case "RequestAIEvaluation":
        Object.assign(R(a.aggRequestId), { cids: [...a.cids], reqBlock: blk, reqTx: log.transactionHash });
        break;
      case "OracleSelected":
        R(a.aggRequestId).selected.push({ slot: Number(a.pollIndex), oracle: a.oracle, jobId: a.jobId });
        break;
      case "CommitReceived":
        R(a.aggRequestId).commits.push({ slot: Number(a.pollIndex), operator: a.operator, block: blk });
        break;
      case "CommitPhaseComplete":
        R(a.aggRequestId).commitPhaseBlock = blk;
        break;
      case "NewOracleResponseRecorded": {
        const rv = { slot: Number(a.pollIndex), operator: a.operator, requestId: a.requestId, block: blk, tx: log.transactionHash };
        R(a.aggRequestId).reveals.push(rv);
        revealJobs.push(rv);
        break;
      }
      case "FulfillAIEvaluation":
        R(a.aggRequestId).fulfilled = { block: blk, aggregated: a.aggregated.map((x) => x.toString()) };
        break;
      case "EvaluationTimedOut":
        R(a.aggRequestId).timedOut = true;
        break;
      case "EvaluationFailed":
        R(a.aggRequestId).failedPhase = a.phase;
        break;
    }
  }

  // ---- decode reveal scores from the operator transactions ----
  let decoded = 0;
  await pMap(revealJobs, async (rv) => {
    try {
      const tx = await withRetry(() => provider.getTransaction(rv.tx));
      const dec = decodeOperatorFulfill(tx.data);
      if (dec.requestId === lc(rv.requestId)) { rv.scores = dec.scores; decoded++; }
      else rv.decodeError = "requestId mismatch";
    } catch (e) {
      rv.decodeError = String(e.shortMessage || e.message).slice(0, 120);
    }
  }, argv.concurrency);
  console.log(`decoded ${decoded}/${revealJobs.length} reveal score vectors`);

  // ---- timestamps; keep only rounds whose request is inside the range ----
  const out = [];
  for (const r of rounds.values()) {
    if (r.reqBlock == null) continue;
    r.reqTs = await T.ts(r.reqBlock);
    for (const c of r.commits) c.ts = await T.ts(c.block);
    for (const v of r.reveals) v.ts = await T.ts(v.block);
    if (r.commitPhaseBlock != null) r.commitPhaseTs = await T.ts(r.commitPhaseBlock);
    if (r.fulfilled) r.fulfilled.ts = await T.ts(r.fulfilled.block);
    out.push(r);
  }
  const data = {
    meta: { network: hre.network.name, aggregator: argv.aggregator, fromBlock: from, toBlock: to,
      blockTime: T.blockTime, collectedAt: new Date().toISOString() },
    config: { ...cfg, ...keeperCfg },
    registry,
    rounds: out,
  };
  fs.writeFileSync(argv.out, jsonSafe(data));
  console.log(`wrote ${out.length} rounds to ${argv.out}`);
}

/* ───────────────────────────── poll ───────────────────────────── */
async function poll(argv) {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("no signer configured for this network");
  const abi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const agg = new ethers.Contract(argv.aggregator, abi, signer);
  const cids = [].concat(argv.cid);
  const maxFee = ethers.parseEther(String(argv["max-fee"]));
  const required = await agg.maxTotalFee(maxFee);
  const total = cids.length * argv.rounds;
  const K = Number(await agg.commitOraclesToPoll());
  console.log(`signer ${signer.address}`);
  console.log(`${total} requests (${argv.rounds} rounds x ${cids.length} CIDs), class ${argv.class}, alpha ${argv.alpha}`);
  console.log(`escrow per request ${ethers.formatEther(required)} ETH; worst-case spend ` +
    `${ethers.formatEther(required * BigInt(total))} ETH; typical spend ~K x fee + bonus per request ` +
    `(K=${K}), the rest returns as ethOwed credit.`);
  if (!argv.yes) { console.log("dry run: add --yes to submit"); return; }

  const log = { aggregator: argv.aggregator, network: hre.network.name, cids, params: {
    class: argv.class, alpha: argv.alpha, maxFeeEth: argv["max-fee"], baseCostWei: argv["base-cost"], scaling: argv.scaling,
  }, requests: [] };
  const save = () => fs.writeFileSync(argv.out, jsonSafe(log));
  for (let r = 0; r < argv.rounds; r++) {
    for (const cid of cids) {
      const credit = await agg.ethOwed(signer.address);
      const value = required - (credit < required ? credit : required);
      const args = [[cid], argv.addendum, argv.alpha, maxFee, BigInt(argv["base-cost"]), argv.scaling, argv.class];
      let gasLimit;
      try { gasLimit = ((await agg.requestAIEvaluationWithApproval.estimateGas(...args, { value })) * 150n) / 100n; }
      catch { gasLimit = 6_000_000n; }
      const tx = await agg.requestAIEvaluationWithApproval(...args, { value, gasLimit });
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => { try { return agg.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "RequestAIEvaluation");
      const aggId = ev ? ev.args.aggRequestId : null;
      log.requests.push({ round: r, cid, aggId, tx: tx.hash, block: rcpt.blockNumber });
      save();
      console.log(`round ${r + 1}/${argv.rounds} ${cid.slice(0, 12)}... aggId ${aggId} block ${rcpt.blockNumber}`);
      await sleep(argv["interval-s"] * 1000);
    }
  }
  const blocks = log.requests.map((q) => q.block);
  console.log(`done. Wait > ${Number(await agg.responseTimeoutSeconds())}s, then:\n  node scripts/arbiter-stats.js collect ` +
    `--aggregator ${argv.aggregator} --from-block ${Math.min(...blocks)} --to-block <current> --out poll-data.json`);
}

/* ───────────────────────────── analyze ───────────────────────────── */
function fitLognormal(xs) {
  const l = xs.filter((x) => x > 0).map(Math.log);
  return { n: l.length, median: Math.exp(mean(l)), sigma: Math.sqrt(variance(l)) };
}

function analyze(argv) {
  const data = JSON.parse(fs.readFileSync(argv.data, "utf8"));
  let rounds = data.rounds;
  if (argv["only-poll"]) {
    const ids = new Set([].concat(argv["only-poll"]).flatMap((p) => JSON.parse(fs.readFileSync(p, "utf8")).requests.map((q) => lc(q.aggId))));
    rounds = rounds.filter((r) => ids.has(lc(r.aggId)));
  }
  const cfg = data.config;
  const idx = argv["outcome-index"];
  const blockTime = data.meta.blockTime || 2;
  const notes = [];
  console.log(`\n${rounds.length} rounds from ${data.meta.network} blocks ${data.meta.fromBlock}..${data.meta.toBlock}`);

  // ---------- observations ----------
  const obs = []; // {j, s, y}
  let skipped = 0;
  for (const r of rounds) {
    const s = (r.cids || []).join(",");
    const bySlot = new Map(r.selected.map((x) => [x.slot, `${lc(x.oracle)}:${lc(x.jobId)}`]));
    for (const v of r.reveals) {
      if (!v.scores) { skipped++; continue; }
      const vec = v.scores.map(Number);
      const sum = vec.reduce((a, b) => a + b, 0);
      if (vec.length <= idx || sum <= 0) { skipped++; continue; }
      obs.push({ j: bySlot.get(v.slot) || lc(v.operator), s, y: (100 * vec[idx]) / sum });
    }
  }
  if (skipped) notes.push(`${skipped} reveals skipped (undecoded or vector too short for --outcome-index ${idx})`);
  const J = [...new Set(obs.map((o) => o.j))], S = [...new Set(obs.map((o) => o.s))];
  console.log(`${obs.length} scored reveals, ${J.length} arbiters, ${S.length} distinct submissions`);

  // ---------- additive fit: y = mu_s + b_j + resid  (b centered: arbiter-average lean = 0) ----------
  const mu = Object.fromEntries(S.map((s) => [s, 0]));
  const b = Object.fromEntries(J.map((j) => [j, 0]));
  for (let it = 0; it < 100; it++) {
    const ms = {}, ns = {};
    for (const o of obs) { ms[o.s] = (ms[o.s] || 0) + o.y - b[o.j]; ns[o.s] = (ns[o.s] || 0) + 1; }
    for (const s of S) mu[s] = ms[s] / ns[s];
    const mj = {}, nj = {};
    for (const o of obs) { mj[o.j] = (mj[o.j] || 0) + o.y - mu[o.s]; nj[o.j] = (nj[o.j] || 0) + 1; }
    for (const j of J) b[j] = mj[j] / nj[j];
    const c = mean(J.map((j) => b[j]));
    for (const j of J) b[j] -= c;
    for (const s of S) mu[s] += c;
  }
  const nJ = {}, nS = {};
  for (const o of obs) { nJ[o.j] = (nJ[o.j] || 0) + 1; nS[o.s] = (nS[o.s] || 0) + 1; }
  const sse = obs.reduce((a, o) => a + (o.y - mu[o.s] - b[o.j]) ** 2, 0);
  const dof = obs.length - S.length - J.length + 1;
  const sResid2 = dof > 0 ? sse / dof : NaN;

  // ---------- replicate noise (same arbiter, same submission, repeated) ----------
  const cells = new Map();
  for (const o of obs) {
    const k = `${o.j}|${o.s}`;
    if (!cells.has(k)) cells.set(k, { j: o.j, s: o.s, ys: [] });
    cells.get(k).ys.push(o.y);
  }
  let repSS = 0, repDof = 0;
  for (const c of cells.values()) {
    if (c.ys.length < 2) continue;
    const m = mean(c.ys);
    repSS += c.ys.reduce((a, y) => a + (y - m) ** 2, 0);
    repDof += c.ys.length - 1;
  }
  const sRep2 = repDof > 0 ? repSS / repDof : NaN;

  // ---------- interaction (lean that changes by submission), needs replicates ----------
  // E[sum of squared cell-mean residuals] ~= sInt2 * (cells - S - J + 1) + sRep2 * sum(1/n_cell):
  // the additive fit absorbs part of the interaction, so divide by the remaining dof, not by #cells.
  let sInt2 = NaN;
  const cellDof = cells.size - S.length - J.length + 1;
  if (repDof > 0 && cellDof > 0) {
    let ss = 0, inv = 0;
    for (const c of cells.values()) {
      ss += (mean(c.ys) - mu[c.s] - b[c.j]) ** 2;
      inv += 1 / c.ys.length;
    }
    sInt2 = Math.max(0, (ss - sRep2 * inv) / cellDof);
  }
  // Sampling error of b_hat_j as an estimate of the persistent lean b_j: b_hat_j averages the
  // interaction over j's cells (weights n_cell / n_j) and the noise over its n_j reveals. Without
  // replicates the two cannot be split, so the residual variance stands in for both.
  const cellsOf = {};
  for (const c of cells.values()) (cellsOf[c.j] = cellsOf[c.j] || []).push(c.ys.length);
  const seB2 = (j) => Number.isFinite(sInt2)
    ? sInt2 * cellsOf[j].reduce((a, n) => a + (n / nJ[j]) ** 2, 0) + sRep2 / nJ[j]
    : sResid2 / nJ[j];

  // ---------- between-arbiter lean spread ----------
  const minObs = argv["min-obs"];
  const Jw = J.filter((j) => nJ[j] >= minObs);
  const sBetween2 = Jw.length >= 3
    ? Math.max(0, variance(Jw.map((j) => b[j])) - mean(Jw.map(seB2)))
    : NaN;
  if (Jw.length < 3) notes.push(`fewer than 3 arbiters with >= ${minObs} reveals: sigma_between not estimable`);

  // ---------- recommendations for the risk model ----------
  const haveRep = repDof >= argv["min-rep-dof"];
  const sigmaWithin = haveRep ? Math.sqrt(sRep2) : Math.sqrt(sResid2);
  const sigmaInt2 = haveRep && Number.isFinite(sInt2) ? sInt2 : 0;
  const sigmaBetween = Math.sqrt((Number.isFinite(sBetween2) ? sBetween2 : NaN) + sigmaInt2);
  const typicalSe2 = quantile(Jw.map(seB2), 0.5);
  const sigmaEstimate = Math.sqrt(sigmaInt2 + (Number.isFinite(typicalSe2) ? typicalSe2 : NaN));
  if (!haveRep) notes.push(`only ${repDof} replicate degrees of freedom (< ${argv["min-rep-dof"]}): sigma_within uses the ` +
    `additive-model residual, which also contains the arbiter x submission interaction. Run 'poll' to separate them.`);

  console.log("\nSCORE MODEL  (score = 100 * v[outcome] / sum(v); points on 0..100)");
  console.log(`  residual sd (noise + interaction)      ${f(Math.sqrt(sResid2))}   dof ${dof}`);
  console.log(`  replicate sd (pure run-to-run noise)    ${f(Math.sqrt(sRep2))}   dof ${repDof}`);
  console.log(`  interaction sd (lean varies by subm.)   ${f(Math.sqrt(sInt2))}`);
  console.log(`  persistent lean sd                      ${f(Math.sqrt(sBetween2))}   from ${Jw.length} arbiters with >= ${minObs} reveals`);

  console.log("\nSUBMISSIONS  (mu = nominal value -> use as --true when analysing that submission)");
  for (const s of [...S].sort((x, y) => nS[y] - nS[x]).slice(0, argv.top)) {
    console.log(`  mu ${f(mu[s], 1).padStart(6)}   n ${String(nS[s]).padStart(4)}   ${s.length > 70 ? s.slice(0, 67) + "..." : s}`);
  }
  console.log("\nARBITERS  (lean b_j relative to arbiter average; se = error vs the persistent lean)");
  for (const j of [...J].sort((x, y) => b[y] - b[x]).slice(0, argv.top)) {
    console.log(`  lean ${f(b[j], 1).padStart(6)}  se ${f(Math.sqrt(seB2(j)), 1).padStart(5)}  n ${String(nJ[j]).padStart(4)}  ${j}`);
  }

  // ---------- latency and no-shows ----------
  const commitD = [], revealD = [];
  let polledTO = 0, committedTO = 0, revReqTO = 0, revealedTO = 0, polledAll = 0, committedAll = 0;
  for (const r of rounds) {
    const committed = new Set(r.commits.map((c) => c.slot));
    for (const c of r.commits) commitD.push(Math.max(c.ts - r.reqTs, blockTime / 2));
    if (r.commitPhaseTs != null) for (const v of r.reveals) revealD.push(Math.max(v.ts - r.commitPhaseTs, blockTime / 2));
    polledAll += r.selected.length;
    committedAll += r.selected.filter((x) => committed.has(x.slot)).length;
    if (r.timedOut && r.failedPhase === "commit") {
      polledTO += r.selected.length;
      committedTO += r.selected.filter((x) => committed.has(x.slot)).length;
    }
    if (r.timedOut && r.failedPhase === "reveal") {
      const revealed = new Set(r.reveals.map((v) => v.slot));
      const asked = r.commits.filter((c) => r.commitPhaseTs == null || c.ts <= r.commitPhaseTs).map((c) => c.slot);
      revReqTO += asked.length;
      revealedTO += asked.filter((s) => revealed.has(s)).length;
    }
  }
  const cfit = fitLognormal(commitD), rfit = fitLognormal(revealD);
  const noShowCommitTO = polledTO ? 1 - committedTO / polledTO : NaN;
  const noShowRevealTO = revReqTO ? 1 - revealedTO / revReqTO : NaN;
  const noShowUpper = polledAll ? 1 - committedAll / polledAll : NaN;
  const noShow = Number.isFinite(noShowCommitTO) && polledTO >= 30 ? noShowCommitTO : noShowUpper;
  const outcomes = {
    finalized: rounds.filter((r) => r.fulfilled).length,
    commitTimeout: rounds.filter((r) => r.failedPhase === "commit").length,
    revealTimeout: rounds.filter((r) => r.failedPhase === "reveal").length,
  };
  console.log("\nRACE");
  console.log(`  rounds: ${outcomes.finalized} finalized, ${outcomes.commitTimeout} commit timeouts, ${outcomes.revealTimeout} reveal timeouts`);
  console.log(`  commit delay: median ${f(cfit.median, 1)}s, log-sd ${f(cfit.sigma)}  (n ${cfit.n}; censored once a round completes)`);
  console.log(`  reveal delay: median ${f(rfit.median, 1)}s, log-sd ${f(rfit.sigma)}  (n ${rfit.n}; only pre-finalize reveals, biased low)`);
  console.log(`  no-show: commit ${f(100 * noShowCommitTO, 1)}% in ${polledTO} slots of commit-timeout rounds; ` +
    `reveal ${f(100 * noShowRevealTO, 1)}% in reveal-timeout rounds; uncommitted overall ${f(100 * noShowUpper, 1)}% (upper bound)`);

  // ---------- pool / selection weights ----------
  const now = Math.floor(Date.now() / 1000);
  const minS = Number(cfg.minScoreForSelection ?? 60), maxS = Number(cfg.maxScoreForSelection ?? 6000);
  const feeCap = argv["max-fee"] != null ? ethers.parseEther(String(argv["max-fee"])) : BigInt(cfg.maxOracleFee ?? 0);
  const elig = data.registry.filter((o) => o.active && !(o.blocked && Number(o.lockedUntil) > now) &&
    BigInt(o.fee) <= feeCap && o.classes.includes(String(argv.class)));
  const alpha = argv.alpha;
  const weights = elig.map((o) => Math.min(maxS, Math.max(minS,
    ((1000 - alpha) * Number(o.quality) + alpha * Number(o.timeliness)) / 1000)));
  const fees = elig.map((o) => Number(ethers.formatEther(o.fee)));
  console.log(`\nPOOL  class ${argv.class}, alpha ${alpha}, fee <= ${ethers.formatEther(feeCap)} ETH`);
  console.log(`  eligible arbiters ${elig.length} of ${data.registry.length} registered`);
  console.log(`  selection weight min ${f(Math.min(...weights), 0)} p10 ${f(quantile(weights, 0.1), 0)} median ` +
    `${f(quantile(weights, 0.5), 0)} p90 ${f(quantile(weights, 0.9), 0)} max ${f(Math.max(...weights), 0)} (clamp ${minS}..${maxS})`);
  console.log(`  fee median ${f(quantile(fees, 0.5), 6)} ETH`);
  if (weights.length && quantile(weights, 0.9) - quantile(weights, 0.1) < 0.2 * (Math.max(...weights) - Math.min(...weights)))
    notes.push("selection weights are concentrated; the risk model's uniform [min,max] weight draw is a poor fit");

  // ---------- params for selection_randomness_risk.py ----------
  const params = {
    sigma_within: sigmaWithin, sigma_between: sigmaBetween, sigma_estimate: sigmaEstimate,
    eligible_oracles: elig.length,
    min_score_for_selection: weights.length ? Math.min(...weights) : undefined,
    max_score_for_selection: weights.length ? Math.max(...weights) : undefined,
    k_commit_poll: Number(cfg.k), m_reveal: Number(cfg.m), n_required: Number(cfg.n), p_cluster: Number(cfg.p),
    bonus_multiplier: Number(cfg.bonus), response_timeout_s: Number(cfg.timeout),
    shortlist_size: cfg.shortlistSize != null ? Number(cfg.shortlistSize) : undefined,
    oracle_fee_eth: fees.length ? quantile(fees, 0.5) : undefined,
    block_time_s: blockTime,
    honest_commit_median_s: cfit.median, honest_reveal_median_s: rfit.median,
    honest_latency_sigma: cfit.sigma, honest_no_show_prob: noShow,
  };
  for (const k of Object.keys(params)) if (params[k] === undefined || !Number.isFinite(params[k])) delete params[k];

  console.log("\nRECOMMENDED Params (selection_randomness_risk.py)");
  for (const [k, v] of Object.entries(params)) console.log(`  ${k.padEnd(26)} ${typeof v === "number" ? +v.toFixed(6) : v}`);
  console.log("  sigma_between here = sqrt(persistent lean^2 + interaction^2): the lean that applies to ONE submission.");
  console.log("  sigma_estimate     = sqrt(interaction^2 + typical se^2): error predicting that lean from history.");
  console.log("  Set --true from the SUBMISSIONS table (mu) and --threshold from the integration; they are per decision.");
  if (notes.length) { console.log("\nNOTES"); for (const n of notes) console.log(`  - ${n}`); }

  if (argv["params-out"]) {
    fs.writeFileSync(argv["params-out"], jsonSafe({
      params,
      _source: { data: argv.data, network: data.meta.network, blocks: [data.meta.fromBlock, data.meta.toBlock],
        rounds: rounds.length, reveals: obs.length, arbiters: J.length, submissions: S.length,
        class: argv.class, alpha, outcomeIndex: idx },
      _submissions: Object.fromEntries(S.map((s) => [s, { mu: mu[s], n: nS[s] }])),
      _components: { residual_sd: Math.sqrt(sResid2), replicate_sd: Math.sqrt(sRep2), interaction_sd: Math.sqrt(sInt2),
        persistent_lean_sd: Math.sqrt(sBetween2), replicate_dof: repDof, outcomes },
      _notes: notes,
    }));
    console.log(`\nwrote ${argv["params-out"]}`);
  }
}

/* ───────────────────────────── CLI ───────────────────────────── */
yargs(hideBin(process.argv))
  .command("collect", "scan aggregator history into a JSON file", (y) => y
    .option("aggregator", { type: "string", demandOption: true })
    .option("from-block", { type: "number" })
    .option("to-block", { type: "number" })
    .option("days", { type: "number", default: 30, desc: "lookback if --from-block is not given" })
    .option("chunk", { type: "number", default: 5000, desc: "initial getLogs block span" })
    .option("concurrency", { type: "number", default: 6 })
    .option("out", { type: "string", default: "arbiter-data.json" }),
  (a) => collect(a).catch((e) => { console.error(e); process.exit(1); }))
  .command("poll", "submit repeated identical evaluations (spends ETH)", (y) => y
    .option("aggregator", { type: "string", demandOption: true })
    .option("cid", { type: "string", demandOption: true, desc: "evaluation CID; repeat for several submissions" })
    .option("rounds", { type: "number", default: 10, desc: "requests per CID" })
    .option("class", { type: "number", default: 128 })
    .option("alpha", { type: "number", default: 500 })
    .option("max-fee", { type: "string", default: "0.00015", desc: "per-arbiter fee ceiling, ETH" })
    .option("base-cost", { type: "string", default: "8000000000", desc: "estimated base cost, wei" })
    .option("scaling", { type: "number", default: 5 })
    .option("addendum", { type: "string", default: "" })
    .option("interval-s", { type: "number", default: 10, desc: "pause between requests" })
    .option("out", { type: "string", default: "poll.json" })
    .option("yes", { type: "boolean", default: false, desc: "actually submit (otherwise dry run)" }),
  (a) => poll(a).catch((e) => { console.error(e); process.exit(1); }))
  .command("analyze", "fit the score / latency model and print recommended Params", (y) => y
    .option("data", { type: "string", demandOption: true })
    .option("only-poll", { type: "string", desc: "restrict to aggIds in this poll.json (repeatable)" })
    .option("class", { type: "number", default: 128 })
    .option("alpha", { type: "number", default: 500 })
    .option("max-fee", { type: "string", desc: "fee ceiling for eligibility, ETH (default: aggregator maxOracleFee)" })
    .option("outcome-index", { type: "number", default: 1, desc: "index of the 'accept' entry in the score vector" })
    .option("min-obs", { type: "number", default: 3, desc: "min reveals for an arbiter to enter sigma_between" })
    .option("min-rep-dof", { type: "number", default: 10, desc: "replicate dof needed to trust replicate sd" })
    .option("top", { type: "number", default: 15, desc: "rows to print per table" })
    .option("params-out", { type: "string" }),
  (a) => analyze(a))
  .demandCommand(1)
  .strict()
  .parse();
