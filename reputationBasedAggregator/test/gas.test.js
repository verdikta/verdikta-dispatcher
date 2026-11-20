// Gas and cost benchmark for the v2 example contracts (TODO items 14 and 15): full rounds for the
// bounty classes against a 300-arbiter pool, with every transaction checked against the
// 16,777,216 per-transaction gas cap (EIP-7825), plus selection cost against pool size and the
// clustering cost at option A size.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

const TX_CAP = 16_777_216;
const ETH_USD = 2287;
const GWEI = [0.006, 0.05];        // typical Base base fee, and a congested 8x case
const usd = (gas, gwei) => gas * gwei * 1e-9 * ETH_USD;

// item 15's classes; T+ = 155 s, item 14's measured value. Jumbo runs with and without item 9's beacons
const CLASSES = [
  { name: "Small (6/5/4/3)", K: 6, M: 5, N: 4, P: 3, timeout: 300, tPlus: 155 },
  { name: "Medium (8/5/4/3)", K: 8, M: 5, N: 4, P: 3, timeout: 300, tPlus: 155 },
  { name: "Large (21/16/13/10)", K: 21, M: 16, N: 13, P: 10, timeout: 300, tPlus: 155 },
  { name: "Jumbo (50/38/27/17), no beacons", K: 50, M: 38, N: 27, P: 17, timeout: 600, tPlus: 155 },
  { name: "Jumbo (50/38/27/17), beacons (4 polled, first 2 used)", K: 50, M: 38, N: 27, P: 17, timeout: 600, tPlus: 155, beacons: true },
  { name: "Jumbo (50/38/27/17), beacons, one-number answers", K: 50, M: 38, N: 27, P: 17, timeout: 600, tPlus: 155, beacons: true, scalar: true },
  { name: "Jumbo (50/38/27/17), 20-outcome answers (the most a reveal may hold)", K: 50, M: 38, N: 27, P: 17, timeout: 600, tPlus: 155, outcomes: 20 },
];
const mPlus = (c) => c.M + Math.ceil((c.K - c.M) / 2);
const vecs = (sl) => H.vec(600_000 + (sl % 5) * 10_000);
const scalars = (sl) => [BigInt(600_000 + (sl % 5) * 10_000)];   // one-number answers (exact 1-D cluster)
const wide = (sl) => Array.from({ length: 20 }, (_, k) => BigInt(780_000 + ((sl * 7919 + k * 104729) % 60_000)));

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1], sum: s.reduce((a, b) => a + b, 0) };
}

