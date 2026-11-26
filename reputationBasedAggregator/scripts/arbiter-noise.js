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

    WHERE THE SCORES COME FROM (v2 aggregator: M promoted reveals per query)
      Each round promotes M of its committers to reveal; the aggregator finalizes on the N-th valid
      reveal and still accepts later reveals until the deadline (RevealReceived late=true, classified
      but not counted). A reveal that arrives after the deadline, or that the aggregator ignores for
      any other reason, still left its scores in the operator's calldata. This script recovers all
      of them:
        1. BasePayment(aggId, slot) marks dispatched slots and CommitPhaseComplete promoted rounds;
           getSlot(aggId, slot) gives each slot's operator, keeper key, flags and stored commit;
        2. the reveal request id is computed, not looked up (scripts/lib/v2-reveal.js):
           keccak256(abi.encodePacked(aggregator, ((roundId << 8 | slot) << 1) | 1));
        3. operator OracleResponse(requestId) -> the fulfill transaction;
           calldata fulfillOracleRequestV / fulfillOracleRequest2 -> (requestId, scores, "cid:salt");
        4. verified as the aggregator verifies a reveal (score count, cid:salt format, and the commit
           keccak256(abi.encode(aggId, operator, scores, salt)) == getSlot(...).commitHash), so a
           late or past-deadline reveal is as trustworthy as a counted one. Failures are excluded.
      Data files written by the v1 version of this script (meta.version absent) still analyze.

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
          --aggregator <v2 ReputationAggregator> --from-block <its deploy block> \
          --out noise-data.json
      node scripts/arbiter-noise.js analyze --data noise-data.json --period week \
          --nominal 80 --threshold 90 --json-out arbiter-noise.json --csv-out arbiter-noise-weekly.csv
      (--json-out is shaped for the analytics page: overall, series[], byClass, byLevel, arbiters[])

    PASS RATE FOR ONE DECISION (--nominal N --threshold T [--band 5] [--attempt-cost-usd 0.59])
      Uses the rounds whose center (median, and separately mean) of outcome --outcome-index is
      within +/- band of N. Each round's actual spread is shifted to center on N, clipped to
      0..100, and run through the aggregator's rule (the cluster of P among the first N counted
      reveals, ScoringLib's 1-D rule: the P closest consecutive values; every N-subset of the
      round's reveals weighted equally; N and P default to the most common jury in the data and
      --counted/--cluster override; v1 data gives N=3, P=2, v1's closest pair) to give
      P(final >= T): the honest pass rate for a submission whose
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
      - A round's class is the class all its jurors share (the request's class is not readable);
        arbiters that completed their exit have no classes left (arbiterClasses is emptied).
   ------------------------------------------------------------------------------------------- */
const fs = require("fs");
const { ethers } = require("ethers");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const {
  lc, jsonSafe, pMap, withRetry, getLogsChunked, makeTimestamper, resolveRange,
  OPERATOR_IFACE, decodeOperatorFulfill,
  mean, variance, quantile, fmt,
} = require("./lib/chain-stats-utils");
const V2 = require("./lib/v2-reveal");

/* ───────────────────────────── collect ───────────────────────────── */
/**
 * Scan a v2 aggregator's history and recover every reveal. Returns the data object that `collect`
 * writes ({meta, rounds}). opts: { provider, aggregator, aggAbi, fromBlock, toBlock, days, chunk,
 * concurrency, network, log }.
 */
