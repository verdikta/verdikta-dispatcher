#!/usr/bin/env node
/*  scripts/arbiter-noise.js
    -------------------------------------------------------------------------------------------
    Per-response NOISE of arbiter scores, measured from past queries: the standard deviation of
    the scores different arbiters gave to the SAME query in the SAME round.

    WHY THIS MEASURES NOISE
      While every arbiter runs the same code (same models, prompts, settings), there is no
      persistent per-arbiter lean (sigma_between ~ 0 in selection_randomness_risk.py). The arbiters
      revealing in one round then score identical input under identical code, so the spread among
      them is run-to-run noise alone, i.e. sigma_within. The "same code" premise is CHECKED, not
      assumed: analyze tests whether any arbiter sits consistently above or below the others.

    WHERE THE SCORES COME FROM (3 to 4 per query)
      Each round sends reveal requests to the first M=4 committers; the aggregator finalizes on
      the N=3rd valid reveal. A 4th reveal that arrives later is REJECTED by the aggregator
      (AggregationComplete), but the arbiter's operator transaction still succeeds (the callback
      failure is caught and emitted as OracleCallbackResult(success=false)), so its scores are
      on-chain in the operator calldata. This script recovers all of them:
        1. aggregator ChainlinkRequested(id) is paired with the RevealRequestDispatched(aggId, slot)
           that follows it in the same transaction  -> reveal requestId -> (round, slot)
        2. operator OracleResponse(requestId) -> the fulfill transaction
        3. calldata fulfillOracleRequestV / fulfillOracleRequest2 -> (requestId, scores, "cid:salt")
        4. verified against the arbiter's commit: bytes16(sha256(abi.encode(operator, scores, salt)))
           must equal CommitReceived.commitHash for that slot, exactly as the aggregator checks.
           A late 4th reveal is therefore as trustworthy as a counted one. Mismatches are excluded.

    METRIC
      Scores are converted to shares of 100: s_c = 100 * v_c / sum(v). For each round with n >= 2
      verified reveals: var_r = mean over outcomes c of the sample variance of s_c across the n
      reveals. For two-outcome queries both outcomes give the same variance, so this is simply
      the variance of the "accept" share. The pooled noise is
          sigma = sqrt( sum_r (n_r - 1) var_r / sum_r (n_r - 1) ),
      which is the per-response standard deviation (sigma_within). Reported overall, per period
      (day/week/month), per class, per number of reveals, and per score level (noise near 0 or
      100 is compressed by the bounds).

    USAGE
      HARDHAT_NETWORK=base node scripts/arbiter-noise.js collect \
          --aggregator 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a --from-block 47087827 \
          --out noise-data.json
      node scripts/arbiter-noise.js analyze --data noise-data.json --period week \
          --nominal 80 --threshold 90 --json-out arbiter-noise.json --csv-out arbiter-noise-weekly.csv
      (--json-out is shaped for the analytics page: overall, series[], byClass, byLevel, arbiters[])

    PASS RATE FOR ONE DECISION (--nominal N --threshold T [--band 5] [--attempt-cost-usd 0.59])
      Uses the rounds whose center (median, and separately mean) of outcome --outcome-index is
      within +/- band of N. Each round's actual spread is shifted to center on N, clipped to
      0..100, and run through the aggregator's rule (closest pair among 3 reveals; every 3-of-4
      subset weighted equally) to give P(final >= T): the honest pass rate for a submission whose
      arbiters typically answer N, measured WITHOUT assuming normal noise. Also reported:
        - a 95% Wilson interval (treating the rounds as the sample size),
        - the normal sd that reproduces that pass rate (use as --sigma-within in the risk model),
        - the re-submission bound: max safe value = cost per attempt / P(pass).
      Median centering is recommended: disagreements are mostly one low (or high) outlier, which
      the closest-pair rule discards, so a round's mean misstates where its cluster lands.

    CAVEATS
      - If arbiters do NOT all run the same code, the within-round spread is noise PLUS lean
        (sqrt(sigma_within^2 + sigma_between^2)); the arbiter-consistency check flags this.
      - Only reveals that reached the chain are seen. Arbiters that never reveal add nothing.
      - Rounds whose request precedes --from-block are skipped (their slots are unknown).
   ------------------------------------------------------------------------------------------- */