describe("gas and cost (300-arbiter pool)", function () {
  this.timeout(1_800_000);
  let core, arbs, requester;
  const report = [];

  before(async () => {
    core = await H.deployCore();
    requester = (await ethers.getSigners())[1];
    arbs = await H.registerArbiters(core, 300);
  });

  for (const c of CLASSES) {
    it(`${c.name}: full rounds stay under the per-tx cap`, async () => {
      await core.agg.setConfig(c.K, c.M, c.N, c.P, c.timeout, c.tPlus);
      const drv = new RoundDriver(core, arbs, requester, { beacons: !!c.beacons });
      // three complete rounds, each settled explicitly after its deadline
      const vv = c.scalar ? scalars : c.outcomes ? wide : vecs;
      for (let i = 0; i < 3; i++) await drv.fullRound({ vectors: vv });
      // worst-case request: two due rounds in the queue that this request must settle
      for (let i = 0; i < 2; i++) await drv.fullRound({ settle: false, vectors: vv });
      await time.increase(c.timeout + 1);
      const r = await drv.requestOnly({ kind: "request (escrow) + settle 2 rounds" });
      expect(r.reqRcpt.logs.filter((l) => l.topics[0] === core.agg.interface.getEvent("RoundSettled").topicHash).length).to.equal(2);

      const rows = {};
      for (const [k, xs] of Object.entries(drv.gas)) {
        rows[k] = stats(xs);
        expect(rows[k].max).to.be.lessThan(TX_CAP);
      }
      report.push({ cls: c, rows });
    });
  }

  it("selection cost does not grow with the pool (300 vs 3,000 arbiters, K = 50)", async () => {
    // selection alone (keeper.selectArbiters from an approved caller): drawJury's dispatch cost depends
    // on whether operator contracts are already warm, which says nothing about the pool size
    const c = CLASSES[3];
    const [deployer] = await ethers.getSigners();
    const out = {};
    for (const [label, n] of [["300", 300], ["3,000", 3000]]) {
      const cc = await H.deployCore({ withAggregator: false });
      await H.registerArbiters(cc, n, { jobsPerOperator: 10 });
      await cc.keeper.setApproved(deployer.address, true);
      await ethers.provider.send("evm_mine", []);
      const b = await ethers.provider.getBlock((await ethers.provider.getBlockNumber()) - 1);
      const sp = { count: c.K, alpha: 500, maxFee: H.MAX_FEE, estimatedBaseCost: H.BASE_COST, maxFeeBasedScalingFactor: 5, requestedClass: 1 };
      const g = [];
      for (let i = 0; i < 5; i++) {
        g.push(Number(await cc.keeper.selectArbiters.estimateGas(sp, ethers.hexlify(ethers.randomBytes(32)), b.number, b.timestamp)));
      }
      out[label] = stats(g);
    }
    console.log(`\n      K=50 selectArbiters gas, pool 300: median ${out["300"].med.toLocaleString()}; pool 3,000: median ${out["3,000"].med.toLocaleString()}`);
    expect(out["3,000"].med).to.be.lessThan(out["300"].med * 1.1);
    report.selection = out;
  });

  it("clustering at N = 27, P = 17: ScoringLib vs today's AggregatorLib", async () => {
    const v = Array.from({ length: 27 }, (_, i) => [BigInt(55 + (i * 7) % 11), BigInt(45 - (i * 7) % 11)]);
    const g1 = Number(await core.aggLib.findBestCluster.estimateGas(v, v.map((_, i) => i), 17));
    const g2 = Number(await core.scoring.bestCluster.estimateGas(v, 17));
    const g3 = Number(await core.scoring.classify.estimateGas(v, 3));
    console.log(`      findBestCluster (today) ${g1.toLocaleString()} gas; bestCluster (v2) ${g2.toLocaleString()} gas; classify ${g3.toLocaleString()} gas (each incl. 21k call base)`);
    expect(g2).to.be.lessThan(g1);
    report.cluster = { today: g1, v2: g2, classify: g3 };
  });

  after(() => {
    const payer = (k) =>
      k.startsWith("request") ? "requester" :
      k.startsWith("drawJury (start") ? "requester (no reward)" :
      k.startsWith("drawJury") ? "requester (rewarded 2 x fee)" :
      k.startsWith("settle") ? "anyone (or the next request)" :
      k.startsWith("promote") ? "anyone (rewarded 1 x fee)" : k.startsWith("closeCommits") ? "anyone" : "arbiter node";
    console.log("\n      ===== gas per transaction (median / max) and cost at 0.006 gwei, ETH $" + ETH_USD + " =====");
    for (const { cls, rows } of report) {
      console.log(`\n      ${cls.name}`);
      let roundTotal = 0;
      for (const [k, s] of Object.entries(rows)) {
        console.log(`        ${k.padEnd(30)} n=${String(s.n).padStart(4)}  median ${String(s.med.toLocaleString()).padStart(11)}  max ${String(s.max.toLocaleString()).padStart(11)}  ($${usd(s.max, GWEI[0]).toFixed(4)})  paid by ${payer(k)}`);
      }
      // one round's total: request + K answers + M+ commits (the last closes) + K - M+ ignored commits
      // + promote + M reveals (one finalizing) + settle
      const per = (k, count) => (rows[k] ? rows[k].med * count : 0);
      const mp = mPlus(cls);
      roundTotal = per("request (escrow)", 1) + per("drawJury (start beacons)", 1) + per("beacon answer", 4) +
        per("drawJury (select + dispatch K)", 1) + per("health answer", cls.K) +
        per("commit", mp - 1) + per("closing commit (records C)", 1) + per("ignored commit (after close)", cls.K - mp) +
        per("promote (dispatches M reveals)", 1) +
        per("reveal", cls.N - 1) + per("finalizing reveal (Nth)", 1) + per("late reveal", cls.M - cls.N) + per("settle (applyOutcomes x K)", 1);
      console.log(`        one round, all transactions: ~${Math.round(roundTotal).toLocaleString()} gas = $${usd(roundTotal, GWEI[0]).toFixed(3)} at ${GWEI[0]} gwei, $${usd(roundTotal, GWEI[1]).toFixed(3)} at ${GWEI[1]} gwei`);
    }
  });
});
