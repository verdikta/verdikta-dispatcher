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

    it("an undrawn round never times out; unsealed past the 8,191-block history it goes to the treasury, never refunded", async () => {
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
      const t0 = await agg.ethOwed(deployer.address);                         // treasury = deployer
      const [, , , , received] = await agg.getRoundInfo(x.aggId);
      await agg.connect(stranger).cancelUnsealed(x.aggId);
      expect((await agg.ethOwed(deployer.address)) - t0).to.equal(received);
      expect(await agg.ethOwed(requester.address)).to.equal(0n);
      await expect(agg.cancelUnsealed(y.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");    // sealed, < 1 day
      await drv.draw(y, { waitBlocks: 0 });                                   // sealed: drawable any time
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

    it("a sealed round nobody could draw for a day goes to the treasury", async () => {
      const r = await drv.requestOnly();
      await mine(2);
      await agg.sealSeed(r.aggId);
      await expect(agg.cancelUnsealed(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");
      await time.increase(24 * 3600 + 1);
      const [deployer] = await ethers.getSigners();
      const t0 = await agg.ethOwed(deployer.address);
      const [, , , , received] = await agg.getRoundInfo(r.aggId);
      await agg.connect(stranger).cancelUnsealed(r.aggId);
      expect((await agg.ethOwed(deployer.address)) - t0).to.equal(received);
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
      await drv.requestOnly({ value: await agg.maxTotalFee(H.MAX_FEE, false) });    // settles r via the queue
      expect((await agg.getRoundInfo(r.aggId))[0]).to.equal(7n);              // PH_SETTLED
    });

    it("rejects a scaling factor that would not fit its uint16 field", async () => {
      const v = await agg.maxTotalFee(H.MAX_FEE, false);
      await expect(agg.connect(requester).requestAIEvaluationWithApproval(["Qm"], "", 500, H.MAX_FEE, H.BASE_COST, 65536, 1, false, { value: v }))
        .to.be.revertedWithCustomError(agg, "BadInput");
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
      await agg.setConfig(8, 5, 4, 3, 300, 155);                                   // Medium: M+ = 5 + ceil(3/2) = 7
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
      await agg.setConfig(8, 5, 4, 3, 1000, 155);                                  // Hardhat mines 1 s per block
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

    it("a closed phase that is never promoted fails without penalising anyone, and the requester gets no refund", async () => {
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4, 5, 6]);
      await time.increase(301);
      const before = await agg.ethOwed(requester.address);
      const rc = await drv.settle(r);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (let s = 0; s < 8; s++) expect(await score(r.slots[s])).to.deep.equal([500, 500]);
      expect(await agg.ethOwed(requester.address)).to.equal(before);     // withholding promote buys no refund
      const [deployer] = await ethers.getSigners();
      expect(eventArgs(rc, "RequesterRefunded")[0].requester).to.equal(deployer.address);   // treasury
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

    it("M commits but nobody closed the phase after T+: the round fails, nobody is charged, and the prepay goes to the treasury", async () => {
      await agg.setConfig(8, 5, 4, 3, 300, 155);
      const r = await drv.request();
      await drv.answerAll(r);
      await commitAll(r, [0, 1, 2, 3, 4]);                                    // M commits, before T+; nobody closes
      await time.increase(301);
      const [deployer] = await ethers.getSigners();
      const t0 = await agg.ethOwed(deployer.address);
      const q0 = await agg.ethOwed(requester.address);
      await drv.settle(r);
      expect(await agg.isFailed(r.aggId)).to.equal(true);
      for (const s of [5, 6, 7]) expect(await score(r.slots[s])).to.deep.equal([500, 500]);
      // otherwise a requester that dislikes the jury could withhold closeCommits (with one colluding
      // juror not committing) and get its prepay back: a cheap re-roll
      const [, , , , received, base, , reward] = await agg.getRoundInfo(r.aggId);
      expect((await agg.ethOwed(deployer.address)) - t0).to.equal(received - base - reward);
      expect(await agg.ethOwed(requester.address)).to.equal(q0);
    });

    it("a commit that closes the phase in the deadline's last second still leaves time to promote", async () => {
      await agg.setConfig(8, 5, 4, 3, 300, 155);
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
      const required = await agg.maxTotalFee(H.MAX_FEE, false);
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
      const payees = new Set([requester.address, deployer.address]);          // deployer calls promote()
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

  describe("configuration", () => {
    it("rejects P = 1 with N > 1, and a timeout not above T+", async () => {
      await expect(agg.setConfig(6, 5, 4, 1, 300, 155)).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await expect(agg.setConfig(6, 5, 4, 3, 155, 155)).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await agg.setConfig(1, 1, 1, 1, 300, 155);
      await expect(agg.setConfig(1, 1, 1, 1, 300, 300)).to.be.revertedWithCustomError(agg, "InvalidConfig");
      await agg.setConfig(1, 1, 1, 1, 300, 120);
      expect(await agg.tPlus()).to.equal(120n);
    });
  });

  describe("clustering", () => {
    it("ScoringLib.bestCluster returns the same cluster as AggregatorLib.findBestCluster", async () => {
      const rnd = (n) => Math.floor(Math.random() * n);
      for (let t = 0; t < 40; t++) {
        const n = 2 + rnd(26);
        const P = 2 + rnd(n - 1);
        const v = Array.from({ length: n }, () => [BigInt(rnd(1_000_000)), BigInt(rnd(1_000_000))]);
        const want = await core.aggLib.findBestCluster(v, v.map((_, i) => i), P);
        const got = await core.scoring.bestCluster(v, P);
        expect(got.map((b) => (b ? 1n : 0n))).to.deep.equal(want);
      }
    });
  });
});