require("dotenv").config();
const fs = require("fs");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const {
  lc, jsonSafe, pMap, withRetry, getLogsChunked, makeTimestamper, resolveRange,
  OPERATOR_IFACE, decodeOperatorFulfill, parseCidSalt, revealCommitHash,
  mean, variance, quantile, fmt,
} = require("./lib/chain-stats-utils");

/* ───────────────────────────── collect ───────────────────────────── */
async function collect(argv) {
  const hre = require("hardhat");
  const { ethers } = hre;
  const provider = ethers.provider;
  const aggAbi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const keeperAbi = (await hre.artifacts.readArtifact("ReputationKeeper")).abi;
  const agg = new ethers.Contract(argv.aggregator, aggAbi, provider);
  const aggAddr = lc(argv.aggregator);

  const { from, to } = await resolveRange(provider,
    { fromBlock: argv["from-block"], toBlock: argv["to-block"], days: argv.days });
  const timeout = Number(await agg.responseTimeoutSeconds());
  const T = await makeTimestamper(provider, from, to);
  const tail = Math.ceil((timeout + 60) / T.blockTime); // late reveals can land after `to`
  const latest = await provider.getBlockNumber();
  const toResp = Math.min(latest, to + tail);
  console.log(`blocks ${from}..${to} (responses to ${toResp}), block time ${T.blockTime}s`);

  // ---- aggregator logs ----
  const names = ["RequestAIEvaluation", "OracleSelected", "CommitReceived", "RevealRequestDispatched",
    "NewOracleResponseRecorded", "ChainlinkRequested", "FulfillAIEvaluation"];
  const topics = names.map((n) => agg.interface.getEvent(n).topicHash);
  const logs = await getLogsChunked(provider, { address: argv.aggregator, topics: [topics] }, from, toResp,
    argv.chunk, "aggregator");
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  console.log(`${logs.length} aggregator logs`);

  const rounds = new Map();
  const R = (id) => {
    id = lc(id);
    if (!rounds.has(id)) rounds.set(id, { aggId: id, selected: [], commits: {}, revealReqs: [] });
    return rounds.get(id);
  };
  const revealReq = new Map(); // requestId -> {aggId, slot}
  const counted = new Set();   // requestIds the aggregator accepted
  let pendingTx = null, pendingIds = [];
  for (const log of logs) {
    const ev = agg.interface.parseLog(log);
    if (!ev) continue;
    if (log.transactionHash !== pendingTx) { pendingTx = log.transactionHash; pendingIds = []; }
    const a = ev.args;
    switch (ev.name) {
      case "ChainlinkRequested":
        pendingIds.push(lc(a.id));
        break;
      case "RevealRequestDispatched": {
        // dispatchOracleRequest emits ChainlinkRequested, then the aggregator emits
        // RevealRequestDispatched for the same slot: pair with the latest unpaired id.
        const rid = pendingIds.pop();
        if (rid) {
          revealReq.set(rid, { aggId: lc(a.aggRequestId), slot: Number(a.pollIndex) });
          R(a.aggRequestId).revealReqs.push({ slot: Number(a.pollIndex), requestId: rid });
        }
        break;
      }
      case "RequestAIEvaluation":
        Object.assign(R(a.aggRequestId), { cids: [...a.cids], reqBlock: log.blockNumber });
        break;
      case "OracleSelected":
        R(a.aggRequestId).selected.push({ slot: Number(a.pollIndex), oracle: lc(a.oracle), jobId: lc(a.jobId) });
        break;
      case "CommitReceived":
        R(a.aggRequestId).commits[Number(a.pollIndex)] = lc(a.commitHash);
        break;
      case "NewOracleResponseRecorded":
        counted.add(lc(a.requestId));
        break;
      case "FulfillAIEvaluation":
        R(a.aggRequestId).finalized = true;
        break;
    }
  }
  console.log(`${revealReq.size} reveal requests in ${[...rounds.values()].filter((r) => r.revealReqs.length).length} rounds`);

  // ---- operator OracleResponse logs -> fulfill tx per reveal requestId ----
  const operators = [...new Set([...rounds.values()].flatMap((r) => r.selected.map((s) => s.oracle)))];
  const respTopic = OPERATOR_IFACE.getEvent("OracleResponse").topicHash;
  const respTx = new Map();
  for (let i = 0; i < operators.length; i += 20) {
    const part = operators.slice(i, i + 20);
    const rl = await getLogsChunked(provider, { address: part, topics: [respTopic] }, from, toResp, argv.chunk, "operators");
    for (const l of rl) {
      const rid = lc(l.topics[1]);
      if (revealReq.has(rid)) respTx.set(rid, { tx: l.transactionHash, block: l.blockNumber, operator: lc(l.address) });
    }
  }
  console.log(`${respTx.size} of ${revealReq.size} reveal requests answered on-chain (${operators.length} operators)`);

  // ---- decode + verify each answered reveal ----
  const reveals = new Map(); // aggId -> []
  let ok = 0, bad = 0, undec = 0;
  await pMap([...respTx.entries()], async ([rid, r]) => {
    const { aggId, slot } = revealReq.get(rid);
    const rec = { slot, requestId: rid, operator: r.operator, block: r.block, counted: counted.has(rid) };
    try {
      const tx = await withRetry(() => provider.getTransaction(r.tx));
      const dec = decodeOperatorFulfill(tx.data);
      if (dec.requestId !== rid) throw new Error("requestId mismatch");
      if (dec.callback !== aggAddr) throw new Error("callback is not this aggregator");
      rec.scores = dec.scores;
      const cs = parseCidSalt(dec.cid);
      const commit = rounds.get(aggId).commits[slot];
      if (!cs) rec.hashOk = false;
      else if (!commit) rec.hashOk = null;
      else rec.hashOk = revealCommitHash(r.operator, dec.scores, cs.salt) === commit;
      rec.hashOk === false ? bad++ : ok++;
    } catch (e) {
      rec.decodeError = String(e.shortMessage || e.message).slice(0, 120);
      undec++;
    }
    if (!reveals.has(aggId)) reveals.set(aggId, []);
    reveals.get(aggId).push(rec);
  }, argv.concurrency);
  console.log(`reveals: ${ok} verified/unchecked, ${bad} failed the commit check, ${undec} undecodable`);

  // ---- classes from the keeper registry (round class = class shared by all polled arbiters) ----
  const classesOf = new Map();
  try {
    const keeper = new ethers.Contract(await agg.reputationKeeper(), keeperAbi, provider);
    const n = Number(await keeper.getRegisteredOraclesCount());
    await pMap([...Array(n).keys()], async (i) => {
      const id = await withRetry(() => keeper.registeredOracles(i));
      const cls = await withRetry(() => keeper.getOracleClasses(i));
      classesOf.set(`${lc(id.oracle)}:${lc(id.jobId)}`, cls.map((c) => c.toString()));
    }, argv.concurrency);
  } catch (e) {
    console.log(`(registry read failed, classes unknown: ${e.shortMessage || e.message})`);
  }

  const out = [];
  for (const r of rounds.values()) {
    if (r.reqBlock == null || !r.revealReqs.length) continue;
    const sets = r.selected.map((s) => classesOf.get(`${s.oracle}:${s.jobId}`)).filter(Boolean);
    const shared = sets.length ? sets.reduce((acc, s) => acc.filter((c) => s.includes(c))) : [];
    const rv = (reveals.get(r.aggId) || []).sort((a, b) => a.block - b.block);
    for (const v of rv) v.ts = await T.ts(v.block);
    out.push({
      aggId: r.aggId, reqBlock: r.reqBlock, reqTs: await T.ts(r.reqBlock), cids: r.cids,
      class: shared.length === 1 ? shared[0] : shared.length ? shared.join("|") : null,
      finalized: !!r.finalized, revealRequests: r.revealReqs.length,
      selected: r.selected, reveals: rv,
    });
  }
  fs.writeFileSync(argv.out, jsonSafe({
    meta: { network: hre.network.name, aggregator: argv.aggregator, fromBlock: from, toBlock: to,
      blockTime: T.blockTime, collectedAt: new Date().toISOString() },
    rounds: out,
  }));
  console.log(`wrote ${out.length} rounds to ${argv.out}`);
}