async function collectData(opts) {
  const { provider } = opts;
  const log = opts.log || console.log;
  const chunk = opts.chunk ?? 10000, conc = opts.concurrency ?? 6;
  const agg = new ethers.Contract(opts.aggregator, opts.aggAbi, provider);
  const aggAddr = lc(opts.aggregator);

  const { from, to } = await resolveRange(provider, { fromBlock: opts.fromBlock, toBlock: opts.toBlock, days: opts.days ?? 30 });
  // reveals can land after `to`: up to the longest timeout after the draw, plus the promotion's reveal window
  const tailSec = Number(await agg.maxTimeout()) + Number(await agg.revealWindow()) + 60;
  const T = await makeTimestamper(provider, from, to);
  const latest = await provider.getBlockNumber();
  const toResp = Math.min(latest, to + Math.ceil(tailSec / Math.max(T.blockTime, 1e-3)));
  log(`blocks ${from}..${to} (responses to ${toResp}), block time ${T.blockTime}s`);

  // ---- aggregator logs ----
  const names = ["RequestAIEvaluation", "BasePayment", "CommitReceived", "CommitPhaseComplete", "RevealReceived", "FulfillAIEvaluation"];
  const topics = names.map((n) => agg.interface.getEvent(n).topicHash);
  const logs = await getLogsChunked(provider, { address: opts.aggregator, topics: [topics] }, from, toResp, chunk, "aggregator");
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  log(`${logs.length} aggregator logs`);

  const rounds = new Map();
  const R = (id) => {
    id = lc(id);
    if (!rounds.has(id)) rounds.set(id, { aggId: id, dispatched: [], commits: {}, revealEv: {} });
    return rounds.get(id);
  };
  for (const l of logs) {
    const ev = agg.interface.parseLog(l);
    if (!ev) continue;
    const a = ev.args;
    switch (ev.name) {
      case "RequestAIEvaluation": Object.assign(R(a.aggRequestId), { cids: [...a.cids], reqBlock: l.blockNumber }); break;
      case "BasePayment": R(a.aggRequestId).dispatched.push(Number(a.pollIndex)); break;
      case "CommitReceived": R(a.aggRequestId).commits[Number(a.pollIndex)] = lc(a.commitHash); break;
      case "CommitPhaseComplete": R(a.aggRequestId).promoted = true; break;
      case "RevealReceived": R(a.aggRequestId).revealEv[Number(a.pollIndex)] = { late: a.late, qcode: Number(a.qcode) }; break;
      case "FulfillAIEvaluation": R(a.aggRequestId).finalized = true; break;
    }
  }
  // only rounds requested inside [from, to] (their slots and commits are all in the scan)
  const live = [...rounds.values()].filter((r) => r.reqBlock != null && r.reqBlock <= to);

  // ---- slots of promoted rounds: operator, key, flags, stored commit ----
  const pairs = live.filter((r) => r.promoted).flatMap((r) => r.dispatched.map((slot) => ({ r, slot })));
  const revealReq = new Map();   // reveal requestId -> {aggId, slot}
  await pMap(live.filter((r) => r.promoted), async (r) => {
    const j = await withRetry(() => agg.getJury(r.aggId));
    r.jury = { K: Number(j.K), M: Number(j.M), N: Number(j.N), P: Number(j.P) };
  }, conc);
  await pMap(pairs, async ({ r, slot }) => {
    const s = await withRetry(() => agg.getSlot(r.aggId, slot));
    (r.selected = r.selected || []).push({ slot, oracle: lc(s.oracle), key: lc(s.key), flags: Number(s.flags), commitHash: lc(s.commitHash) });
    if (Number(s.flags) & V2.SLOT_FLAGS.PROMOTED) {
      revealReq.set(V2.requestIdFor(opts.aggregator, V2.roundIdOf(r.aggId), slot, true), { aggId: r.aggId, slot });
    }
  }, conc);
  for (const r of live) (r.selected = r.selected || []).sort((a, b) => a.slot - b.slot);
  log(`${revealReq.size} reveal requests in ${live.filter((r) => r.promoted).length} promoted rounds`);

  // ---- operator OracleResponse logs -> fulfill tx per reveal requestId ----
  const operators = [...new Set(live.flatMap((r) => r.selected.map((s) => s.oracle)))].filter((o) => o !== lc(ethers.ZeroAddress));
  const respTopic = OPERATOR_IFACE.getEvent("OracleResponse").topicHash;
  const respTx = new Map();
  for (let i = 0; i < operators.length; i += 20) {
    const part = operators.slice(i, i + 20);
    const rl = await getLogsChunked(provider, { address: part, topics: [respTopic] }, from, toResp, chunk, "operators");
    for (const l of rl) {
      const rid = lc(l.topics[1]);
      if (revealReq.has(rid) && !respTx.has(rid)) respTx.set(rid, { tx: l.transactionHash, block: l.blockNumber, operator: lc(l.address) });
    }
  }
  log(`${respTx.size} of ${revealReq.size} reveal requests answered on-chain (${operators.length} operators)`);

  // ---- decode + verify each answered reveal ----
  const reveals = new Map();   // aggId -> []
  let ok = 0, bad = 0, undec = 0;
  await pMap([...respTx.entries()], async ([rid, r]) => {
    const { aggId, slot } = revealReq.get(rid);
    const round = rounds.get(aggId);
    const sl = round.selected.find((x) => x.slot === slot);
    const ev = round.revealEv[slot];
    const rec = {
      slot, requestId: rid, operator: r.operator, block: r.block,
      counted: !!(sl.flags & V2.SLOT_FLAGS.COUNTED), late: !!(ev && ev.late),
      accepted: !!(sl.flags & V2.SLOT_FLAGS.REVEALED),
    };
    try {
      const tx = await withRetry(() => provider.getTransaction(r.tx));
      const dec = decodeOperatorFulfill(tx.data);
      if (dec.requestId !== rid) throw new Error("requestId mismatch");
      if (dec.callback !== aggAddr) throw new Error("callback is not this aggregator");
      rec.scores = dec.scores;
      const commit = sl.commitHash && BigInt(sl.commitHash) !== 0n ? sl.commitHash : round.commits[slot];
      if (!commit) rec.hashOk = null;
      else {
        const c = V2.checkReveal({ aggId, operator: r.operator, scores: dec.scores, cid: dec.cid, commitHash: commit });
        rec.hashOk = c.ok;
        if (!c.ok) rec.rejectReason = c.reason;
      }
      rec.hashOk === false ? bad++ : ok++;
    } catch (e) {
      rec.decodeError = String(e.shortMessage || e.message).slice(0, 120);
      undec++;
    }
    if (!reveals.has(aggId)) reveals.set(aggId, []);
    reveals.get(aggId).push(rec);
  }, conc);
  log(`reveals: ${ok} verified/unchecked, ${bad} failed the reveal check, ${undec} undecodable`);

  // ---- classes from the keeper (round class = class shared by all its jurors) ----
  const classesOf = new Map();
  try {
    const keeper = new ethers.Contract(await agg.keeper(),
      ["function arbiterClasses(bytes32) view returns (uint64[])"], provider);
    const keys = [...new Set(live.flatMap((r) => r.selected.map((s) => s.key)))].filter((k) => BigInt(k) !== 0n);
    await pMap(keys, async (k) => {
      const cls = await withRetry(() => keeper.arbiterClasses(k));
      if (cls.length) classesOf.set(k, cls.map((c) => c.toString()));
    }, conc);
  } catch (e) {
    log(`(registry read failed, classes unknown: ${e.shortMessage || e.message})`);
  }

  const out = [];
  for (const r of live) {
    if (!r.promoted) continue;
    const sets = r.selected.map((s) => classesOf.get(s.key)).filter(Boolean);
    const shared = sets.length ? sets.reduce((acc, s) => acc.filter((c) => s.includes(c))) : [];
    const rv = (reveals.get(r.aggId) || []).sort((a, b) => a.block - b.block);
    for (const v of rv) v.ts = await T.ts(v.block);
    out.push({
      aggId: r.aggId, reqBlock: r.reqBlock, reqTs: await T.ts(r.reqBlock), cids: r.cids,
      class: shared.length === 1 ? shared[0] : shared.length ? shared.join("|") : null,
      jury: r.jury, finalized: !!r.finalized,
      revealRequests: r.selected.filter((s) => s.flags & V2.SLOT_FLAGS.PROMOTED).length,
      selected: r.selected.map(({ slot, oracle, key, flags }) => ({ slot, oracle, key, flags })), reveals: rv,
    });
  }
  out.sort((a, b) => a.reqBlock - b.reqBlock);
  return {
    meta: { version: 2, network: opts.network, aggregator: opts.aggregator, fromBlock: from, toBlock: to,
      blockTime: T.blockTime, collectedAt: new Date().toISOString() },
    rounds: out,
  };
}

