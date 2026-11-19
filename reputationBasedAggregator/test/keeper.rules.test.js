// Rule tests for ReputationKeeper: TODO item 14, Table 1 (points) and Table 2 (consequences),
// decay, burns, unbonding, liveness freeze, and selection eligibility.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");

const DAY = 24 * 3600;

describe("ReputationKeeper rules (item 14)", function () {
  let core, keeper, token, arbs, fakeAgg;

  // an approved EOA stands in for the aggregator so outcomes and selections can be driven directly
  // the round ends now: freezing is judged at round end
  const apply = async (keys, codes, end) => keeper.connect(fakeAgg).applyOutcomes(keys, codes, end ?? (await time.latest()) + 1);
  const info = (k) => keeper.getArbiter(k);
  const SP = (count, maxFee = H.MAX_FEE) => ({
    count, alpha: 500, maxFee, estimatedBaseCost: H.BASE_COST, maxFeeBasedScalingFactor: 5, requestedClass: 1,
  });
  // item 9: selection reads the state as of a past block, with an explicit seed
  // mine one block so the latest state is strictly in the past (eth_call runs at block.number = latest)
  async function at() {
    await ethers.provider.send("evm_mine", []);
    const b = await ethers.provider.getBlock((await ethers.provider.getBlockNumber()) - 1);
    return [b.number, b.timestamp];
  }
  const rndSeed = () => ethers.hexlify(ethers.randomBytes(32));
  async function select(count, seed = rndSeed()) {
    const [bn, ts] = await at();
    return keeper.connect(fakeAgg).selectArbiters(SP(count), seed, bn, ts);
  }
  async function selectedKeys(count, seed = rndSeed(), when) {
    const [bn, ts] = when || (await at());
    const sel = await keeper.connect(fakeAgg).selectArbiters.staticCall(SP(count), seed, bn, ts);
    return sel.map((s) => s.key);
  }

  beforeEach(async () => {
    core = await H.deployCore({ withAggregator: false });
    ({ keeper, token } = core);
    fakeAgg = (await ethers.getSigners())[2];
    await keeper.setApproved(fakeAgg.address, true);
    arbs = await H.registerArbiters(core, 12);
  });

  describe("Table 1: points per event", () => {
    it("starts at 500/500 and applies +20 / -200 / -500 / -400 timeliness and +20 / -50 / -200 quality", async () => {
      const k = arbs.slice(0, 7).map((a) => a.key);
      await apply(k, [
        H.code(H.T.DELIVERED, H.Q.CLOSE),
        H.code(H.T.DELIVERED, H.Q.OFF),
        H.code(H.T.DELIVERED, H.Q.FAR),
        H.code(H.T.MISS_FINISHED),
        H.code(H.T.MISS_FAILED),
        H.code(H.T.NOCOMMIT_FAILED),
        H.code(H.T.NONE),
      ]);
      const got = await Promise.all(k.map(async (x) => { const a = await info(x); return [Number(a.timeliness), Number(a.quality)]; }));
      expect(got).to.deep.equal([[520, 520], [520, 450], [520, 300], [300, 500], [0 + 500, 500], [100, 500], [500, 500]]);
      // -500 from 500 reaches 0: blocked and restarted at 500 (checked in Table 2 below); -400 does not
      expect((await info(k[4])).offenses).to.equal(1n);
      expect((await info(k[5])).offenses).to.equal(0n);
    });

    it("caps scores at 1000", async () => {
      const k = arbs[0].key;
      for (let i = 0; i < 30; i++) await apply([k], [H.code(H.T.DELIVERED, H.Q.CLOSE)]);
      const a = await info(k);
      expect(a.timeliness).to.equal(1000n);
      expect(a.quality).to.equal(1000n);
    });
  });

  describe("Table 2: blocks, bans, decay", () => {
    it("blocks at 0 for 24 h, then 48 h, and bans on the third block", async () => {
      const k = arbs[0].key;
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // 500 -> 0: block 1
      let a = await info(k);
      const now1 = await time.latest();
      expect(a.offenses).to.equal(1n);
      expect(Number(a.blockedUntil) - now1).to.equal(DAY);
      expect(a.timeliness).to.equal(500n);
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(false);

      await time.increase(DAY + 1);
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(true);
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // block 2: 48 h
      a = await info(k);
      expect(Number(a.blockedUntil) - (await time.latest())).to.equal(2 * DAY);

      await time.increase(2 * DAY + 1);
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // block 3: ban
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(false);
      await time.increase(30 * DAY);
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(false);   // permanent
      a = await info(k);
      expect(a.flags & 4n).to.equal(4n);
    });

    it("a hit while already blocked restarts the score but adds no offense", async () => {
      const k = arbs[0].key;
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // block 1
      const until = (await info(k)).blockedUntil;
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // another in-flight round settles
      const a = await info(k);
      expect(a.offenses).to.equal(1n);
      expect(a.blockedUntil).to.equal(until);
      expect(a.timeliness).to.equal(500n);
    });

    it("forgives one offense per 90 clean days after the last block ended", async () => {
      const k = arbs[0].key;
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // offense 1, block 24 h
      await time.increase(DAY + 90 * DAY + 10);             // block end + 90 days
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // forgiven -> 0, so 24 h again
      let a = await info(k);
      expect(a.offenses).to.equal(1n);
      expect(Number(a.blockedUntil) - (await time.latest())).to.equal(DAY);

      await time.increase(DAY + 30 * DAY);                  // not clean long enough
      await apply([k], [H.code(H.T.MISS_FAILED)]);
      a = await info(k);
      expect(a.offenses).to.equal(2n);
      expect(Number(a.blockedUntil) - (await time.latest())).to.equal(2 * DAY);
    });
  });

  describe("stake burns (owner-set, off by default)", () => {
    it("burns nothing by default", async () => {
      const k = arbs[0].key;
      const supply0 = await token.totalSupply();
      for (let i = 0; i < 3; i++) { await apply([k], [H.code(H.T.MISS_FAILED)]); await time.increase(5 * DAY); }
      expect((await info(k)).stake).to.equal(H.STAKE);
      expect(await token.totalSupply()).to.equal(supply0);
    });

    it("burns burnPerBlock x 2^offenses per block, and the whole stake on a ban when burnOnBan", async () => {
      const k = arbs[0].key;
      const unit = 10n ** 18n;
      await keeper.setPenalties(3, unit, true);
      const supply0 = await token.totalSupply();
      await apply([k], [H.code(H.T.MISS_FAILED)]);
      expect((await info(k)).stake).to.equal(H.STAKE - unit);
      await time.increase(2 * DAY);
      await apply([k], [H.code(H.T.MISS_FAILED)]);
      expect((await info(k)).stake).to.equal(H.STAKE - 3n * unit);
      await time.increase(3 * DAY);
      await apply([k], [H.code(H.T.MISS_FAILED)]);          // ban: rest of the stake
      expect((await info(k)).stake).to.equal(0n);
      expect(supply0 - (await token.totalSupply())).to.equal(H.STAKE);
    });

    it("an arbiter below the stake requirement is not selected until it tops up", async () => {
      const k = arbs[0].key;
      await keeper.setPenalties(3, 10n ** 18n, false);
      await apply([k], [H.code(H.T.MISS_FAILED)]);
      await time.increase(2 * DAY);
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(false);
      await keeper.topUpStake(k, 10n ** 18n);
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(true);
    });

    it("only the arbiter's owner (or the keeper owner) can top up: a top-up re-applies the stake requirement", async () => {
      const [, , , x] = await ethers.getSigners();
      await keeper.setStakeRequirement(H.STAKE * 2n);
      await expect(keeper.connect(x).topUpStake(arbs[0].key, 0)).to.be.revertedWithCustomError(keeper, "NotArbiterOwner");
      expect(await keeper.isEligible(arbs[0].key, H.MAX_FEE)).to.equal(true);   // the new requirement waits for its stake change
    });
  });

  describe("unbonding", () => {
    it("exiting arbiters are not selected, are still punishable, and are refunded only after the delay", async () => {
      const a0 = arbs[0];
      await keeper.requestExit(a0.key);
      expect(await keeper.isEligible(a0.key, H.MAX_FEE)).to.equal(false);
      await apply([a0.key], [H.code(H.T.MISS_FAILED)]);      // still blocked during unbonding
      expect((await info(a0.key)).offenses).to.equal(1n);
      await expect(keeper.completeExit(a0.key)).to.be.revertedWithCustomError(keeper, "StillBonded");
      await time.increase(7 * DAY + 1);
      const owner = await a0.op.owner();
      await keeper.completeExit(a0.key);
      expect(await token.balanceOf(owner)).to.equal(H.STAKE);
      expect(await keeper.eligibleCount(1, H.MAX_FEE)).to.equal(11n);   // lists are append-only (item 9)
    });

    it("a returning key keeps its scores, offenses and classes", async () => {
      const a0 = arbs[0];
      await apply([a0.key], [H.code(H.T.MISS_FINISHED, H.Q.FAR)]);           // 300 / 300
      await apply([a0.key], [H.code(H.T.MISS_FAILED)]);                       // offense 1
      await time.increase(2 * 24 * 3600);
      await keeper.requestExit(a0.key);
      await time.increase(8 * 24 * 3600);
      await keeper.completeExit(a0.key);
      await keeper.registerArbiter(a0.opAddr, a0.jobId, H.FEE, [2], a0.ch.head);
      const v = await info(a0.key);
      expect([Number(v.timeliness), Number(v.quality), Number(v.offenses)]).to.deep.equal([500, 300, 1]);
      expect(await keeper.classSize(1)).to.equal(12n);                       // still listed in class 1
      expect(await keeper.classSize(2)).to.equal(1n);
    });

    it("a banned key leaves a tombstone and cannot register again", async () => {
      const a0 = arbs[0];
      for (let i = 0; i < 3; i++) { await apply([a0.key], [H.code(H.T.MISS_FAILED)]); await time.increase(5 * DAY); }
      await keeper.requestExit(a0.key);
      await time.increase(8 * DAY);
      await keeper.completeExit(a0.key);
      await expect(keeper.registerArbiter(a0.opAddr, a0.jobId, H.FEE, [1], a0.ch.head))
        .to.be.revertedWithCustomError(keeper, "AlreadyRegistered");
    });
  });

  describe("liveness freeze (hash-chain health calls)", () => {
    it("a juror that does not answer within D is frozen, excluded, unscored, and unfreezes on answering", async () => {
      // jurors (and liveRandom extra probes) get health calls; read them from the events
      const rc = await (await select(6)).wait();
      const keys = rc.logs
        .filter((l) => l.address === (keeper.target) && l.topics[0] === keeper.interface.getEvent("HealthCall").topicHash)
        .map((l) => l.topics[1]);
      expect(keys.length).to.equal(9);
      const a = arbs.find((x) => x.key === keys[0]);
      // everyone else answers
      for (const k of keys.slice(1)) {
        const b = arbs.find((x) => x.key === k);
        await keeper.connect(b.node).answerHealthCall(k, b.ch.next());
      }
      await time.increase(61);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
      expect(await keeper.isEligible(a.key, H.MAX_FEE)).to.equal(false);
      expect(await keeper.isFrozen(keys[1])).to.equal(false);
      expect(await keeper.eligibleCount(1, H.MAX_FEE)).to.equal(11n);

      // frozen arbiters are never scored
      await expect(apply([a.key], [H.code(H.T.MISS_FAILED)])).to.emit(keeper, "OutcomeSkippedFrozen");
      expect((await info(a.key)).timeliness).to.equal(500n);

      // wrong preimage and unauthorized senders are rejected
      await expect(keeper.connect(a.node).answerHealthCall(a.key, ethers.ZeroHash))
        .to.be.revertedWithCustomError(keeper, "BadPreimage");
      const stranger = (await ethers.getSigners())[3];
      await expect(keeper.connect(stranger).answerHealthCall(a.key, a.ch.chain[a.ch.chain.length - 2]))
        .to.be.revertedWithCustomError(keeper, "NotAuthorizedResponder");

      // answering at any later time unfreezes, with no new request needed
      await time.increase(3600);
      await keeper.connect(a.node).answerHealthCall(a.key, a.ch.next());
      expect(await keeper.isFrozen(a.key)).to.equal(false);
      expect(await keeper.isEligible(a.key, H.MAX_FEE)).to.equal(true);
    });

    it("being frozen is judged at round end: recovering before settlement is not charged", async () => {
      const k = arbs[0];
      await keeper.sendHealthCalls([k.key]);
      await time.increase(61);
      const end = await time.latest();                            // frozen at round end
      await keeper.connect(k.node).answerHealthCall(k.key, k.ch.next());   // back before settlement
      await apply([k.key], [H.code(H.T.NOCOMMIT_FAILED)], end);
      expect((await info(k.key)).timeliness).to.equal(500n);
      await apply([k.key], [H.code(H.T.NOCOMMIT_FAILED)]);        // a later round, live at its end
      expect((await info(k.key)).timeliness).to.equal(100n);
    });

    it("a frozen arbiter that committed in the round is still scored", async () => {
      const k = arbs[0].key;
      await keeper.sendHealthCalls([k]);
      await time.increase(61);
      expect(await keeper.isFrozen(k)).to.equal(true);
      await apply([k], [H.code(H.T.MISS_FINISHED, 0, true)]);
      expect((await info(k)).timeliness).to.equal(300n);
    });

    it("a call sent in the same second as the last answer is still outstanding", async () => {
      const a = arbs[0];
      await keeper.sendHealthCalls([a.key]);
      await ethers.provider.send("evm_setAutomine", [false]);
      await keeper.connect(a.node).answerHealthCall(a.key, a.ch.next());
      await keeper.sendHealthCalls([a.key]);
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      const v = await info(a.key);
      expect(v.callSentAt).to.equal(v.callAnsweredAt);                 // same timestamp
      await time.increase(61);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
    });

    it("rotateChain answers from the old chain and installs a new head", async () => {
      const a = arbs[0];
      await keeper.sendHealthCalls([a.key]);
      const fresh = H.makeChain();
      await keeper.connect(a.node).rotateChain(a.key, a.ch.next(), fresh.head);
      expect(await keeper.isFrozen(a.key)).to.equal(false);
      await keeper.sendHealthCalls([a.key]);
      await expect(keeper.connect(a.node).answerHealthCall(a.key, a.ch.next())).to.be.revertedWithCustomError(keeper, "BadPreimage");
      await keeper.connect(a.node).answerHealthCall(a.key, fresh.next());
      await time.increase(61);
      expect(await keeper.isFrozen(a.key)).to.equal(false);
    });

    it("the owner can send health calls to many arbiters at once", async () => {
      await keeper.sendHealthCalls(arbs.map((a) => a.key));
      await time.increase(61);
      expect(await keeper.eligibleCount(1, H.MAX_FEE)).to.equal(0n);
    });
  });

  describe("owner limits", () => {
    it("caps maxOffenses at 16 so block lengths cannot overflow", async () => {
      await expect(keeper.setPenalties(17, 0, false)).to.be.revertedWithCustomError(keeper, "BadParams");
      await keeper.setPenalties(16, 0, false);
    });

    it("answers ArbiterOperator's gate: isContractApproved mirrors approvedContracts", async () => {
      const [, , , x] = await ethers.getSigners();
      expect(await keeper.isContractApproved(x.address)).to.equal(false);
      await keeper.setApproved(x.address, true);
      expect(await keeper.isContractApproved(x.address)).to.equal(true);
      await keeper.setApproved(x.address, false);
      expect(await keeper.isContractApproved(x.address)).to.equal(false);
    });
  });

  describe("selection", () => {
    it("never selects blocked, banned, paused, exiting or frozen arbiters", async () => {
      await apply([arbs[0].key], [H.code(H.T.MISS_FAILED)]);                       // blocked
      for (let i = 0; i < 3; i++) { await apply([arbs[1].key], [H.code(H.T.MISS_FAILED)]); await time.increase(5 * DAY); }
      await apply([arbs[0].key], [H.code(H.T.MISS_FAILED)]);                       // keep arbs[0] blocked
      await keeper.setPaused(arbs[2].key, true);
      await keeper.requestExit(arbs[3].key);
      await keeper.sendHealthCalls([arbs[4].key]);
      await time.increase(61);
      const excluded = new Set(arbs.slice(0, 5).map((a) => a.key));
      for (let r = 0; r < 20; r++) {
        const keys = await selectedKeys(6);
        for (const k of keys) expect(excluded.has(k)).to.equal(false);
        await ethers.provider.send("evm_mine", []);
      }
      expect(await keeper.eligibleCount(1, H.MAX_FEE)).to.equal(7n);
    });

    it("reverts when fewer than K are eligible (no repeated slots), and when none are", async () => {
      await keeper.sendHealthCalls(arbs.slice(0, 9).map((a) => a.key));
      await time.increase(61);
      await expect(select(6)).to.be.revertedWithCustomError(keeper, "NotEnoughEligible");   // 3 eligible
      await keeper.sendHealthCalls(arbs.slice(9).map((a) => a.key));
      await time.increase(61);
      await expect(select(6)).to.be.revertedWithCustomError(keeper, "NoEligibleArbiters");
    });

    it("item 9: a stake top-up after B cannot change the draw", async () => {
      const k = arbs[0].key;
      await keeper.setPenalties(3, 10n ** 18n, false);
      await apply([k], [H.code(H.T.MISS_FAILED)]);                // block + burn: now under-staked
      await time.increase(2 * DAY);
      const seed = rndSeed();
      const B = await at();
      const before = await selectedKeys(6, seed, B);
      await keeper.topUpStake(k, 10n ** 18n);
      expect(await keeper.isEligible(k, H.MAX_FEE)).to.equal(true);
      expect(await selectedKeys(6, seed, B)).to.deep.equal(before);
      expect(before.includes(k)).to.equal(false);
    });

    it("item 9: selection at block B ignores every state change after B", async () => {
      const seed = rndSeed();
      const B = await at();
      const before = await selectedKeys(6, seed, B);
      // after B: block two of the drawn arbiters, boost others, pause one, freeze one, register more
      await apply(before.slice(0, 2), [H.code(H.T.MISS_FAILED), H.code(H.T.MISS_FAILED)]);
      const rest = arbs.map((a) => a.key).filter((k) => !before.includes(k));
      for (let i = 0; i < 10; i++) await apply(rest, rest.map(() => H.code(H.T.DELIVERED, H.Q.CLOSE)));
      await keeper.setPaused(before[2], true);
      await keeper.sendHealthCalls([before[3]]);
      await H.registerArbiters(core, 20);
      await time.increase(3600);
      expect(await selectedKeys(6, seed, B)).to.deep.equal(before);
      // the same seed at the current block sees the new state
      expect(await selectedKeys(6, seed)).to.not.deep.equal(before);
      await expect(keeper.connect(fakeAgg).selectArbiters(SP(6), seed, (await ethers.provider.getBlockNumber()) + 1, 0))
        .to.be.revertedWithCustomError(keeper, "FutureBlock");
    });

    it("higher scores raise selection weight at most 2x", async () => {
      // push half the pool to 1000/1000 and compare selection frequency
      const hi = arbs.slice(0, 6).map((a) => a.key);
      for (let i = 0; i < 30; i++) await apply(hi, hi.map(() => H.code(H.T.DELIVERED, H.Q.CLOSE)));
      let hiCount = 0, total = 0;
      for (let r = 0; r < 150; r++) {
        const keys = await selectedKeys(1);
        if (hi.includes(keys[0])) hiCount++;
        total++;
        await ethers.provider.send("evm_mine", []);
      }
      // expected share with weights 2000 vs 1500: 6*2000 / (6*2000 + 6*1500) = 57%
      expect(hiCount / total).to.be.within(0.42, 0.72);
    });
  });
});