/* ───────────────────────────── analyze ───────────────────────────── */
function periodKey(ts, unit) {
  const d = new Date(ts * 1000);
  if (unit === "month") return d.toISOString().slice(0, 7);
  if (unit === "week") {
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/** Pooled per-response sd over a set of rounds: sqrt(sum (n-1) var / sum (n-1)). */
function pooled(rs) {
  let ss = 0, dof = 0;
  for (const r of rs) { ss += (r.n - 1) * r.var; dof += r.n - 1; }
  const sds = rs.map((r) => Math.sqrt(r.var));
  return {
    rounds: rs.length, reveals: rs.reduce((a, r) => a + r.n, 0), dof,
    pooledSd: dof ? Math.sqrt(ss / dof) : NaN,
    medianRoundSd: quantile(sds, 0.5), p90RoundSd: quantile(sds, 0.9),
    identicalFrac: rs.length ? rs.filter((r) => r.var === 0).length / rs.length : NaN,
  };
}

function analyze(argv) {
  const data = JSON.parse(fs.readFileSync(argv.data, "utf8"));
  const include = (v) => v.scores && (v.hashOk === true || (v.hashOk === null && argv["include-unchecked"]));
  const per = [];
  let dropped = 0, failedHash = 0;
  for (const r of data.rounds) {
    failedHash += r.reveals.filter((v) => v.hashOk === false).length;
    let vs = r.reveals.filter(include).map((v) => ({ ...v, vec: v.scores.map(Number) }));
    vs = vs.filter((v) => v.vec.length >= 2 && v.vec.reduce((a, b) => a + b, 0) > 0);
    if (!vs.length) continue;
    // modal vector length (the aggregator's Minimal-C normalization); drop off-length reveals
    const lens = {};
    for (const v of vs) lens[v.vec.length] = (lens[v.vec.length] || 0) + 1;
    const L = Number(Object.entries(lens).sort((a, b) => b[1] - a[1])[0][0]);
    dropped += vs.filter((v) => v.vec.length !== L).length;
    vs = vs.filter((v) => v.vec.length === L);
    if (vs.length < 2) continue;
    const shares = vs.map((v) => { const s = v.vec.reduce((a, b) => a + b, 0); return v.vec.map((x) => (100 * x) / s); });
    const comp = [...Array(L).keys()].map((c) => shares.map((s) => s[c]));
    const vr = mean(comp.map(variance));
    const idx = Math.min(argv["outcome-index"], L - 1);
    per.push({
      aggId: r.aggId, ts: r.reqTs, class: r.class ?? "unknown", n: vs.length, L, var: vr,
      level: mean(comp[idx]), shares: comp[idx],
      // arbiter identity = (operator, jobId) of the slot; one operator contract can host several jobs
      arbiters: vs.map((v) => {
        const s = r.selected.find((x) => x.slot === v.slot);
        return s ? `${s.oracle}:${s.jobId}` : v.operator;
      }),
      countedOnly: (() => {
        const c = vs.map((v, i) => (v.counted ? shares[i] : null)).filter(Boolean);
        return c.length >= 2 ? { n: c.length, var: mean([...Array(L).keys()].map((k) => variance(c.map((s) => s[k])))) } : null;
      })(),
    });
  }

  const overall = pooled(per);
  const counted = pooled(per.map((r) => r.countedOnly).filter(Boolean));
  console.log(`\n${data.meta.network} aggregator ${data.meta.aggregator}, blocks ${data.meta.fromBlock}..${data.meta.toBlock}`);
  console.log(`${per.length} rounds with >= 2 verified reveals (${overall.reveals} reveals); ` +
    `${failedHash} reveals failed the commit check (excluded); ${dropped} off-length reveals dropped`);
  console.log("\nPER-RESPONSE NOISE  (sd of score shares, points on 0..100, same query same round)");
  const row = (name, p) => console.log(`  ${name.padEnd(24)} sd ${fmt(p.pooledSd).padStart(6)}   rounds ${String(p.rounds).padStart(5)}  ` +
    `reveals ${String(p.reveals).padStart(5)}  median round sd ${fmt(p.medianRoundSd).padStart(6)}  ` +
    `p90 ${fmt(p.p90RoundSd).padStart(6)}  identical ${fmt(100 * p.identicalFrac, 1)}%`);
  row("all verified reveals", overall);
  row("counted reveals only", counted);
  for (const n of [...new Set(per.map((r) => r.n))].sort()) row(`rounds with ${n} reveals`, pooled(per.filter((r) => r.n === n)));

  // ---- noise distribution shape: standardized within-round residuals vs a normal ----
  const z = [];
  for (const r of per) {
    const m = mean(r.shares);
    for (const s of r.shares) z.push((s - m) / Math.sqrt(((r.n - 1) / r.n) * overall.pooledSd ** 2 || 1));
  }
  const tail = (k) => z.filter((x) => Math.abs(x) > k).length / (z.length || 1);
  // Residuals in score points, rescaled by sqrt(n/(n-1)) so each has the per-response variance.
  const e = [];
  for (const r of per) { const m = mean(r.shares); for (const s of r.shares) e.push(Math.abs(s - m) * Math.sqrt(r.n / (r.n - 1))); }
  const robustSd = 1.4826 * quantile(e, 0.5);
  const absQ = { p50: quantile(e, 0.5), p75: quantile(e, 0.75), p90: quantile(e, 0.9), p95: quantile(e, 0.95), p99: quantile(e, 0.99) };
  const disagree = per.filter((r) => Math.sqrt(r.var) > argv["disagree-sd"]).length / (per.length || 1);
  console.log(`\nSHAPE  (standardized residuals; a normal gives |z|>1: 31.7%, >2: 4.6%, >3: 0.27%)`);
  console.log(`  |z|>1: ${fmt(100 * tail(1), 1)}%   |z|>2: ${fmt(100 * tail(2), 1)}%   |z|>3: ${fmt(100 * tail(3), 2)}%` +
    `   exact ties within a round: ${fmt(100 * overall.identicalFrac, 1)}% of rounds`);
  console.log(`  |deviation| from round mean (points): p50 ${fmt(absQ.p50)}  p75 ${fmt(absQ.p75)}  p90 ${fmt(absQ.p90)}  ` +
    `p95 ${fmt(absQ.p95)}  p99 ${fmt(absQ.p99)}`);
  console.log(`  robust sd (1.4826 x median |dev|) ${fmt(robustSd)} vs pooled sd ${fmt(overall.pooledSd)}` +
    `   rounds with round sd > ${argv["disagree-sd"]}: ${fmt(100 * disagree, 1)}%`);
  if (overall.pooledSd > 1.5 * robustSd)
    console.log("  -> heavy tails: most rounds agree closely and a minority disagree strongly; a single normal sd misdescribes this.");

  // ---- by period / class / level ----
  const groupBy = (keyFn) => {
    const m = new Map();
    for (const r of per) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, rs]) => ({ key: k, ...pooled(rs) }));
  };
  const series = groupBy((r) => periodKey(r.ts, argv.period));
  console.log(`\nBY ${argv.period.toUpperCase()}`);
  for (const p of series) row(p.key, p);
  const byClass = groupBy((r) => String(r.class));
  console.log("\nBY CLASS");
  for (const p of byClass) row(`class ${p.key}`, p);
  const bins = [[0, 10], [10, 30], [30, 70], [70, 90], [90, 100.0001]];
  const byLevel = bins.map(([lo, hi]) => ({ key: `${lo}-${Math.round(hi)}`, ...pooled(per.filter((r) => r.level >= lo && r.level < hi)) }));
  console.log(`\nBY SCORE LEVEL  (round-mean share of outcome ${argv["outcome-index"]}; noise is compressed near 0 and 100)`);
  for (const p of byLevel) row(`mean ${p.key}`, p);

  // ---- "same code" check: does any arbiter sit consistently off its peers? ----
  // Leave-one-out deviation d = s_j - mean(others); with no lean E[d] = 0 and
  // var(d) = sigma^2 * n / (n - 1).
  const sig2 = overall.pooledSd ** 2;
  const dev = new Map();
  for (const r of per) {
    const tot = r.shares.reduce((a, b) => a + b, 0);
    r.shares.forEach((s, i) => {
      const d = s - (tot - s) / (r.n - 1);
      const k = r.arbiters[i];
      if (!dev.has(k)) dev.set(k, { sum: 0, k: 0, v: 0 });
      const e = dev.get(k); e.sum += d; e.k += 1; e.v += (sig2 * r.n) / (r.n - 1);
    });
  }
  const arbiters = [...dev.entries()].map(([id, e]) => ({
    arbiter: id, reveals: e.k, meanDeviation: e.sum / e.k, meanDeviationVar: e.v / e.k ** 2,
    z: e.sum / Math.sqrt(e.v || 1),
  })).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const eligible = arbiters.filter((a) => a.reveals >= argv["min-obs"]);
  const impliedLean2 = eligible.length >= 3
    ? Math.max(0, variance(eligible.map((a) => a.meanDeviation)) - mean(eligible.map((a) => a.meanDeviationVar)))
    : NaN;
  const flagged = eligible.filter((a) => Math.abs(a.z) > argv["z-flag"]);
  console.log(`\nSAME-CODE CHECK  (${eligible.length} arbiters with >= ${argv["min-obs"]} reveals)`);
  console.log(`  implied lean sd across arbiters: ${fmt(Math.sqrt(impliedLean2))} points` +
    `   (~0 if all arbiters behave alike; compare to noise sd ${fmt(overall.pooledSd)})`);
  console.log(`  arbiters off their peers by more than ${argv["z-flag"]} sd-of-mean: ${flagged.length}` +
    `   (expected by chance: ~${fmt(eligible.length * 2 * (1 - normCdf(argv["z-flag"])), 1)})`);
  for (const a of arbiters.slice(0, argv.top))
    console.log(`    ${a.arbiter.length > 60 ? a.arbiter.slice(0, 42) + "…" + a.arbiter.slice(-12) : a.arbiter}  reveals ${String(a.reveals).padStart(4)}  mean deviation ${fmt(a.meanDeviation).padStart(6)}  z ${fmt(a.z).padStart(6)}`);

  // ---- empirical pass rate at a chosen nominal / threshold (--nominal, --threshold) ----
  let passRate = null;
  if (argv.nominal != null && argv.threshold != null) {
    passRate = passRateAt(per, argv);
    const pr = passRate;
    console.log(`\nPASS RATE AT NOMINAL ${pr.nominal}, THRESHOLD ${pr.threshold}  (outcome ${argv["outcome-index"]}; ` +
      `rounds whose center is within +/-${pr.band} of the nominal; closest pair of ${pr.reveals}; ` +
      `$${fmt(pr.attemptCostUsd)} per attempt)`);
    console.log(`  ${"center".padEnd(8)} ${"rounds".padStart(6)} ${"P(pass)".padStart(8)} ${"95% CI".padStart(15)} ` +
      `${"band pooled sd".padStart(14)} ${"normal-sd equivalent".padStart(20)} ${"max safe V (re-submit)".padStart(22)}`);
    for (const c of [pr.median, pr.mean]) {
      console.log(`  ${c.center.padEnd(8)} ${String(c.rounds).padStart(6)} ${(fmt(100 * c.p, 1) + "%").padStart(8)} ` +
        `${(fmt(100 * c.ciLo, 1) + "-" + fmt(100 * c.ciHi, 1) + "%").padStart(15)} ${fmt(c.bandPooledSd).padStart(14)} ` +
        `${fmt(c.normalSdEquivalent).padStart(20)} ${("$" + fmt(c.maxSafeValueUsd, 0)).padStart(22)}`);
    }
    console.log("  median = nominal is the arbiters' typical answer (recommended: the closest-pair cluster follows the");
    console.log("           majority and discards outliers); mean = nominal is their average answer.");
    console.log("  normal-sd equivalent = the sigma_within at which normal noise reproduces this pass rate under the");
    console.log("           aggregator's closest-pair rule; use it as --sigma-within with --true/--threshold below.");
  }

  console.log("\nFOR selection_randomness_risk.py");
  if (passRate && Number.isFinite(passRate.median.normalSdEquivalent)) {
    console.log(`  --true ${passRate.nominal} --threshold ${passRate.threshold} ` +
      `--sigma-within ${fmt(passRate.median.normalSdEquivalent)}` +
      (Number.isFinite(impliedLean2) ? ` --sigma-between ${fmt(Math.sqrt(impliedLean2))}` : "") +
      "   (calibrated to the empirical pass rate, median centering)");
  } else {
    console.log(`  --sigma-within ${fmt(overall.pooledSd)} (pooled; robust core ${fmt(robustSd)})` +
      (Number.isFinite(impliedLean2) ? `   --sigma-between ${fmt(Math.sqrt(impliedLean2))}` : "") +
      "   (pass --nominal/--threshold for a value calibrated to your decision)");
  }

  const result = {
    generatedAt: new Date().toISOString(),
    source: { network: data.meta.network, aggregator: data.meta.aggregator, fromBlock: data.meta.fromBlock, toBlock: data.meta.toBlock },
    method: "pooled within-round sd of score shares (0..100) across verified reveals of the same query; see scripts/arbiter-noise.js",
    overall: { ...overall, countedOnly: counted, failedCommitCheck: failedHash },
    shape: { absZgt1: tail(1), absZgt2: tail(2), absZgt3: tail(3), robustSd, absDeviationQuantiles: absQ,
      disagreeSd: argv["disagree-sd"], disagreeRoundFrac: disagree },
    period: argv.period, series, byClass, byLevel,
    sameCode: { impliedLeanSd: Math.sqrt(impliedLean2), flagged: flagged.length, zFlag: argv["z-flag"] },
    passRate,
    arbiters,
    rounds: per.map((r) => ({ aggId: r.aggId, ts: r.ts, class: r.class, n: r.n, level: r.level, sd: Math.sqrt(r.var) })),
  };
  if (argv["json-out"]) { fs.writeFileSync(argv["json-out"], jsonSafe(result)); console.log(`\nwrote ${argv["json-out"]}`); }
  if (argv["csv-out"]) {
    const lines = ["period,rounds,reveals,pooled_sd,median_round_sd,p90_round_sd,identical_frac",
      ...series.map((p) => [p.key, p.rounds, p.reveals, p.pooledSd, p.medianRoundSd, p.p90RoundSd, p.identicalFrac]
        .map((x) => (typeof x === "number" ? +x.toFixed(4) : x)).join(","))];
    fs.writeFileSync(argv["csv-out"], lines.join("\n") + "\n");
    console.log(`wrote ${argv["csv-out"]}`);
  }
}