async function collect(argv) {
  const hre = require("hardhat");
  const aggAbi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const data = await collectData({
    provider: hre.ethers.provider, aggregator: argv.aggregator, aggAbi, network: hre.network.name,
    fromBlock: argv["from-block"], toBlock: argv["to-block"], days: argv.days, chunk: argv.chunk, concurrency: argv.concurrency,
  });
  fs.writeFileSync(argv.out, jsonSafe(data));
  console.log(`wrote ${data.rounds.length} rounds to ${argv.out}`);
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

function analyze(argv, data = JSON.parse(fs.readFileSync(argv.data, "utf8")), log = console.log) {
  const console = { log };
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
      // arbiter identity = the keeper key of the slot (v2), or (operator, jobId) in v1 data; one
      // operator contract can host several jobs
      arbiters: vs.map((v) => {
        const s = r.selected.find((x) => x.slot === v.slot);
        return s ? (s.key || `${s.oracle}:${s.jobId}`) : v.operator;
      }),
      jury: r.jury,
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
      `rounds whose center is within +/-${pr.band} of the nominal; cluster of ${pr.cluster} among ${pr.reveals}; ` +
      `$${fmt(pr.attemptCostUsd)} per attempt)`);
    console.log(`  ${"center".padEnd(8)} ${"rounds".padStart(6)} ${"P(pass)".padStart(8)} ${"95% CI".padStart(15)} ` +
      `${"band pooled sd".padStart(14)} ${"normal-sd equivalent".padStart(20)} ${"max safe V (re-submit)".padStart(22)}`);
    for (const c of [pr.median, pr.mean]) {
      console.log(`  ${c.center.padEnd(8)} ${String(c.rounds).padStart(6)} ${(fmt(100 * c.p, 1) + "%").padStart(8)} ` +
        `${(fmt(100 * c.ciLo, 1) + "-" + fmt(100 * c.ciHi, 1) + "%").padStart(15)} ${fmt(c.bandPooledSd).padStart(14)} ` +
        `${fmt(c.normalSdEquivalent).padStart(20)} ${("$" + fmt(c.maxSafeValueUsd, 0)).padStart(22)}`);
    }
    console.log("  median = nominal is the arbiters' typical answer (recommended: the cluster follows the");
    console.log("           majority and discards outliers); mean = nominal is their average answer.");
    console.log("  normal-sd equivalent = the sigma_within at which normal noise reproduces this pass rate under the");
    console.log("           aggregator's cluster rule; use it as --sigma-within with --true/--threshold below.");
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
  return result;
}

