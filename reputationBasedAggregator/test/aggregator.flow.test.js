// End-to-end tests for ReputationAggregator + ReputationKeeper through TestOperator:
// two-phase request (item 9, with EIP-2935 hash reads), M+ / T+ promotion (item 14), finalization,
// late reveals, settlement (Table 1), failed rounds, the settlement queue, ETH accounting, the
// item 11 score getter, gas griefing, and clustering equivalence. Scores are on the 0..1,000,000 scale.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

describe("ReputationAggregator flow (items 14, 9 and 11)", function () {
  let core, agg, keeper, arbs, drv, requester, stranger, history;
  const V = H.vec;
  const score = async (slotObj) => {
    const a = await keeper.getArbiter(slotObj.arb.key);
    return [Number(a.timeliness), Number(a.quality)];
  };
  const flags = async (round, sl) => Number((await agg.getSlot(round.aggId, sl)).flags);
  const juryKeys = async (round, k = 6) => {
    const out = [];
    for (let i = 0; i < k; i++) out.push((await agg.getSlot(round.aggId, i)).key);
    return out;
  };
  const eventArgs = (rcpt, name) => rcpt.logs
    .filter((l) => l.topics[0] === agg.interface.getEvent(name).topicHash)
    .map((l) => agg.interface.parseLog(l).args);
  const commitAll = async (r, slots, v = V(600_000)) => { for (const s of slots) await drv.commit(r, s, v); };

  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper } = core);
    [, requester, , stranger] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 12);
    await keeper.setSelection(60, 400, 0);        // no random probes, so only jurors are called
    history = await H.installHistory();
    drv = new RoundDriver(core, arbs, requester);
  });

  describe("two-phase request (item 9)", () => {
    it("the request only escrows; the draw is possible from B+2 and is the same whoever draws and whenever", async () => {
      const r = await drv.requestOnly();
      expect(H.oracleRequests(r.reqRcpt).length).to.equal(0);                 // nothing dispatched
      await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");   // block B+1
      const snap = await takeSnapshot();
      await drv.draw(r, { by: requester });
      const jury1 = await juryKeys(r);

      await snap.restore();
      // change the keeper state after B: boost, block, pause, freeze, register
      const [deployer] = await ethers.getSigners();
      await keeper.setApproved(deployer.address, true);
      const all = arbs.map((a) => a.key);
      const end = (await time.latest()) + 1;
      for (let i = 0; i < 5; i++) await keeper.applyOutcomes(all.slice(6), all.slice(6).map(() => H.code(H.T.DELIVERED, H.Q.CLOSE)), end);
      await keeper.applyOutcomes(jury1.slice(0, 2), [H.code(H.T.MISS_FAILED), H.code(H.T.MISS_FAILED)], end + 10);
      await keeper.setPaused(jury1[2], true);
      await keeper.sendHealthCalls([jury1[3]]);
      await H.registerArbiters(core, 10);
      await time.increase(3600);
      await mine(50);
      const r2 = { aggId: r.aggId, slots: {} };
      await drv.draw(r2, { by: stranger, waitBlocks: 0 });
      expect(await juryKeys(r2)).to.deep.equal(jury1);
    });

    it("draw reward: 2 x eff to the requester within 30 s, nothing to a third party within 30 s, the drawer after 30 s", async () => {
      const eff = H.MAX_FEE;
      const owed = (a) => agg.ethOwed(a);
      let r = await drv.requestOnly();
      let rc = await drv.draw(r, { by: requester });
      expect(eventArgs(rc, "JuryDrawn")[0].reward).to.equal(2n * eff);
      r = await drv.requestOnly();
      const s0 = await owed(stranger.address);
      rc = await drv.draw(r, { by: stranger });
      expect(eventArgs(rc, "JuryDrawn")[0].reward).to.equal(0n);
      expect(await owed(stranger.address)).to.equal(s0);
      r = await drv.requestOnly();
      await time.increase(31);
      rc = await drv.draw(r, { by: stranger });
      expect(eventArgs(rc, "JuryDrawn")[0].reward).to.equal(2n * eff);
      expect((await owed(stranger.address)) - s0).to.equal(2n * eff);
    });

    it("past 256 blocks the seed is read from EIP-2935; the jury is the one BLOCKHASH would have given", async () => {
      const r = await drv.requestOnly();
      const [, B] = await agg.getRoundInfo(r.aggId);
      const snap = await takeSnapshot();
      await drv.draw(r);                                                      // within 256 blocks
      const jury1 = await juryKeys(r);
      await snap.restore();
      await mine(300);                                                        // ~60 s at 0.2 s blocks
      await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "SeedExpired");   // not in history
      await H.recordHash(history, B + 1n);
      const r2 = { aggId: r.aggId, slots: {} };
      await drv.draw(r2, { waitBlocks: 0 });
      expect(await juryKeys(r2)).to.deep.equal(jury1);
    });

    it("an undrawn round never times out; unsealed past the 8,191-block history it goes to the arbiter pool, never refunded", async () => {
      const x = await drv.requestOnly();
      const y = await drv.requestOnly();
      await mine(2);
      await agg.sealSeed(y.aggId);
      await time.increase(3600);
      await mine(300);
      await expect(agg.settle(x.aggId)).to.be.revertedWithCustomError(agg, "WrongPhase");
      await expect(agg.cancelUnsealed(x.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");   // still in history
      await mine(8200);
      const [deployer] = await ethers.getSigners();
      const t0 = await agg.ethOwed(ethers.ZeroAddress);                         // the arbiter pool
      const [, , , , received] = await agg.getRoundInfo(x.aggId);
      await agg.connect(stranger).cancelUnsealed(x.aggId);
      expect((await agg.ethOwed(ethers.ZeroAddress)) - t0).to.equal(received);
      expect(await agg.ethOwed(requester.address)).to.equal(0n);
      await expect(agg.cancelUnsealed(y.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");    // sealed, < 1 day
      await drv.draw(y, { waitBlocks: 0 });                                   // sealed: drawable for a day
      expect(Object.keys(y.slots).length).to.equal(6);
    });

    it("a draw that finds no eligible arbiter at B fails the round and refunds the requester", async () => {
      for (const a of arbs) await keeper.setPaused(a.key, true);
      const r = await drv.requestOnly();
      await mine(1);
      const rc = await (await agg.connect(stranger).drawJury(r.aggId)).wait();
      expect(eventArgs(rc, "EvaluationFailed").length).to.equal(1);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      const [, , , , received] = await agg.getRoundInfo(r.aggId);
      expect(await agg.ethOwed(requester.address)).to.equal(received);
    });

    it("a sealed round undrawn for a day can no longer be drawn, and goes to the arbiter pool", async () => {
      // the draw age limit: no draw reads a request block more than a day old, which the keeper's
      // unbonding (at least 2 days) and slot reuse rely on
      const r = await drv.requestOnly();
      await mine(2);
      await agg.sealSeed(r.aggId);
      await expect(agg.cancelUnsealed(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");
      await time.increase(24 * 3600 - 30);
      const snap = await takeSnapshot();
      await drv.draw(r, { waitBlocks: 0 });                                   // still drawable just before
      await snap.restore();
      await time.increase(31);
      await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "DrawExpired");
      const [deployer] = await ethers.getSigners();
      const t0 = await agg.ethOwed(ethers.ZeroAddress);
      const [, , , , received] = await agg.getRoundInfo(r.aggId);
      await agg.connect(stranger).cancelUnsealed(r.aggId);
      expect((await agg.ethOwed(ethers.ZeroAddress)) - t0).to.equal(received);
    });

    it("rewards are fixed at request: raising them before the draw cannot break settlement", async () => {
      const r = await drv.requestOnly();
      await agg.setRewards(20, 30, 10, 120);
      await drv.draw(r);
      const [, , , , , , , reward] = await agg.getRoundInfo(r.aggId);
      expect(reward).to.equal(2n * H.MAX_FEE);
      await drv.answerAll(r);
      for (let s = 0; s < 6; s++) await drv.commit(r, s, V(600_000));
      await drv.promote(r);
      for (const s of drv.promotedSlots(r).slice(0, 4)) await drv.reveal(r, s);
      expect((await agg.getEvaluation(r.aggId))[2]).to.equal(true);
      await time.increase(301);
      await drv.requestOnly({ value: await H.quote(agg, H.MAX_FEE, 0, false) });    // settles r via the queue
      expect((await agg.getRoundInfo(r.aggId))[0]).to.equal(7n);              // PH_SETTLED
    });

    it("rejects a scaling factor that would not fit its uint16 field", async () => {
      const v = await H.quote(agg, H.MAX_FEE, 0, false);
      await expect(agg.connect(requester).requestAIEvaluationWithApproval(["Qm"], "", 500, H.MAX_FEE, 0, H.BASE_COST, 65536, 1, false, H.JURY, { value: v }))
        .to.be.revertedWithCustomError(agg, "BadInput");
    });

    it("a request settles due rounds until settlePerRequest x its own K slots are spent; the first due round always", async () => {
      drv.jury = H.jury(12, 9, 8, 5, 300);                                    // 12 slots
      const big = await drv.fullRound({ settle: false });
      drv.jury = H.JURY;                                                       // 6 slots
      const small = await drv.fullRound({ settle: false });
      const small2 = await drv.fullRound({ settle: false });
      await time.increase(301);
      const settled = (rc) => eventArgs(rc, "RoundSettled").map((a) => a.aggRequestId);
      // K = 3: a budget of 6 slots, below the big round at the head, which is settled anyway (overshoot), so
      // a big round cannot stall the queue behind it; the budget is then spent
      expect(settled((await drv.requestOnly({ jury: H.jury(3, 3, 3, 3) })).reqRcpt)).to.deep.equal([big.aggId]);
      // K = 4: 8 slots, the first small round (6), then the second overshoots the 2 left
      expect(settled((await drv.requestOnly({ jury: H.jury(4, 4, 4, 3) })).reqRcpt)).to.deep.equal([small.aggId, small2.aggId]);
      // anyone may settle a round the queue is holding back
      drv.jury = H.jury(12, 9, 8, 5, 300);
      const big2 = await drv.fullRound({ settle: false });
      await time.increase(301);
      await agg.connect(stranger).settle(big2.aggId);
      expect((await agg.getRoundInfo(big2.aggId))[0]).to.equal(7n);
    });

    it("undrawn rounds do not hold up the settlement queue", async () => {
      await drv.requestOnly();                                                // never drawn
      const r = await drv.fullRound({ settle: false });
      await time.increase(301);
      const r2 = await drv.requestOnly();
      expect(eventArgs(r2.reqRcpt, "RoundSettled").map((a) => a.aggRequestId)).to.deep.equal([r.aggId]);
    });
  });

  describe("M+ / T+ promotion (item 14)", () => {
    beforeEach(async () => {
      drv.jury = H.jury(8, 5, 4, 3, 300);                                          // Medium: M+ = 5 + ceil(3/2) = 7
    });

    it("the M+-th commit closes the commit phase; promote() at C+2 draws M of the commits; later commits are ignored", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5]);
      expect(r.closing).to.equal(undefined);
      await drv.commit(r, 6, V(600_000));                                     // 7th = M+
      expect(r.closing).to.equal(true);
      await expect(agg.promote(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");   // C+1
      await drv.commit(r, 7, V(600_000));                                     // after close: ignored
      expect((await flags(r, 7)) & 2).to.equal(0);
      await drv.promote(r, { waitBlocks: 0 });
      const prom = drv.promotedSlots(r);
      expect(prom.length).to.equal(5);
      for (const s of prom) {
        expect(s).to.be.lessThan(7);
        expect((await flags(r, s)) & 4).to.equal(4);
      }
    });

    it("the promoted set is the same whoever calls promote() and whenever, also past 256 blocks via EIP-2935", async () => {
      drv.jury = H.jury(8, 5, 4, 3, 1000);                                         // Hardhat mines 1 s per block
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5, 6]);
      const [, , , C] = await agg.getRoundInfo(r.aggId);
      const snap = await takeSnapshot();
      await drv.promote(r, { by: r.slots[0].arb.node });
      const p1 = drv.promotedSlots(r).sort();
      await snap.restore();
      for (const s of Object.values(r.slots)) delete s.revealReq;
      await mine(300);
      await H.recordHash(history, C + 1n);
      await drv.promote(r, { by: stranger, waitBlocks: 0 });
      expect(drv.promotedSlots(r).sort()).to.deep.equal(p1);
    });

    it("before T+, M commits do not close; after T+ the next commit closes and every commit so far can be drawn", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4]);                                    // M = 5, before T+
      expect(r.closing).to.equal(undefined);
      await time.increase(156);
      await drv.commit(r, 5, V(600_000));                                     // after T+: closes with 6
      expect(r.closing).to.equal(true);
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      expect(prom.length).to.equal(5);
      for (const s of prom) expect(s).to.be.lessThan(6);
    });

    it("fewer than M at T+: the M-th commit closes and all M are promoted", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2]);
      await time.increase(156);
      await commitAll(r, [3, 4]);
      expect(r.closing).to.equal(true);
      await drv.promote(r);
      expect(drv.promotedSlots(r).sort()).to.deep.equal([0, 1, 2, 3, 4]);
    });

    it("closeCommits needs T+ passed and at least M commits", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3]);
      await time.increase(156);
      await expect(agg.closeCommits(r.aggId)).to.be.revertedWithCustomError(agg, "WrongPhase");   // 4 < M
      const r2 = await drv.request();
      await drv.answerAll(r2);
      await commitAll(r2, [0, 1, 2, 3, 4]);
      await expect(agg.closeCommits(r2.aggId)).to.be.revertedWithCustomError(agg, "WrongPhase");  // before T+
      await time.increase(156);
      await drv.closeCommits(r2);
      await drv.promote(r2);
      expect(drv.promotedSlots(r2).length).to.equal(5);
    });

    it("every committer is drawn sometimes: promotion is a uniform draw over all commits", async () => {
      const seen = new Set();
      for (let i = 0; i < 12 && seen.size < 7; i++) {
        const r = await drv.request();
        await drv.answerAll(r);
        await commitAll(r, [0, 1, 2, 3, 4, 5, 6]);
        await drv.promote(r);
        for (const s of drv.promotedSlots(r)) seen.add(s);
      }
      expect(seen.size).to.equal(7);
    });

    it("a closed phase that is never promoted fails without penalising anyone; the committers share the unspent prepay", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5, 6]);
      await time.increase(301);
      const before = await agg.ethOwed(requester.address);
      const [, , , , received, base, bonus, reward0] = await agg.getRoundInfo(r.aggId);
      const left = received - base - bonus - reward0;
      const rc = await drv.settle(r);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (let s = 0; s < 8; s++) expect(await score(r.slots[s])).to.deep.equal([500, 500]);
      expect(await agg.ethOwed(requester.address)).to.equal(before);     // withholding promote buys no refund
      // the 7 committed slots (M+ of K = 8) each get an equal share, the 8th (no commit) nothing
      const paid = eventArgs(rc, "CommitPayment");
      const share = left / 7n;
      expect(paid.length).to.equal(7);
      for (const p of paid) expect(p.amount).to.equal(share);
      const payees = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(async (s) => (await agg.getSlot(r.aggId, s)).payee));
      expect(paid.map((p) => p.payee).sort()).to.deep.equal(payees.sort());
      const dust = eventArgs(rc, "RequesterRefunded");                     // the indivisible rest, to the arbiter pool
      const [deployer] = await ethers.getSigners();
      if (left % 7n) expect([dust[0].requester, dust[0].amount]).to.deep.equal([ethers.ZeroAddress, left % 7n]);
      else expect(dust.length).to.equal(0);
      expect((await agg.getRoundInfo(r.aggId))[7]).to.equal(reward0 + share * 7n, "the shares count as rewards");
    });

    it("promote() pays its caller 1 x eff, and promoted arbiters get revealWindow however late it is called", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5, 6]);                              // closes early
      await time.increase(250);                                               // near the deadline
      const s0 = await agg.ethOwed(stranger.address);
      await drv.promote(r, { by: stranger });
      expect((await agg.ethOwed(stranger.address)) - s0).to.equal(H.MAX_FEE);
      await time.increase(60);                                                // past the original deadline
      for (const s of drv.promotedSlots(r).slice(0, 4)) await drv.reveal(r, s);
      expect((await agg.getEvaluation(r.aggId))[2]).to.equal(true);
      await time.increase(121);
      await drv.settle(r);
      for (const s of drv.promotedSlots(r).slice(0, 4)) expect((await score(r.slots[s]))[0]).to.equal(520);
    });
  });

  describe("finalize, late reveals, settlement", () => {
    it("pays the cluster, classifies counted and late reveals, and settles Table 1 points", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      const vec = { 0: V(600_000), 1: V(610_000), 2: V(590_000), 3: V(950_000), 4: V(600_000), 5: V(620_000) };
      for (let s = 0; s < 6; s++) await drv.commit(r, s, vec[s]);          // M+ = 6 for 6/5
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      const notProm = [0, 1, 2, 3, 4, 5].find((s) => !prom.includes(s));
      const order = prom.filter((s) => s === 3).concat(prom.filter((s) => s !== 3));
      const counted = order.slice(0, 4), lateSlot = order[4];
      for (const s of counted) await drv.reveal(r, s);
      const [aggregated, , valid] = await agg.getEvaluation(r.aggId);
      expect(valid).to.equal(true);
      expect(aggregated.length).to.equal(2);
      await drv.reveal(r, lateSlot, "late reveal");
      expect(Number((await agg.getSlot(r.aggId, lateSlot)).qcode)).to.equal(H.Q.CLOSE);

      await expect(agg.settle(r.aggId)).to.be.revertedWithCustomError(agg, "NotDue");
      await time.increase(301);
      await drv.settle(r);
      for (const s of counted.concat([lateSlot])) {
        expect(await score(r.slots[s])).to.deep.equal(s === 3 ? [520, 300] : [520, 520]);
      }
      expect(await score(r.slots[notProm])).to.deep.equal([500, 500]);
    });

    it("item 11: getOutcomeScores returns the counted reveals' raw scores in reveal order, and only once final", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      for (let s = 0; s < 6; s++) await drv.commit(r, s, V(900_000 + s * 10_000));
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      let [, ok] = await agg.getOutcomeScores(r.aggId, 0);
      expect(ok).to.equal(false);
      for (const s of prom.slice(0, 4)) await drv.reveal(r, s);
      const [scores, valid] = await agg.getOutcomeScores(r.aggId, 0);
      expect(valid).to.equal(true);
      expect(scores).to.deep.equal(prom.slice(0, 4).map((s) => BigInt(900_000 + s * 10_000)));
      [, ok] = await agg.getOutcomeScores(r.aggId, 2);                        // no such outcome
      expect(ok).to.equal(false);
    });

    it("small honest disagreement on the 0..1,000,000 scale is scored close (the 3-point floor)", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      const v = [970_000, 970_000, 970_000, 960_000, 940_000, 970_000];       // identical but two
      for (let s = 0; s < 6; s++) await drv.commit(r, s, V(v[s]));
      await drv.promote(r);
      for (const s of drv.promotedSlots(r).slice(0, 4)) await drv.reveal(r, s);
      for (const s of drv.promotedSlots(r).slice(0, 4)) {
        expect(Number((await agg.getSlot(r.aggId, s)).qcode)).to.equal(H.Q.CLOSE);   // within 45,000
      }
    });

    it("a promoted arbiter that never reveals loses 200 timeliness in a finished round", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5]);
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      for (const s of prom.slice(0, 4)) await drv.reveal(r, s);
      await time.increase(301);
      await drv.settle(r);
      expect(await score(r.slots[prom[4]])).to.deep.equal([300, 500]);
    });

    it("a juror down at round end that recovers before settlement is not charged", async () => {
      const r = await drv.request();
      await drv.answerAll(r, [5]);
      await commitAll(r, [0, 1, 2]);
      await time.increase(301);
      await drv.answerAll(r);                                                 // slot 5 back after the deadline
      await drv.settle(r);
      expect(await score(r.slots[5])).to.deep.equal([500, 500]);
      expect(await score(r.slots[4])).to.deep.equal([100, 500]);
    });

    it("failed for lack of commits: live non-committers lose 400, frozen ones are not scored, requester refunded", async () => {
      const r = await drv.request();
      await drv.answerAll(r, [5]);                                           // slot 5's node is down
      await commitAll(r, [0, 1, 2]);
      await time.increase(301);
      const r2 = await drv.requestOnly({ kind: "request (escrow) + settle" });  // settles via the queue
      expect(eventArgs(r2.reqRcpt, "RoundSettled").length).to.equal(1);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (const s of [3, 4]) {
        expect(await score(r.slots[s])).to.deep.equal([100, 500]);
        expect((await keeper.getArbiter(r.slots[s].arb.key)).offenses).to.equal(0n);
      }
      expect(await score(r.slots[5])).to.deep.equal([500, 500]);
      expect(await score(r.slots[0])).to.deep.equal([500, 500]);
      const [, , , , received, base, , reward] = await agg.getRoundInfo(r.aggId);
      const refunds = eventArgs(r2.reqRcpt, "RequesterRefunded");
      expect(refunds.length).to.equal(1);
      expect(refunds[0].amount).to.equal(received - base - reward);
    });

    it("failed with no commit at all: nobody is charged (a request every arbiter refuses, or a shared outage)", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await time.increase(301);
      await drv.settle(r);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (let s = 0; s < 6; s++) {
        expect(await score(r.slots[s])).to.deep.equal([500, 500]);
        expect((await keeper.getArbiter(r.slots[s].arb.key)).offenses).to.equal(0n);
      }
    });

    it("M commits but nobody closed the phase after T+: the round fails, nobody is charged, and the 5 committers share the prepay", async () => {
      drv.jury = H.jury(8, 5, 4, 3, 300);
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4]);                                    // M commits, before T+; nobody closes
      await time.increase(301);
      const [deployer] = await ethers.getSigners();
      const t0 = await agg.ethOwed(ethers.ZeroAddress);
      const q0 = await agg.ethOwed(requester.address);
      const [, , , , rec0, base0, bonus0, reward0] = await agg.getRoundInfo(r.aggId);
      const rc = await drv.settle(r);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (const s of [5, 6, 7]) expect(await score(r.slots[s])).to.deep.equal([500, 500]);
      const paid = eventArgs(rc, "CommitPayment");
      expect(paid.length).to.equal(5);
      for (const p of paid) expect(p.amount).to.equal((rec0 - base0 - bonus0 - reward0) / 5n);
      // otherwise a requester that dislikes the jury could withhold closeCommits (with one colluding
      // juror not committing) and get its prepay back: a cheap re-roll
      const [, , , , received, base, , reward] = await agg.getRoundInfo(r.aggId);
      expect((await agg.ethOwed(ethers.ZeroAddress)) - t0).to.equal(received - base - reward);   // only the dust
      expect(await agg.ethOwed(requester.address)).to.equal(q0);
    });

    it("a commit that closes the phase in the deadline's last second still leaves time to promote", async () => {
      drv.jury = H.jury(8, 5, 4, 3, 300);
      const r = await drv.request();
      const t0 = (await ethers.provider.getBlock(r.rcpt.blockNumber)).timestamp;
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3]);
      await time.setNextBlockTimestamp(t0 + 300);                             // the deadline itself
      await drv.commit(r, 4, V(600_000));                                     // M-th commit after T+: closes
      expect(r.closing).to.equal(true);
      await drv.promote(r);                                                   // C+2 is past the old deadline
      for (const s of drv.promotedSlots(r).slice(0, 4)) await drv.reveal(r, s);
      expect((await agg.getEvaluation(r.aggId))[2]).to.equal(true);
    });

    it("failed at reveal: promoted non-revealers lose 500 (blocked), revealers gain 20 timeliness and no quality", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5]);
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      for (const s of prom.slice(0, 2)) await drv.reveal(r, s);
      await time.increase(301);
      await drv.settle(r);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (const s of prom.slice(0, 2)) expect(await score(r.slots[s])).to.deep.equal([520, 500]);
      for (const s of prom.slice(2)) expect((await keeper.getArbiter(r.slots[s].arb.key)).offenses).to.equal(1n);
    });

    it("freezing cannot dodge a silent block: a committed arbiter that ignores its health call is still charged", async () => {
      const r = await drv.request();
      await commitAll(r, [0, 1, 2, 3, 4, 5]);
      await drv.promote(r);
      const prom = drv.promotedSlots(r);
      await drv.answerAll(r, prom.slice(2));                                  // the silent ones never answer
      for (const s of prom.slice(0, 2)) await drv.reveal(r, s);
      await time.increase(301);
      for (const s of prom.slice(2)) expect(await keeper.isFrozen(r.slots[s].arb.key)).to.equal(true);
      await drv.settle(r);
      for (const s of prom.slice(2)) expect((await keeper.getArbiter(r.slots[s].arb.key)).offenses).to.equal(1n);
    });

    it("credit covers only what msg.value does not, and an overpayment returns to credit", async () => {
      await drv.fullRound();
      const required = await H.quote(agg, H.MAX_FEE, 0, false);
      const c0 = await agg.ethOwed(requester.address);
      expect(c0 > 0n && c0 < required).to.equal(true);                        // the refund and draw reward
      const x = await drv.requestOnly({ value: required });                   // fully paid: credit untouched
      expect(await agg.ethOwed(requester.address)).to.equal(c0);
      expect((await agg.getRoundInfo(x.aggId))[4]).to.equal(required);
      await drv.requestOnly({ value: required + 1000n });                     // overpaid: the excess becomes credit
      expect(await agg.ethOwed(requester.address)).to.equal(c0 + 1000n);
      await drv.requestOnly({ value: required - c0 });                        // short by exactly the credit
      expect(await agg.ethOwed(requester.address)).to.equal(1000n);
      await expect(drv.requestOnly({ value: required - 1001n })).to.be.revertedWithCustomError(agg, "InsufficientPayment");
    });

    it("the settlement queue walk is bounded even past many already-settled rounds", async () => {
      await keeper.setPoints([20, 50, 200, 500, 0, 500, 1000]);               // no -400, so the pool stays eligible
      await keeper.setTiming(24 * 3600, 90 * 24 * 3600, 3600, 7 * 24 * 3600); // and unfrozen
      const rs = [];
      for (let i = 0; i < 20; i++) rs.push(await drv.request());
      await time.increase(301);
      for (const r of rs) await agg.settle(r.aggId);                          // 20 holes at the head of the queue
      const h0 = await agg.settleHead();
      await drv.requestOnly();
      expect((await agg.settleHead()) - h0).to.equal(16n);                    // 8 steps per round it may settle (2)
      await drv.requestOnly();
      expect((await agg.settleHead()) - h0).to.equal(20n);
    });

    it("keeps the ETH solvency invariant: balance == sum of ethOwed once rounds are settled", async () => {
      for (let i = 0; i < 3; i++) await drv.fullRound();
      const [deployer] = await ethers.getSigners();
      const payees = new Set([requester.address, deployer.address, ethers.ZeroAddress]);          // deployer calls promote()
      for (const a of arbs) payees.add(await a.op.owner());
      let owed = 0n;
      for (const p of payees) owed += await agg.ethOwed(p);
      expect(await ethers.provider.getBalance(agg.target)).to.equal(owed);
    });
  });

  describe("gas griefing", () => {
    it("operators that gate on the keeper (as ArbiterOperator does) refuse an unapproved aggregator", async () => {
      const r = await drv.request();
      expect(Object.keys(r.slots).length).to.equal(6);                       // approved: all dispatched
      const other = await (await ethers.getContractFactory("ReputationKeeper")).deploy(core.token.target);
      for (const a of arbs) await a.op.setGate(other.target);                // a keeper list without this aggregator
      const x = await drv.requestOnly();
      await mine(1);
      const rc = await (await agg.drawJury(x.aggId, { gasLimit: 16_000_000 })).wait();
      expect(eventArgs(rc, "SlotSkipped").length).to.equal(6);               // every operator refused
    });

    it("an arbiter whose operator burns all gas only loses its own slot", async () => {
      for (const a of arbs.slice(0, 6)) await a.op.setBomb(true);
      const r = await drv.requestOnly();
      const rc = await drv.draw(r);
      const bombed = new Set(arbs.slice(0, 6).map((a) => a.key));
      const keys = await juryKeys(r);
      const skipped = eventArgs(rc, "SlotSkipped").map((a) => Number(a.pollIndex));
      expect(skipped.length).to.be.greaterThan(0);
      for (let i = 0; i < 6; i++) expect(skipped.includes(i)).to.equal(bombed.has(keys[i]));
      expect(Number(rc.gasUsed)).to.be.lessThan(16_000_000);
    });

    it("an operator whose owner() returns malformed data only loses its own slot", async () => {
      for (const a of arbs.slice(0, 6)) {
        const o = await a.op.owner();
        await ethers.provider.send("hardhat_setBalance", [o, "0x1000000000000000000"]);
        await ethers.provider.send("hardhat_impersonateAccount", [o]);
        await a.op.connect(await ethers.getSigner(o)).setShortOwner(true);
      }
      const r = await drv.requestOnly();
      const rc = await drv.draw(r);
      const bad = new Set(arbs.slice(0, 6).map((a) => a.key));
      const keys = await juryKeys(r);
      const skipped = eventArgs(rc, "SlotSkipped").map((a) => Number(a.pollIndex));
      for (let i = 0; i < 6; i++) expect(skipped.includes(i)).to.equal(bad.has(keys[i]));
    });

    it("an owner() that returns a huge buffer costs the draw at most its stipend (no return-data bomb)", async () => {
      const r1 = await drv.requestOnly();
      const snap = await takeSnapshot();
      const g0 = Number((await drv.draw(r1)).gasUsed);
      await snap.restore();
      for (const a of arbs) await a.op.setBigOwner(true);
      const rc = await drv.draw(r1);
      expect(eventArgs(rc, "SlotSkipped").length).to.equal(0);               // the first word is a valid owner
      expect(Number(rc.gasUsed) - g0).to.be.lessThan(6 * 30_000);
    });

    it("a drawer cannot pick a gas limit that skips slots: the draw either reverts or dispatches all K", async () => {
      const r = await drv.requestOnly();
      await mine(1);
      const snap = await takeSnapshot();
      const full = Number((await (await agg.drawJury(r.aggId, { gasLimit: 16_000_000 })).wait()).gasUsed);
      await snap.restore();
      for (let f = 0.3; f < 1.0; f += 0.05) {
        const s2 = await takeSnapshot();
        try {
          const rc = await (await agg.drawJury(r.aggId, { gasLimit: Math.floor(full * f) })).wait();
          expect(eventArgs(rc, "SlotSkipped").length).to.equal(0);
          expect(H.oracleRequests(rc).length).to.equal(6);
        } catch (e) {
          expect(String(e.message)).to.match(/OutOfGas|out of gas|reverted/i);
        }
        await s2.restore();
      }
    });

    it("a settler cannot pick a gas limit that skips the keeper call", async () => {
      const r = await drv.fullRound({ settle: false });
      await time.increase(301);
      const snap = await takeSnapshot();
      const full = Number((await (await agg.settle(r.aggId, { gasLimit: 16_000_000 })).wait()).gasUsed);
      await snap.restore();
      for (let f = 0.3; f < 1.0; f += 0.05) {
        const s2 = await takeSnapshot();
        try {
          const rc = await (await agg.settle(r.aggId, { gasLimit: Math.floor(full * f) })).wait();
          expect(eventArgs(rc, "SlotSkipped").length).to.equal(0);
        } catch (e) {
          expect(String(e.message)).to.match(/OutOfGas|out of gas|reverted/i);
        }
        await s2.restore();
      }
    });
  });

  describe("commit format (items 4 and 5)", () => {
    const revealed = async (r, sl) => ((await flags(r, sl)) & 8) !== 0;   // S_REVEALED
    // every juror commits `word(slot)` in place of the driver's commit, then the jury is promoted
    async function commitWith(word) {
      const r = await drv.request();
      await drv.answerAll(r);
      for (let sl = 0; sl < 6; sl++) {
        const s = r.slots[sl];
        s.reveal = V(600_000);
        s.salt = (1n << 127n) | BigInt(sl + 1);
        await H.fulfil(s.commitReq, s.arb.node, [word(r, s)], "");
      }
      await drv.promote(r);
      return r;
    }

    it("the commit is keccak256(aggId, operator, response, salt) in full, and the reveal request carries all 32 bytes", async () => {
      const r = await commitWith((r, s) => H.commitWord(r.aggId, s.arb.opAddr, s.reveal, s.salt));
      for (const sl of drv.promotedSlots(r)) {
        const s = r.slots[sl];
        const want = ethers.toBeHex(H.commitWord(r.aggId, s.arb.opAddr, s.reveal, s.salt), 32);
        expect((await agg.getSlot(r.aggId, sl)).commitHash).to.equal(want);
        const tag = ethers.hexlify(ethers.toUtf8Bytes(`2:${want.slice(2)}`)).slice(2);
        expect(s.revealReq.data.includes(tag)).to.equal(true);
      }
      const sl = drv.promotedSlots(r)[0];
      await drv.reveal(r, sl);
      expect(await revealed(r, sl)).to.equal(true);
    });

    it("parseCidSalt matches a reference on 600 inputs, and the hex encoders match ethers", async () => {
      const L = await (await ethers.getContractFactory("AggregatorLib")).deploy();
      let st = 0x2545f491;                                                      // mulberry32
      const rnd = () => { st = (st + 0x6d2b79f5) | 0; let t = Math.imul(st ^ (st >>> 15), 1 | st);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const pick = (str) => str[Math.floor(rnd() * str.length)];
      const HEX = "0123456789abcdefABCDEF", ODD = ":/@`gG~ Qz\x7f.";
      const ref = (str) => {
        const i = str.lastIndexOf(":");
        if (str.length < 34 || i < 0 || str.length - i - 1 !== 32) return [false, "", 0n];
        const t = str.slice(i + 1);
        if (!/^[0-9a-fA-F]{32}$/.test(t)) return [false, "", 0n];
        return [true, str.slice(0, i), BigInt("0x" + t)];
      };
      const kinds = { valid: 0, invalid: 0 };
      for (let k = 0; k < 600; k++) {
        const cidLen = Math.floor(rnd() * 70);
        let cid = ""; for (let i = 0; i < cidLen; i++) cid += pick("QmXyz0123456789" + (rnd() < 0.2 ? ODD : ""));
        let salt = ""; const sl = rnd() < 0.7 ? 32 : Math.floor(rnd() * 40);
        for (let i = 0; i < sl; i++) salt += rnd() < 0.01 ? pick(ODD) : pick(HEX);
        let str = rnd() < 0.9 ? `${cid}:${salt}` : cid + salt;
        if (rnd() < 0.05) str = str.slice(0, Math.floor(rnd() * str.length));
        const want = ref(str);
        const got = await L.parseCidSalt(str);
        expect([got[0], got[1], got[2]]).to.deep.equal(want);
        kinds[want[0] ? "valid" : "invalid"]++;
      }
      expect(kinds.valid).to.be.above(200);
      expect(kinds.invalid).to.be.above(150);
      // boundary: a 1-char CID, the largest salt, and an extra colon inside the CID
      expect((await L.parseCidSalt("Q:" + "f".repeat(32)))[2]).to.equal(2n ** 128n - 1n);
      expect((await L.parseCidSalt("a:b:" + "0".repeat(32)))[1]).to.equal("a:b");
      expect((await L.parseCidSalt(":" + "0".repeat(32)))[0]).to.equal(false);
      for (let k = 0; k < 20; k++) {
        const x = ethers.hexlify(ethers.randomBytes(32));
        expect(await L.bytes32ToHexLower(x)).to.equal(x.slice(2));
        expect(await L.bytes32ToHex(x)).to.equal(x);
      }
      expect(await L.bytes32ToHex(ethers.ZeroHash)).to.equal(ethers.ZeroHash);
    });

    it("a commit made for another round cannot be revealed (no reuse across rounds)", async () => {
      const other = ethers.zeroPadValue(ethers.toBeHex(999), 32);
      const r = await commitWith((r, s) => H.commitWord(other, s.arb.opAddr, s.reveal, s.salt));
      for (const sl of drv.promotedSlots(r)) {
        await drv.reveal(r, sl);
        expect(await revealed(r, sl)).to.equal(false);
      }
    });

    it("v1's format is refused: a truncated SHA-256 commit, and an 80-bit (20 hex) salt", async () => {
      const v1Word = (r, s) => BigInt(ethers.dataSlice(ethers.sha256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256[]", "uint256"], [s.arb.opAddr, s.reveal, s.salt])), 0, 16));
      const r = await commitWith(v1Word);
      for (const sl of drv.promotedSlots(r)) {
        await drv.reveal(r, sl);
        expect(await revealed(r, sl)).to.equal(false);
      }
      // correct v2 commits with small salts: written as 20 hex chars the reveal is ignored, as 32 counted
      // (one answer per request: the operator consumes the request either way)
      const r2 = await commitWith((r, s) => H.commitWord(r.aggId, s.arb.opAddr, s.reveal, BigInt(s.slot + 1)));
      const [a, b] = drv.promotedSlots(r2);
      const salt = (sl) => BigInt(sl) + 1n;
      await H.fulfil(r2.slots[a].revealReq, r2.slots[a].arb.node, V(600_000), `QmJ:${salt(a).toString(16).padStart(20, "0")}`);
      expect(await revealed(r2, a)).to.equal(false);
      await H.fulfil(r2.slots[b].revealReq, r2.slots[b].arb.node, V(600_000), `QmJ:${H.saltHex(salt(b))}`);
      expect(await revealed(r2, b)).to.equal(true);
    });
  });

  describe("fee floor (item 8)", () => {
    const B = 3n, Pn = 3n, Kn = 6n;   // the default bonus multiplier, and H.JURY's P and K
    const basePaid = (rcpt) => eventArgs(rcpt, "BasePayment").map((a) => a.amount);

    it("maxTotalFee: a floor at or below the ceiling changes nothing; above it, jurors are sized on the floor and rewards on the ceiling", async () => {
      const plain = await H.quote(agg, H.MAX_FEE, 0, false);
      expect(plain).to.equal(H.MAX_FEE * (Kn + B * Pn + 3n));                  // + draw (2) and promote (1) rewards
      expect(await H.quote(agg, H.MAX_FEE, H.MAX_FEE, false)).to.equal(plain);
      expect(await H.quote(agg, H.MAX_FEE, H.MAX_FEE / 2n, false)).to.equal(plain);
      const f = 10n * H.MAX_FEE;                                               // above the ceiling: allowed
      expect(await H.quote(agg, H.MAX_FEE, f, false)).to.equal(f * (Kn + B * Pn) + H.MAX_FEE * 3n);
      // the global ceiling applies to the requester's ceiling, never to the floor
      await agg.setParams(3, 2, 250_000, 30_000, H.MAX_FEE / 2n);
      expect(await H.quote(agg, H.MAX_FEE, f, false)).to.equal(f * (Kn + B * Pn) + (H.MAX_FEE / 2n) * 3n);
    });

    it("a floor above every posted fee (and above the ceiling) pays each juror the floor and each cluster member B x the floor; the rest is refunded", async () => {
      const f = 10n * H.MAX_FEE;
      const required = await H.quote(agg, H.MAX_FEE, f, false);
      const c0 = await agg.ethOwed(requester.address);
      const r = await drv.fullRound({ request: { minFee: f, value: required } });
      expect(basePaid(r.rcpt)).to.deep.equal(Array(6).fill(f));
      for (let i = 0; i < 6; i++) {
        expect((await agg.getSlot(r.aggId, i)).fee).to.equal(f);
        expect((await keeper.getArbiter(r.slots[i].arb.key)).fee).to.equal(H.FEE);   // posted fee untouched
      }
      const [phase, , , , received, base, bonus, reward] = await agg.getRoundInfo(r.aggId);
      expect(phase).to.equal(7n);
      expect([received, base, bonus, reward]).to.deep.equal([required, Kn * f, Pn * B * f, 3n * H.MAX_FEE]);
      // the requester drew within 30 s (2 x the ceiling) and gets back everything not paid out
      expect((await agg.ethOwed(requester.address)) - c0).to.equal(required - Kn * f - Pn * B * f - H.MAX_FEE);
    });

    it("a floor between posted fees: an arbiter above it is paid its own fee, one below is paid the floor", async () => {
      const f = 3n * 10n ** 13n, hi = 5n * 10n ** 13n;                        // FEE = 1e13 < f < hi <= ceiling
      for (const a of arbs.slice(0, 6)) await keeper.setFee(a.key, hi);
      await mine(1);
      const r = await drv.request({ minFee: f });
      const paid = basePaid(r.rcpt);
      for (let i = 0; i < 6; i++) {
        const posted = (await keeper.getArbiter(r.slots[i].arb.key)).fee;
        expect(paid[i]).to.equal(posted > f ? posted : f);
        expect((await agg.getSlot(r.aggId, i)).fee).to.equal(paid[i]);
      }
    });

    it("rejects a floor whose escrow would not fit in 88 bits (the narrowest credited total)", async () => {
      const f = 2n ** 88n / 15n;                                               // x (K + B x P) = 15, plus the rewards, passes 2^88
      await expect(agg.connect(requester).requestAIEvaluationWithApproval(["Qm"], "", 500, H.MAX_FEE, f, H.BASE_COST, 5, 1, false, H.JURY))
        .to.be.revertedWithCustomError(agg, "BadInput");
    });

    it("keeps the ETH solvency invariant with a floor", async () => {
      for (let i = 0; i < 2; i++) await drv.fullRound({ request: { minFee: 7n * H.MAX_FEE } });
      const [deployer] = await ethers.getSigners();
      const payees = new Set([requester.address, deployer.address, ethers.ZeroAddress]);
      for (const a of arbs) payees.add(await a.op.owner());
      let owed = 0n;
      for (const p of payees) owed += await agg.ethOwed(p);
      expect(await ethers.provider.getBalance(agg.target)).to.equal(owed);
    });
  });

  describe("the arbiter pool (forfeits paid to random registered arbiters)", () => {
    const POOL = ethers.ZeroAddress;
    async function forfeit() {                                                // a round cancelled unsealed
      const x = await drv.requestOnly();
      await mine(8200);
      await agg.connect(stranger).cancelUnsealed(x.aggId);
      return agg.ethOwed(POOL);
    }

    it("each draw pays an eighth of the pool, at most its own base fees, to one registered arbiter's payee; nobody can withdraw the pool", async () => {
      const p0 = await forfeit();
      expect(p0 > 0n).to.equal(true);
      const min = (a, b) => (a < b ? a : b);
      const owners = new Set(await Promise.all(arbs.map((a) => a.op.owner())));
      const r = await drv.request();
      const base = (await agg.getRoundInfo(r.aggId)).baseFees;
      const paid = eventArgs(r.rcpt, "PoolPayment");
      expect(paid.length).to.equal(1);
      const s1 = min(p0 / 8n, base);
      expect(paid[0].amount).to.equal(s1);
      expect(owners.has(paid[0].payee)).to.equal(true);
      expect(await agg.ethOwed(POOL)).to.equal(p0 - s1);
      const r2 = await drv.request();                                          // the next draw: an eighth of the rest
      const base2 = (await agg.getRoundInfo(r2.aggId)).baseFees;
      expect(eventArgs(r2.rcpt, "PoolPayment")[0].amount).to.equal(min((p0 - s1) / 8n, base2));
      await expect(agg.withdrawEthFor(POOL)).to.be.revertedWithCustomError(agg, "NotAuthorized");
    });

    it("the keeper picks only available arbiters, in two tries at most; with none the pool waits", async () => {
      expect(await keeper.registryLength()).to.equal(12n);
      const seed = (i) => ethers.id(`seed ${i}`);
      const owners = new Set(await Promise.all(arbs.map((a) => a.op.owner())));
      for (let i = 0; i < 4; i++) expect(owners.has(await keeper.poolPayee(seed(i)))).to.equal(true);
      for (const a of arbs) await keeper.setPaused(a.key, true);
      for (let i = 0; i < 4; i++) expect(await keeper.poolPayee(seed(i))).to.equal(POOL);
    });

    it("a completed exit removes the arbiter from the registry", async () => {
      const a0 = arbs[0];
      await keeper.requestExit(a0.key);
      await time.increase(2 * 86400 + 1);
      await keeper.completeExit(a0.key);
      expect(await keeper.registryLength()).to.equal(11n);
      for (const a of arbs.slice(1)) await keeper.setPaused(a.key, true);     // only a0 could win, and it left
      for (let i = 0; i < 4; i++) expect(await keeper.poolPayee(ethers.id(`s${i}`))).to.equal(POOL);
    });
  });

  describe("the request's jury (item 15)", () => {
    const ask = (j, value) => agg.connect(requester).requestAIEvaluationWithApproval(
      ["Qm"], "", 500, H.MAX_FEE, 0, H.BASE_COST, 5, 1, false, j, { value: value ?? 10n ** 17n });
    const lib = () => core.aggLib;

    it("refuses an unordered jury, P = 1 with N > 1, N above 40, and a timeout not above T+ or above maxTimeout", async () => {
      for (const j of [H.jury(6, 5, 4, 1), H.jury(4, 5, 4, 3), H.jury(6, 5, 6, 3), H.jury(6, 5, 4, 5), H.jury(0, 0, 0, 0),
                       H.jury(6, 5, 4, 3, 155), H.jury(6, 5, 4, 3, 3601), H.jury(50, 45, 41, 17, 600)]) {
        await expect(ask(j)).to.be.revertedWithCustomError(lib(), "BadJury");
      }
      await ask(H.jury(1, 1, 1, 1, 300));                                       // one arbiter, one answer
      await ask(H.jury(50, 45, 40, 17, 600));                                   // N = 40 is the most
    });

    it("refuses K above maxJury or above the keeper's shortlist, so a big jury never fills with repeats", async () => {
      await agg.setLimits(8, 3600, 155);
      await expect(ask(H.jury(9, 5, 4, 3))).to.be.revertedWithCustomError(lib(), "BadJury");
      await ask(H.jury(8, 5, 4, 3));
      await agg.setLimits(50, 3600, 155);
      await keeper.setSelection(7, 400, 3);                                    // the shortlist below the jury
      await expect(ask(H.jury(8, 5, 4, 3))).to.be.revertedWithCustomError(lib(), "BadJury");
      await ask(H.jury(7, 5, 4, 3));
    });

    it("each round keeps the jury it was requested with: getJury, its M+, its N-th reveal and its own deadline", async () => {
      const small = await drv.request();
      drv.jury = H.jury(8, 5, 4, 3, 400);
      const medium = await drv.request();
      expect(await agg.getJury(small.aggId)).to.deep.equal([6n, 5n, 4n, 3n, 300n]);
      expect(await agg.getJury(medium.aggId)).to.deep.equal([8n, 5n, 4n, 3n, 400n]);
      expect(Object.keys(medium.slots)).to.have.length(8);
      const t = BigInt((await ethers.provider.getBlock(medium.rcpt.blockNumber)).timestamp);
      expect((await agg.getRoundInfo(medium.aggId)).deadline).to.equal(t + 400n);
      expect(await agg.getJury(ethers.zeroPadValue("0x99", 32))).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
    });

    it("no request may have a timeout above one day, whatever maxTimeout says", async () => {
      await agg.setLimits(50, 30 * 86400, 155);                                 // accepted, but requests stay capped
      await expect(ask(H.jury(6, 5, 4, 3, 86401))).to.be.revertedWithCustomError(lib(), "BadJury");
      await ask(H.jury(6, 5, 4, 3, 86400));
    });

    it("a round keeps the T+ of its request: raising T+ before the draw cannot push the window past the deadline", async () => {
      const r = await drv.requestOnly();                                        // timeout 300, checked against T+ 155
      expect((await agg.getRoundInfo(r.aggId)).windowEnd).to.equal(0n, "no window before the draw");
      await agg.setLimits(50, 3600, 400);                                       // T+ above this round's timeout
      await drv.draw(r);
      const info = await agg.getRoundInfo(r.aggId);
      const t = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      expect(info.windowEnd).to.equal(t + 155n);
      expect(info.windowEnd < info.deadline).to.equal(true);
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4]);                                      // M, below M+
      await time.increase(156);
      await drv.closeCommits(r);                                                // closable: the round is not stranded
      expect((await agg.getRoundInfo(r.aggId)).phase).to.equal(4n);
    });

    it("setLimits: a jury of at least 1, T+ above 0 and below the longest timeout", async () => {
      await expect(agg.setLimits(0, 3600, 155)).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await expect(agg.setLimits(50, 155, 155)).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await expect(agg.setLimits(50, 3600, 0)).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await expect(agg.connect(requester).setLimits(50, 3600, 155)).to.be.revertedWithCustomError(agg, "OwnableUnauthorizedAccount");
      await agg.setLimits(50, 3600, 120);
      expect([await agg.maxJury(), await agg.maxTimeout(), await agg.tPlus()]).to.deep.equal([50n, 3600n, 120n]);
    });
  });

  describe("clustering", () => {
    // ScoringLib's loops are hand-written, so every function is checked against plain JavaScript
    // references written from the stated rules (and v1's AggregatorLib where they must agree), on
    // reproducible inputs built for ties, duplicates and extremes. The generator is mulberry32
    // (32-bit integer arithmetic): a float LCG here once returned 0 for rnd(8) in 99.6% of calls.
    function mulberry32(a) {
      return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const R = mulberry32(0xc0ffee);
    const rnd = (n) => Math.floor(R() * n);
    const MAX = 10n ** 34n;
    const dist = (a, b) => a.reduce((s, x, k) => { const t = x > b[k] ? x - b[k] : b[k] - x; return s + t * t; }, 0n);
    // one-value vectors: P consecutive values in (value, position) order with the smallest
    // P sum(x^2) - (sum x)^2, the first window on ties
    function refWindow(v, P) {
      const n = v.length;
      const o = [...Array(n).keys()].sort((a, b) => (v[a][0] < v[b][0] ? -1 : v[a][0] > v[b][0] ? 1 : a - b));
      let best = null, start = 0;
      for (let s = 0; s + P <= n; s++) {
        const w = o.slice(s, s + P).map((i) => v[i][0]);
        const sc = BigInt(P) * w.reduce((t, x) => t + x * x, 0n) - w.reduce((t, x) => t + x, 0n) ** 2n;
        if (best === null || sc < best) { best = sc; start = s; }
      }
      const out = Array(n).fill(false); for (const i of o.slice(start, start + P)) out[i] = true; return out;
    }
    // longer vectors: each position plus its P - 1 nearest (ties to the earlier position); the group
    // with the smallest pairwise sum, the first centre on ties
    function refNN(v, P) {
      const n = v.length; let best = null, grp = null;
      for (let c = 0; c < n; c++) {
        const g = [...Array(n).keys()].sort((a, b) => { const x = dist(v[c], v[a]), y = dist(v[c], v[b]); return x < y ? -1 : x > y ? 1 : a - b; }).slice(0, P);
        let sc = 0n; for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) sc += dist(v[g[i]], v[g[j]]);
        if (best === null || sc < best) { best = sc; grp = g; }
      }
      const out = Array(n).fill(false); for (const i of grp) out[i] = true; return out;
    }
    function refCluster(v, P) {
      const n = v.length; if (P > n) P = n; if (P < 2) P = 2;
      return v[0].length === 1 ? refWindow(v, P) : refNN(v, P);
    }
    const pairSum = (v, inC) => { const g = v.filter((_, i) => inC[i]); let t = 0n; for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) t += dist(g[a], g[b]); return t; };
    function bruteBest(v, P) {          // the smallest pairwise sum over every P-subset (small n)
      let best = null;
      const rec = (start, g) => {
        if (g.length === P) { const t = pairSum(v, v.map((_, i) => g.includes(i))); if (best === null || t < best) best = t; return; }
        for (let i = start; i < v.length; i++) rec(i + 1, [...g, i]);
      };
      rec(0, []); return best;
    }
    // the most common length, ties to the LONGER; truncate or zero-fill
    function refNormalize(v) {
      let modal = 0, cnt = 0;
      for (const x of v) { const c = v.filter((y) => y.length === x.length).length; if (c > cnt || (c === cnt && x.length > modal)) { cnt = c; modal = x.length; } }
      return v.map((x) => Array.from({ length: modal }, (_, j) => (j < x.length ? x[j] : 0n)));
    }
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const refTieOrder = (seed, ids) => {
      const key = ids.map((id) => BigInt(ethers.keccak256(coder.encode(["bytes32", "uint256"], [seed, id]))) >> 8n);   // top 248 bits
      return [...ids.keys()].sort((a, b) => (key[a] < key[b] ? -1 : key[a] > key[b] ? 1 : a - b));
    };
    function refAggregateCluster(v, P, seed, ids) {      // the cluster under the seeded tie order
      const perm = refTieOrder(seed, ids);
      const c = refCluster(perm.map((i) => v[i]), P);
      const out = Array(v.length).fill(false); perm.forEach((p, k) => { if (c[k]) out[p] = true; }); return out;
    }
    const median = (a) => { const t = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); const n = t.length; return n % 2 ? t[(n - 1) / 2] : (t[n / 2 - 1] + t[n / 2]) / 2n; };
    const dev = (x, med) => med.reduce((m, mj, j) => { const xj = j < x.length ? x[j] : 0n; const t = xj > mj ? xj - mj : mj - xj; return t > m ? t : m; }, 0n);
    const klass = (d, spread) => (d * 2n <= spread * 3n ? 1 : d <= spread * 3n ? 2 : 3);
    function refClassify(v, floor) {
      const med = v[0].map((_, j) => median(v.map((x) => x[j])));
      const d = v.map((x) => dev(x, med));
      let spread = (median(d) * 14826n) / 10000n; if (spread < floor) spread = floor;
      return { codes: d.map((x) => klass(x, spread)), med, spread };
    }
    const GENS = {
      ties: (n, len) => Array.from({ length: n }, () => Array.from({ length: len }, () => BigInt(rnd(4)))),
      grid: (n, len) => Array.from({ length: n }, () => Array.from({ length: len }, () => BigInt(rnd(3) * 500_000))),
      uniform: (n, len) => Array.from({ length: n }, () => Array.from({ length: len }, () => BigInt(rnd(1_000_001)))),
      pair: (n, len) => Array.from({ length: n }, () => { const x = BigInt(rnd(1_000_001)); return [x, 1_000_000n - x, ...Array(Math.max(0, len - 2)).fill(0n)].slice(0, len); }),
      dups: (n, len) => { const b = Array.from({ length: len }, () => BigInt(rnd(1_000_001))); return Array.from({ length: n }, () => (rnd(3) ? b.slice() : b.map(() => BigInt(rnd(1_000_001))))); },
      extremes: (n, len) => Array.from({ length: n }, () => Array.from({ length: len }, () => (rnd(2) ? MAX : 0n))),
      nearMax: (n, len) => Array.from({ length: n }, () => Array.from({ length: len }, () => MAX - BigInt(rnd(3)))),
    };
    const seedOf = (t) => ethers.keccak256(ethers.toUtf8Bytes(`round ${t}`));

    it("bestCluster and classify match the references (v1 at P = 2 for vectors, brute force for one value)", async () => {
      const { scoring, aggLib } = core;
      const names = Object.keys(GENS);
      let nd = 0, oneD = 0, v1checks = 0, brute = 0;
      for (let t = 0; t < 400; t++) {
        const n = 2 + rnd(t < 250 ? 9 : 26);
        const len = [1, 1, 2, 2, 3, 5, 20][rnd(7)];
        const P = rnd(n + 3);                                          // 0, 1, 2..n and past n
        const g = names[t % names.length];
        const v = GENS[g](n, len);
        const what = `case ${t} ${g} n=${n} len=${len} P=${P}`;
        const got = [...(await scoring.bestCluster(v, P))];
        expect(got, what).to.deep.equal(refCluster(v, P));
        expect(got.filter(Boolean).length, what).to.equal(Math.max(2, Math.min(P, n)));
        if (len === 1) {
          oneD++;
          if (n <= 9) { brute++; expect(pairSum(v, got), `${what} exact`).to.equal(bruteBest(v, Math.max(2, Math.min(P, n)))); }
        } else {
          nd++;
          if (P <= 2) { v1checks++; expect(got.map((b) => (b ? 1n : 0n)), `${what} v1`).to.deep.equal(await aggLib.findBestCluster(v, v.map((_, i) => i), P)); }
        }
        const floor = BigInt([0, 1, 30_000][rnd(3)]);
        const c = await scoring.classify(v, floor);
        const rc = refClassify(v, floor);
        expect([...c.codes].map(Number), `${what} codes`).to.deep.equal(rc.codes);
        expect([...c.med], `${what} median`).to.deep.equal(rc.med);
        expect(c.spread, `${what} spread`).to.equal(rc.spread);
        const late = Array.from({ length: [1, len, len + 2][rnd(3)] }, () => BigInt(rnd(1_000_001)));   // any length
        expect(Number(await scoring.classifyOne(late, rc.med, rc.spread)), `${what} late`).to.equal(klass(dev(late, rc.med), rc.spread));
      }
      // the inputs really cover both rules
      expect(nd).to.be.greaterThan(200);
      expect(oneD).to.be.greaterThan(80);
      expect(v1checks).to.be.greaterThan(10);
      expect(brute).to.be.greaterThan(40);
    });

    it("aggregate: mixed lengths 1..20 (modal ties to the longer), the seeded tie order, mean and classes", async () => {
      const { scoring } = core;
      let mixed = 0, tied = 0;
      for (let t = 0; t < 150; t++) {
        const n = 1 + rnd(27);
        const L = [1 + rnd(20), 1 + rnd(20), 1 + rnd(20)];
        const v = Array.from({ length: n }, () => Array.from({ length: L[rnd(3)] }, () => (rnd(10) ? BigInt(rnd(t % 3 ? 1_000_001 : 3)) : MAX)));
        const P = n === 1 ? 1 : 2 + rnd(n - 1);
        const ids = [...Array(n).keys()].map(() => rnd(50));
        const seed = seedOf(t);
        const w = refNormalize(v);
        if (new Set(v.map((x) => x.length)).size > 1) mixed++;
        const counts = {}; for (const x of v) counts[x.length] = (counts[x.length] || 0) + 1;
        const top = Math.max(...Object.values(counts)); if (Object.values(counts).filter((c) => c === top).length > 1) tied++;
        const a = await scoring.aggregate(v, P, 30_000n, seed, ids);
        const inC = n === 1 ? [true] : refAggregateCluster(w, P, seed, ids);
        const cnt = BigInt(inC.filter(Boolean).length);
        expect([...a.inCl], `case ${t} cluster`).to.deep.equal(inC);
        expect([...a.agg], `case ${t} mean`).to.deep.equal(w[0].map((_, j) => w.reduce((s, x, i) => (inC[i] ? s + x[j] : s), 0n) / cnt));
        const rc = refClassify(w, 30_000n);
        expect([...a.codes].map(Number), `case ${t} codes`).to.deep.equal(rc.codes);
        expect(a.spread, `case ${t} spread`).to.equal(rc.spread);
        expect([...(await scoring.tieOrder(seed, ids))].map(Number), `case ${t} order`).to.deep.equal(refTieOrder(seed, ids));
      }
      expect(mixed).to.be.greaterThan(100);
      expect(tied).to.be.greaterThan(10);
    });

    it("overflow bounds: 255 one-value reveals at 0 / 1e34, and 20 coordinates at 0 / 1e34 with large P", async () => {
      const { scoring } = core;
      for (const n of [200, 255]) {
        const v = Array.from({ length: n }, () => [rnd(2) ? MAX : MAX - BigInt(rnd(2))]);
        for (const P of [2, 100, n]) expect([...(await scoring.bestCluster(v, P))]).to.deep.equal(refCluster(v, P));
        const a = await scoring.aggregate(v, n, 0n, seedOf(n), [...Array(n).keys()]);
        expect(a.agg[0]).to.equal(v.reduce((s, x) => s + x[0], 0n) / BigInt(n));
      }
      const v = Array.from({ length: 40 }, (_, i) => Array.from({ length: 20 }, () => (i % 2 ? MAX : 0n)));
      for (const P of [2, 21, 40]) expect([...(await scoring.bestCluster(v, P))]).to.deep.equal(refCluster(v, P));
    });

    it("edge cases: n = 1 / 2, P = 0 / 1 / n / past n, all equal, duplicates beyond P", async () => {
      const { scoring } = core;
      const a1 = await scoring.aggregate([[5n, 6n]], 1, 0, seedOf(0), [3]);
      expect([...a1.inCl]).to.deep.equal([true]);
      expect([...a1.agg]).to.deep.equal([5n, 6n]);
      await expect(scoring.bestCluster([[1n]], 2)).to.be.revertedWithCustomError(scoring, "NeedTwo");
      for (const P of [0, 1, 2, 3, 9]) expect([...(await scoring.bestCluster([[1n, 2n], [3n, 4n]], P))]).to.deep.equal([true, true]);
      const same = Array.from({ length: 7 }, () => [7n, 7n]);
      expect([...(await scoring.bestCluster(same, 3))]).to.deep.equal([true, true, true, false, false, false, false]);
      const same1 = Array.from({ length: 7 }, () => [7n]);
      expect([...(await scoring.bestCluster(same1, 3))]).to.deep.equal([true, true, true, false, false, false, false]);
      // a centre with more zero-distance duplicates before it than P is left out of its own group;
      // an earlier centre forms the same zero-score group first, so the result is unaffected
      const d = [[9n, 9n], [1n, 1n], [1n, 1n], [1n, 1n], [5n, 5n]];
      expect([...(await scoring.bestCluster(d, 2))]).to.deep.equal([false, true, true, false, false]);
    });

    it("limits: the library refuses values above 1e34 or more than 20; the owner can't set a floor above 1e34 (N above 40: the request's jury)", async () => {
      const { scoring } = core;
      await expect(scoring.bestCluster([[MAX + 1n], [0n], [1n]], 2)).to.be.revertedWithCustomError(scoring, "OutOfRange");
      await expect(scoring.classify([[0n, MAX + 1n], [0n, 0n]], 0)).to.be.revertedWithCustomError(scoring, "OutOfRange");
      await expect(scoring.bestCluster([Array(21).fill(0n), Array(21).fill(1n)], 2)).to.be.revertedWithCustomError(scoring, "OutOfRange");
      await expect(scoring.aggregate([[1n], [2n]], 2, 0, seedOf(1), [0])).to.be.revertedWithCustomError(scoring, "LengthMismatch");
      const p = [await agg.bonusMultiplier(), await agg.settlePerRequest(), await agg.dispatchGas(), 0, await agg.maxOracleFee()];
      await expect(agg.setParams(p[0], p[1], p[2], MAX + 1n, p[4])).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await agg.setParams(p[0], p[1], p[2], MAX, p[4]);
    });

    it("two identical extreme reveals do not pull the cluster away from an honest majority (item 10)", async () => {
      // greedy seeding took the identical pair as the cluster's start and added the honest reveals
      // nearest it; the nearest-neighbour cluster keeps the honest group
      const { scoring, aggLib } = core;
      const S = (p) => [BigInt(p) * 10_000n, 1_000_000n - BigInt(p) * 10_000n];   // p points on 0..100
      for (const P of [3, 4, 5]) {
        const honest = Array.from({ length: 2 * P - 3 }, (_, i) => S(78 + (i % 5)));   // N = 2P - 1 counted
        const v = [S(100), S(100), ...honest];
        const got = [...(await scoring.bestCluster(v, P))];
        expect(got[0] || got[1], `P = ${P}`).to.equal(false);
        const v1 = await aggLib.findBestCluster(v, v.map((_, i) => i), P);
        expect(v1[0] + v1[1], `P = ${P}: v1 kept the pair`).to.equal(2n);
      }
    });

    it("cluster ties follow a seeded order of the slots, not who revealed first", async () => {
      // models often give round numbers: 6 reveals of 800000 at P = 3. The same reveals in another
      // order, from the same slots, give the same members; and the members are not simply the first
      const { scoring } = core;
      const seed = seedOf(7);
      for (const v of [[[790_000n], [800_000n], [800_000n], [800_000n], [800_000n], [800_000n], [800_000n]],
                       [[790_000n, 210_000n], [800_000n, 200_000n], [800_000n, 200_000n], [800_000n, 200_000n], [800_000n, 200_000n], [800_000n, 200_000n], [800_000n, 200_000n]]]) {
        const slots = [4, 0, 5, 2, 6, 1, 3];
        const a = await scoring.aggregate(v, 3, 30_000n, seed, slots);
        const members = slots.filter((_, i) => a.inCl[i]).sort();
        const rev = [...v.keys()].reverse();
        const b = await scoring.aggregate(rev.map((i) => v[i]), 3, 30_000n, seed, rev.map((i) => slots[i]));
        expect(rev.map((i) => slots[i]).filter((_, k) => b.inCl[k]).sort()).to.deep.equal(members);
        expect(members.length).to.equal(3);
        expect(members).to.not.include(4);                        // the 790000 outlier
      }
    });

    it("exactly half one-value reveals cannot cut a two-outcome round to one outcome (modal ties go to the longer)", async () => {
      const { scoring } = core;
      const v = [[900_000n], [900_000n], [600_000n, 400_000n], [610_000n, 390_000n]];
      const a = await scoring.aggregate(v, 3, 30_000n, seedOf(2), [0, 1, 2, 3]);
      expect(a.agg.length).to.equal(2);
      // full round, Small jury (6/5/4/3): all 6 commit, so 5 are promoted with at least 2 of each kind;
      // two one-value reveals and two pairs are counted
      const round = await drv.request();
      await drv.answerAll(round);
      for (const sl of Object.keys(round.slots).map(Number)) await drv.commit(round, sl, sl % 2 ? [900_000n] : V(600_000 + sl * 1000));
      if (!round.closing) { await time.increase(Number(await agg.tPlus()) + 1); await drv.closeCommits(round); }
      await drv.promote(round);
      const prom = drv.promotedSlots(round);
      const odd = prom.filter((x) => x % 2), even = prom.filter((x) => x % 2 === 0);
      expect(odd.length >= 2 && even.length >= 2).to.equal(true);
      for (const x of [odd[0], even[0], odd[1], even[1]]) await drv.reveal(round, x);
      const [aggV, , valid] = await agg.getEvaluation(round.aggId);
      expect(valid).to.equal(true);
      expect(aggV.length).to.equal(2);
      expect((await agg.getOutcomeScores(round.aggId, 1))[1]).to.equal(true);
    });

    it("a one-number round: single-value reveals are counted and finalize with the exact 1-D cluster", async () => {
      // N = 4, P = 3: reveals 60, 61, 90 and 62 points; the cluster is 60, 61, 62 and the outlier is far
      const pts = [600_000n, 610_000n, 900_000n, 620_000n];
      const round = await drv.fullRound({ vectors: (sl) => [pts[sl % 4]], lateReveals: false, settle: false });
      const [scores, valid] = await agg.getOutcomeScores(round.aggId, 0);
      expect(valid).to.equal(true);
      expect(scores.length).to.equal(4);
      const [agg1] = await agg.getEvaluation(round.aggId);
      const counted = [...scores];
      const far = counted.reduce((m, x) => (x > m ? x : m), 0n);
      const inC = counted.filter((x) => x !== far);
      expect(agg1.length).to.equal(1);
      expect(agg1[0]).to.equal(inC.reduce((t, x) => t + x, 0n) / 3n);
      expect((await agg.getOutcomeScores(round.aggId, 1))[1]).to.equal(false);   // only outcome 0 exists
    });
  });

  describe("getRoundInfo timing fields (for consumers' views)", () => {
    // getRoundInfo returns, after the escrow fields: deadline, windowEnd, commits, requestTime
    const info = async (r) => {
      const v = await agg.getRoundInfo(r.aggId);
      return { phase: v[0], deadline: v[8], windowEnd: v[9], commits: v[10], requestTime: v[11] };
    };
    const blockTime = async (rcpt) => BigInt((await ethers.provider.getBlock(rcpt.blockNumber)).timestamp);

    it("requestTime is set at the request; deadline and windowEnd only from the draw", async () => {
      const r = await drv.requestOnly();
      let i = await info(r);
      expect(i.phase).to.equal(1n);
      expect(i.requestTime).to.equal(await blockTime(r.reqRcpt));
      expect(i.deadline).to.equal(0n);
      expect(i.windowEnd).to.equal(0n);
      expect(i.commits).to.equal(0n);

      const rc = await drv.draw(r);
      const t = await blockTime(rc);
      i = await info(r);
      expect(i.phase).to.equal(3n);
      expect(i.deadline).to.equal(t + 300n);                                  // H.JURY's timeout
      expect(i.windowEnd).to.equal(t + (await agg.tPlus()));
    });

    it("commits counts the commits received, and promote() extends the deadline to at least now + revealWindow", async () => {
      drv.jury = H.jury(6, 5, 4, 3, 200);
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1]);
      expect((await info(r)).commits).to.equal(2n);
      await commitAll(r, [2, 3, 4, 5]);                                       // the M+-th closes
      expect((await info(r)).phase).to.equal(4n);
      await time.increase(150);
      const rc = await drv.promote(r);
      const i = await info(r);
      expect(i.phase).to.equal(5n);
      expect(i.deadline).to.be.at.least((await blockTime(rc)) + (await agg.revealWindow()));
    });
  });
});