/* ---- pass-rate helpers (aggregator rule: closest pair among the first N=3 reveals) ---- */
function closestPairMean(x) {
  let best = Infinity, m = NaN;
  for (let i = 0; i < x.length - 1; i++)
    for (let j = i + 1; j < x.length; j++) {
      const d = (x[i] - x[j]) ** 2;
      if (d < best) { best = d; m = (x[i] + x[j]) / 2; }
    }
  return m;
}

function subsets(arr, k) {
  if (k >= arr.length) return [arr];
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) { out.push(acc); return; }
    for (let i = start; i < arr.length; i++) rec(i + 1, [...acc, arr[i]]);
  };
  rec(0, []);
  return out;
}

/** P(final >= threshold) for one round's actual spread re-centered on `nominal`. Every N-subset of
 *  the round's reveals is treated as an equally likely "first N" (arrival order is not used). */
function roundPassProb(shares, center, nominal, threshold, scale, N) {
  const x = shares.map((s) => Math.min(100, Math.max(0, nominal + (s - center) * scale)));
  const subs = subsets(x, Math.min(N, x.length));
  return subs.filter((c) => closestPairMean(c) >= threshold).length / subs.length;
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same rule with N independent normal(nominal, sd) answers (the risk model's assumption).
 *  A fixed seed makes the curve deterministic, so the bisection below is stable. */
function normalPassProb(sd, nominal, threshold, N, trials = 100000, seed = 7) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let ok = 0;
  for (let t = 0; t < trials; t++) {
    const x = Array.from({ length: N }, () => Math.min(100, Math.max(0, nominal + sd * gauss())));
    if (closestPairMean(x) >= threshold) ok++;
  }
  return ok / trials;
}

/** Normal sd that reproduces pass probability p (bisection on a monotone curve). */
function calibrateNormalSd(p, nominal, threshold, N) {
  if (!(p > 0 && p < 1)) return NaN;
  let lo = 0.01, hi = 60;
  const rising = normalPassProb(hi, nominal, threshold, N) > normalPassProb(lo, nominal, threshold, N);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const above = normalPassProb(mid, nominal, threshold, N) > p;
    if (above === rising) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function wilson(p, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

function passRateAt(per, argv) {
  const N = 3;
  const { nominal, threshold, band } = argv;
  const cost = argv["attempt-cost-usd"];
  const one = (center) => {
    const cfn = center === "median" ? (s) => quantile(s, 0.5) : mean;
    const rs = per.filter((r) => r.n >= 2 && Math.abs(cfn(r.shares) - nominal) <= band);
    // mean-centered residuals are shrunk by (n-1)/n in variance; rescale to the per-response spread
    const ps = rs.map((r) => roundPassProb(r.shares, cfn(r.shares), nominal, threshold,
      center === "mean" ? Math.sqrt(r.n / (r.n - 1)) : 1, N));
    const p = mean(ps);
    const [ciLo, ciHi] = wilson(p, rs.length);
    let ss = 0, dof = 0;
    for (const r of rs) { ss += (r.n - 1) * variance(r.shares); dof += r.n - 1; }
    return {
      center, rounds: rs.length, p, ciLo, ciHi, bandPooledSd: dof ? Math.sqrt(ss / dof) : NaN,
      normalSdEquivalent: rs.length ? calibrateNormalSd(p, nominal, threshold, N) : NaN,
      maxSafeValueUsd: p > 0 ? cost / p : Infinity,
    };
  };
  return { nominal, threshold, band, reveals: N, attemptCostUsd: cost, median: one("median"), mean: one("mean") };
}

function normCdf(x) { // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/* ───────────────────────────── CLI ───────────────────────────── */
yargs(hideBin(process.argv))
  .command("collect", "scan aggregator + operator history and recover every reveal", (y) => y
    .option("aggregator", { type: "string", demandOption: true })
    .option("from-block", { type: "number" })
    .option("to-block", { type: "number" })
    .option("days", { type: "number", default: 30, desc: "lookback if --from-block is not given" })
    .option("chunk", { type: "number", default: 10000, desc: "initial getLogs block span" })
    .option("concurrency", { type: "number", default: 6 })
    .option("out", { type: "string", default: "noise-data.json" }),
  (a) => collect(a).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }))
  .command("analyze", "pooled within-round noise, overall and over time", (y) => y
    .option("data", { type: "string", demandOption: true })
    .option("period", { choices: ["day", "week", "month"], default: "week" })
    .option("outcome-index", { type: "number", default: 1, desc: "outcome used for the score-level breakdown" })
    .option("include-unchecked", { type: "boolean", default: false, desc: "keep reveals whose commit was not seen" })
    .option("min-obs", { type: "number", default: 10, desc: "min reveals for the same-code check" })
    .option("z-flag", { type: "number", default: 3 })
    .option("disagree-sd", { type: "number", default: 5, desc: "round sd (points) counted as a disagreement" })
    .option("nominal", { type: "number", desc: "nominal score of the decision (0..100, outcome --outcome-index)" })
    .option("threshold", { type: "number", desc: "pass threshold of the decision (final >= threshold passes)" })
    .option("band", { type: "number", default: 5, desc: "use rounds whose center is within +/- band of --nominal" })
    .option("attempt-cost-usd", { type: "number", default: 0.59,
      desc: "submitter cost per attempt. Default measured on Base mainnet 2026-11-03: 6 x 0.00002 ETH base " +
        "+ 2 x 0.00006 ETH bonus + ~0.00002 ETH request gas, at $2,287/ETH (see selection_randomness_risk.py N6)" })
    .option("top", { type: "number", default: 10 })
    .option("json-out", { type: "string" })
    .option("csv-out", { type: "string" }),
  (a) => analyze(a))
  .demandCommand(1)
  .strict()
  .parse();