/* ---- pass-rate helpers (aggregator rule: the cluster of P among the first N counted reveals) ---- */
/** ScoringLib._cluster1D: sort, then the window of P consecutive values with the smallest sum of
 *  pairwise squared differences (the first window on ties); the cluster's mean. P = 2 is v1's
 *  closest pair. */
function clusterMean(x, P = 2) {
  const s = [...x].sort((a, b) => a - b);
  P = Math.max(2, Math.min(P, s.length));
  let best = Infinity, m = NaN;
  for (let i = 0; i + P <= s.length; i++) {
    const w = s.slice(i, i + P);
    const s1 = w.reduce((a, b) => a + b, 0), s2 = w.reduce((a, b) => a + b * b, 0);
    const sc = P * s2 - s1 * s1;
    if (sc < best - 1e-9) { best = sc; m = s1 / P; }
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
function roundPassProb(shares, center, nominal, threshold, scale, N, P) {
  const x = shares.map((s) => Math.min(100, Math.max(0, nominal + (s - center) * scale)));
  const subs = subsets(x, Math.min(N, x.length));
  return subs.filter((c) => clusterMean(c, P) >= threshold).length / subs.length;
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
function normalPassProb(sd, nominal, threshold, N, P, trials = 100000, seed = 7) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let ok = 0;
  for (let t = 0; t < trials; t++) {
    const x = Array.from({ length: N }, () => Math.min(100, Math.max(0, nominal + sd * gauss())));
    if (clusterMean(x, P) >= threshold) ok++;
  }
  return ok / trials;
}

/** Normal sd that reproduces pass probability p (bisection on a monotone curve). */
function calibrateNormalSd(p, nominal, threshold, N, P) {
  if (!(p > 0 && p < 1)) return NaN;
  let lo = 0.01, hi = 60;
  const rising = normalPassProb(hi, nominal, threshold, N, P) > normalPassProb(lo, nominal, threshold, N, P);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const above = normalPassProb(mid, nominal, threshold, N, P) > p;
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

/** The jury's N (counted) and P (cluster): --counted/--cluster, else the most common in v2 data, else
 *  v1's 3 and 2. */
function juryNP(per, argv) {
  const modal = (f) => {
    const c = {};
    for (const r of per) if (r.jury) c[f(r.jury)] = (c[f(r.jury)] || 0) + 1;
    const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return e ? Number(e[0]) : null;
  };
  return { N: argv.counted ?? modal((j) => j.N) ?? 3, P: argv.cluster ?? modal((j) => j.P) ?? 2 };
}

function passRateAt(per, argv) {
  const { N, P } = juryNP(per, argv);
  const { nominal, threshold, band } = argv;
  const cost = argv["attempt-cost-usd"];
  const one = (center) => {
    const cfn = center === "median" ? (s) => quantile(s, 0.5) : mean;
    const rs = per.filter((r) => r.n >= 2 && Math.abs(cfn(r.shares) - nominal) <= band);
    // mean-centered residuals are shrunk by (n-1)/n in variance; rescale to the per-response spread
    const ps = rs.map((r) => roundPassProb(r.shares, cfn(r.shares), nominal, threshold,
      center === "mean" ? Math.sqrt(r.n / (r.n - 1)) : 1, N, P));
    const p = mean(ps);
    const [ciLo, ciHi] = wilson(p, rs.length);
    let ss = 0, dof = 0;
    for (const r of rs) { ss += (r.n - 1) * variance(r.shares); dof += r.n - 1; }
    return {
      center, rounds: rs.length, p, ciLo, ciHi, bandPooledSd: dof ? Math.sqrt(ss / dof) : NaN,
      normalSdEquivalent: rs.length ? calibrateNormalSd(p, nominal, threshold, N, P) : NaN,
      maxSafeValueUsd: p > 0 ? cost / p : Infinity,
    };
  };
  return { nominal, threshold, band, reveals: N, cluster: P, attemptCostUsd: cost, median: one("median"), mean: one("mean") };
}

function normCdf(x) { // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/* ───────────────────────────── CLI ───────────────────────────── */
if (require.main === module) yargs(hideBin(process.argv))
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
    .option("counted", { type: "number", desc: "N: reveals counted per round (default: the data's most common jury N; v1 data 3)" })
    .option("cluster", { type: "number", desc: "P: cluster size (default: the data's most common jury P; v1 data 2)" })
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

module.exports = { collectData, analyze, clusterMean };
