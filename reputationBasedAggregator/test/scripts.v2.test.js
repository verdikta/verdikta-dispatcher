// The v2 diagnostic scripts (scripts/reveal-forensics.js, scripts/arbiter-noise.js) and their pure
// helpers (scripts/lib/v2-reveal.js), against real rounds on the in-process network.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");
const V2 = require("../scripts/lib/v2-reveal");
const { forensics, printReport } = require("../scripts/reveal-forensics");
const noise = require("../scripts/arbiter-noise");

describe("v2 diagnostic scripts", function () {
  let core, agg, keeper, arbs, drv, requester, aggAbi;

  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper } = core);
    [, requester] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 12);
    await keeper.setSelection(60, 400, 0);        // no random probes, so only jurors are called
    await H.installHistory();
    drv = new RoundDriver(core, arbs, requester);
    aggAbi = (await artifacts.readArtifact("ReputationAggregator")).abi;
  });

  describe("lib/v2-reveal", () => {
    it("computes every commit and reveal request id of a real round, and decodes requestRef", async () => {
      const r = await drv.request();
      const roundId = await agg.roundCount();
      expect(V2.aggIdOf(roundId)).to.equal(r.aggId.toLowerCase());
      expect(V2.roundIdOf(r.aggId)).to.equal(roundId);
      const aggAddr = await agg.getAddress();
      const slots = Object.values(r.slots);
      expect(slots.length).to.equal(H.JURY.K);
      for (const s of slots) {
        expect(V2.requestIdFor(aggAddr, roundId, s.slot, false)).to.equal(s.commitReq.requestId.toLowerCase());
        const ref = V2.decodeRequestRef(await agg.requestRef(s.commitReq.requestId));
        expect(ref).to.deep.equal({ operator: s.arb.opAddr.toLowerCase(), roundId, slot: s.slot });
      }
      expect(V2.decodeRequestRef(0n)).to.equal(null);

      await drv.answerAll(r);
      for (const s of slots) await drv.commit(r, s.slot, H.vec(600_000));
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      expect(prom.length).to.equal(H.JURY.M);
      for (const sl of prom) {
        const s = r.slots[sl];
        expect(V2.requestIdFor(aggAddr, roundId, sl, true)).to.equal(s.revealReq.requestId.toLowerCase());
        // answered requests leave requestRef: the formula is the only way back from history
        await drv.reveal(r, sl);
        expect(await agg.requestRef(s.revealReq.requestId)).to.equal(0n);
      }
    });

    it("checkReveal repeats the aggregator's reveal checks", async () => {
      const aggId = V2.aggIdOf(7);
      const op = ethers.Wallet.createRandom().address;
      const salt = (1n << 127n) | 5n;
      const scores = [600_000n, 400_000n];
      const commit = ethers.toBeHex(H.commitWord(aggId, op, scores, salt), 32);
      expect(V2.commitHashV2(aggId, op, scores, salt)).to.equal(commit.toLowerCase());
      const cid = `QmX:${H.saltHex(salt)}`;
      const ok = V2.checkReveal({ aggId, operator: op, scores, cid, commitHash: commit });
      expect(ok).to.include({ ok: true, reason: null, cid: "QmX", clamped: 0 });
      expect(ok.salt).to.equal(salt);
      const why = (o) => V2.checkReveal({ aggId, operator: op, scores, cid, commitHash: commit, ...o }).reason;
      expect(why({ cid: `QmX:${H.saltHex(salt + 1n)}` })).to.equal("hash mismatch");
      expect(why({ aggId: V2.aggIdOf(8) })).to.equal("hash mismatch");                 // bound to the round
      expect(why({ cid: "QmX:" + "ab".repeat(10) })).to.match(/bad cid:salt/);         // v1's 20-hex salt
      expect(why({ cid: ":" + H.saltHex(salt) })).to.match(/bad cid:salt/);           // empty cid
      expect(why({ cid: "Q".repeat(101) + ":" + H.saltHex(salt) })).to.match(/cid too long/);
      expect(why({ scores: Array(21).fill(1n) })).to.match(/too many scores/);
      expect(why({ scores: [] })).to.equal("no scores");
      expect(why({ scores: [5n], cid: "" })).to.match(/commit-shaped/);
      expect(why({ commitHash: ethers.ZeroHash })).to.match(/no commit/);
      // scores above 1e34 are clamped by the aggregator, not rejected
      const big = [10n ** 35n, 1n];
      const c2 = ethers.toBeHex(H.commitWord(aggId, op, big, salt), 32);
      expect(V2.checkReveal({ aggId, operator: op, scores: big, cid, commitHash: c2 })).to.include({ ok: true, clamped: 1 });
      // the contract's parser agrees on the boundaries
      const L = core.aggLib;
      for (const s of [cid, "QmX:" + "ab".repeat(10), ":" + H.saltHex(salt), "a:b:" + "F".repeat(32), "é:" + "0".repeat(32)]) {
        const [cok, ccid, csalt] = await L.parseCidSalt(s);
        const p = V2.parseRevealCid(s);
        expect(!!p).to.equal(cok);
        if (p) expect([p.cid, p.salt]).to.deep.equal([ccid, csalt]);
      }
      expect(V2.flagString(1 | 2 | 4 | 16)).to.equal("DCP-K");
    });

    it("clusterMean is v1's closest pair at P = 2 and ScoringLib's 1-D window above", () => {
      expect(noise.clusterMean([10, 50, 52], 2)).to.equal(51);
      expect(noise.clusterMean([10, 50, 52, 90], 3)).to.equal(64);           // (50,52,90) beats (10,50,52)
      expect(noise.clusterMean([10, 50, 52, 60], 3)).to.equal(54);
      expect(noise.clusterMean([0, 40, 42, 44, 100], 3)).to.equal(42);
    });
  });

  describe("scripts against a round with every kind of reply", () => {
    // K=9, M=8, N=4, P=3: 8 commit, T+ passes, the commit phase is closed, slot 8 commits too late.
    // Promoted (all 8): #0 wrong salt, #1 v1 salt format, #2 21 scores, #3..#6 valid (the 4th finalizes),
    // #7 valid after finalization (late, classified).
    const JURY = H.jury(9, 8, 4, 3, 300);
    let round, prom;

    beforeEach(async () => {
      drv.jury = JURY;
      round = await drv.request();
      await drv.answerAll(round);
      const slots = Object.keys(round.slots).map(Number).sort((a, b) => a - b);
      for (const sl of slots.slice(0, 8)) await drv.commit(round, sl, H.vec(600_000 + (sl % 3) * 10_000));
      await time.increase(Number(await agg.tPlus()) + 1);
      await drv.closeCommits(round);
      await drv.commit(round, slots[8], H.vec(600_000));        // phase CLOSING: ignored
      await drv.promote(round);
      prom = drv.promotedSlots(round).sort((a, b) => a - b);
      expect(prom.length).to.equal(8);
      const bad = async (sl, response, cid) => {
        const s = round.slots[sl];
        await (await H.fulfil(s.revealReq, s.arb.node, response, cid)).wait();
      };
      await bad(prom[0], round.slots[prom[0]].reveal, `QmBad:${H.saltHex(round.slots[prom[0]].salt + 1n)}`);
      await bad(prom[1], round.slots[prom[1]].reveal, "QmOld:" + "ab".repeat(10));
      await bad(prom[2], Array(21).fill(1n), `QmLong:${H.saltHex(round.slots[prom[2]].salt)}`);
      for (const sl of prom.slice(3)) await drv.reveal(round, sl);
      await time.increase(JURY.timeout + 1);
      await drv.settle(round);
    });

    it("reveal-forensics reconstructs every verdict and agrees with the chain", async () => {
      const R = await forensics({ provider: ethers.provider, aggregator: await agg.getAddress(), aggId: round.aggId, aggAbi });
      expect(R.outcome).to.equal("COMPLETED (settled)");
      expect(R.jury).to.include({ K: 9, M: 8, N: 4, P: 3 });
      const d = Object.fromEntries(R.slots.map((s) => [s.slot, s.diagnosis]));
      expect(d[prom[0]]).to.equal("reveal ignored: hash mismatch");
      expect(d[prom[1]]).to.match(/^reveal ignored: bad cid:salt format/);
      expect(d[prom[2]]).to.equal("reveal ignored: too many scores (21 > 20)");
      for (const sl of prom.slice(3, 7)) expect(d[sl]).to.equal("OK (counted)");
      expect(d[prom[7]]).to.match(/^OK \(late reveal, q=/);
      const notProm = R.slots.find((s) => !prom.includes(s.slot));
      expect(notProm.diagnosis).to.equal("commit ignored: commit in phase CLOSING");
      for (const s of R.slots) {
        expect(s.commit.requested).to.equal(true);                // the computed commit id was sent
        if (prom.includes(s.slot)) expect(s.reveal.requested).to.equal(true);
        for (const r of [s.commit.reply, s.reveal.reply].filter(Boolean)) expect(r.chainAgrees).to.equal(true);
      }
      const out = [];
      printReport(R, (...a) => out.push(a.join(" ")));
      const text = out.join("\n");
      expect(text).to.include("Outcome: COMPLETED (settled)");
      expect(text).to.include("Missing slots   : " + prom.slice(0, 3).join(","));
    });

    it("arbiter-noise collects every reveal, verifies it and analyzes the round", async () => {
      const logs = [];
      const data = await noise.collectData({
        provider: ethers.provider, aggregator: await agg.getAddress(), aggAbi, fromBlock: 0, network: "hardhat",
        log: (m) => logs.push(m),
      });
      expect(data.meta.version).to.equal(2);
      expect(data.rounds.length).to.equal(1);
      const r = data.rounds[0];
      expect(r.aggId).to.equal(round.aggId.toLowerCase());
      expect(r.jury).to.deep.equal({ K: 9, M: 8, N: 4, P: 3 });
      expect(r.class).to.equal("1");
      expect(r.revealRequests).to.equal(8);
      const by = Object.fromEntries(r.reveals.map((v) => [v.slot, v]));
      expect(Object.keys(by).length).to.equal(8);
      for (const sl of prom.slice(0, 3)) expect(by[sl].hashOk).to.equal(false);
      expect(by[prom[0]].rejectReason).to.equal("hash mismatch");
      for (const sl of prom.slice(3)) expect(by[sl].hashOk).to.equal(true);
      for (const sl of prom.slice(3, 7)) expect(by[sl]).to.include({ counted: true, late: false });
      expect(by[prom[7]]).to.include({ counted: false, late: true, accepted: true });
      expect(by[prom[3]].scores).to.deep.equal(round.slots[prom[3]].reveal.map(String));

      const out = [];
      const res = noise.analyze({
        period: "week", "outcome-index": 1, "include-unchecked": false, "min-obs": 1, "z-flag": 3,
        "disagree-sd": 5, band: 5, "attempt-cost-usd": 0.59, top: 10, nominal: 39, threshold: 30,
      }, data, (...a) => out.push(a.join(" ")));
      expect(res.overall.rounds).to.equal(1);
      expect(res.overall.reveals).to.equal(5);
      expect(res.overall.failedCommitCheck).to.equal(3);
      expect(res.overall.countedOnly.reveals).to.equal(4);
      expect(res.overall.pooledSd).to.be.above(0);
      expect(res.arbiters.map((a) => a.arbiter)).to.have.members(prom.slice(3).map((sl) => round.slots[sl].arb.key.toLowerCase()));
      expect(res.passRate).to.include({ reveals: 4, cluster: 3 });
      expect(res.passRate.median.rounds).to.equal(1);
    });
  });
});
