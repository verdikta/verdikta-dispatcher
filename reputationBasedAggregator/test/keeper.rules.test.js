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
    count, alpha: 500, maxFee, minFee: 0, estimatedBaseCost: H.BASE_COST, maxFeeBasedScalingFactor: 5, requestedClass: 1,
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
      await time.increase(2 * DAY - 60);
      await expect(keeper.completeExit(a0.key)).to.be.revertedWithCustomError(keeper, "StillBonded");
      await time.increase(61);                                 // 2 days, the default
      const owner = await a0.op.owner();
      await keeper.completeExit(a0.key);
      expect(await token.balanceOf(owner)).to.equal(H.STAKE);
      expect(await keeper.eligibleCount(1, H.MAX_FEE)).to.equal(11n);
    });

    it("the operator owner can exit a frozen arbiter (the call is dropped, the slot freed)", async () => {
      const a = arbs[2];
      await keeper.sendHealthCalls([a.key]);
      await time.increase(61);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
      const o = await a.op.owner();
      await ethers.provider.send("hardhat_setBalance", [o, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [o]);
      const os = await ethers.getSigner(o);
      await keeper.connect(os).requestExit(a.key);
      await time.increase(2 * DAY + 1);
      await keeper.connect(os).completeExit(a.key);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [o]);
      expect(await token.balanceOf(o)).to.equal(H.STAKE);
      expect(await keeper.freeSlotCount(1)).to.equal(1n);
      const stranger = (await ethers.getSigners())[5];                       // neither owner
      await expect(keeper.connect(stranger).requestExit(arbs[3].key)).to.be.revertedWithCustomError(keeper, "NotArbiterOwner");
    });

    it("unbonding is owner-set, never below 2 days, and applies to exits requested afterwards", async () => {
      expect(await keeper.unbondingPeriod()).to.equal(BigInt(2 * DAY));
      const [lock, decay, dead] = [await keeper.lockDuration(), await keeper.decayPeriod(), await keeper.callDeadline()];
      await expect(keeper.setTiming(lock, decay, dead, 2 * DAY - 1)).to.be.revertedWithCustomError(keeper, "BadParams");
      await keeper.requestExit(arbs[0].key);                   // 2 days
      const at0 = BigInt(await time.latest()) + BigInt(2 * DAY);
      expect((await keeper.getArbiter(arbs[0].key)).exitAt).to.equal(at0);           // readable by the node's scripts
      expect((await keeper.getArbiter(arbs[2].key)).exitAt).to.equal(0n);
      // a second request would restart the clock: refused
      await expect(keeper.requestExit(arbs[0].key)).to.be.revertedWithCustomError(keeper, "AlreadyExiting");
      await keeper.setTiming(lock, decay, dead, 5 * DAY);
      await keeper.requestExit(arbs[1].key);                   // 5 days
      await time.increase(2 * DAY + 1);
      expect(await keeper.arbiterClasses(arbs[0].key)).to.deep.equal([1n]);
      await keeper.completeExit(arbs[0].key);
      expect(await keeper.arbiterClasses(arbs[0].key)).to.deep.equal([]);           // its slots are freed
      await expect(keeper.completeExit(arbs[1].key)).to.be.revertedWithCustomError(keeper, "StillBonded");
      await time.increase(3 * DAY);
      await keeper.completeExit(arbs[1].key);
    });

    it("a returning key keeps its scores and offenses, and takes its classes from the new registration", async () => {
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
      expect(await keeper.slotIn(a0.key, 1)).to.equal(0n);                  // its class 1 slot was freed
      expect(await keeper.freeSlotCount(1)).to.equal(1n);
      expect(await keeper.classSize(1)).to.equal(12n);
      expect(await keeper.slotIn(a0.key, 2)).to.equal(1n);
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

  describe("slot reuse", () => {
    async function exit(a) {
      await keeper.requestExit(a.key);
      await time.increase(2 * DAY + 1);
      await keeper.completeExit(a.key);
    }

    it("an exited arbiter's slot goes to the next registration, so exits and joins do not grow the list", async () => {
      const slot = await keeper.slotIn(arbs[3].key, 1);
      await exit(arbs[3]);
      expect(await keeper.freeSlotCount(1)).to.equal(1n);
      const [fresh] = await H.registerArbiters(core, 1);
      expect(await keeper.slotIn(fresh.key, 1)).to.equal(slot);
      expect(await keeper.freeSlotCount(1)).to.equal(0n);
      expect(await keeper.classSize(1)).to.equal(12n);
      expect(await selectedKeys(12)).to.include(fresh.key);    // all 12 eligible are drawn
      // the same key leaving and returning three times, and a join with no free slot
      const a = arbs[5];
      for (let i = 0; i < 3; i++) {
        await exit(a);
        await keeper.registerArbiter(a.opAddr, a.jobId, H.FEE, [1], a.ch.head);
      }
      expect(await keeper.classSize(1)).to.equal(12n);
      await H.registerArbiters(core, 1);
      expect(await keeper.classSize(1)).to.equal(13n);
    });

    it("a freed slot is skipped by the walk and the beacon pick", async () => {
      for (const a of arbs.slice(0, 6)) await exit(a);
      expect(await keeper.freeSlotCount(1)).to.equal(6n);
      const keys = await selectedKeys(6);
      expect(new Set(keys).size).to.equal(6);
      expect(keys).to.not.include(ethers.ZeroHash);
      const [bn, ts] = await at();
      const beacons = await keeper.connect(fakeAgg).pickBeacons.staticCall(rndSeed(), 1, bn, ts, 6);
      expect([...beacons].sort()).to.deep.equal(arbs.slice(6).map((a) => a.key).sort());
    });

    it("a draw at B gives the same jury after slots are freed and reused since B", async () => {
      // arbs[1] and arbs[2] were exiting at B; after B they leave and three arbiters join, two of them
      // into the freed slots. Within the draw age limit, selection as of B must not change
      await keeper.requestExit(arbs[1].key);
      await keeper.requestExit(arbs[2].key);
      await time.increase(2 * DAY + 1);
      const B = await at();
      const seed = rndSeed();
      const all = await selectedKeys(10, seed, B);             // every arbiter eligible at B
      const some = await selectedKeys(6, seed, B);
      await keeper.completeExit(arbs[1].key);
      await keeper.completeExit(arbs[2].key);
      const joined = await H.registerArbiters(core, 3);
      expect(await keeper.freeSlotCount(1)).to.equal(0n);
      expect(await keeper.classSize(1)).to.equal(13n);
      expect(await selectedKeys(10, seed, B)).to.deep.equal(all);
      expect(await selectedKeys(6, seed, B)).to.deep.equal(some);
      for (const j of joined) expect(all).to.not.include(j.key);
      // the same seed now sees the joiners
      expect(await selectedKeys(13, seed)).to.include.members(joined.map((j) => j.key));
    });

    it("selection refuses a request block older than a day", async () => {
      const B = await at();
      await time.increase(DAY + 1);
      await expect(selectedKeys(6, rndSeed(), B)).to.be.revertedWithCustomError(keeper, "StaleBlock");
      await expect(keeper.connect(fakeAgg).pickBeacons(rndSeed(), 1, B[0], B[1], 4))
        .to.be.revertedWithCustomError(keeper, "StaleBlock");
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

      // a rotation needs the right preimage, and unauthorized senders are rejected
      await expect(keeper.connect(a.node).rotateChain(a.key, ethers.ZeroHash, H.makeChain().head))
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
      await expect(keeper.connect(a.node).rotateChain(a.key, a.ch.next(), fresh.head)).to.be.revertedWithCustomError(keeper, "BadPreimage");
      await keeper.connect(a.node).answerHealthCall(a.key, fresh.next());
      await time.increase(61);
      expect(await keeper.isFrozen(a.key)).to.equal(false);
    });

    it("healthState reports the pending call, when it was sent, and the current head (after answers and a rotation)", async () => {
      const a = arbs[0];
      let [pending, sentAt, head] = await keeper.healthState(a.key);
      expect([pending, sentAt, head]).to.deep.equal([false, 0n, a.ch.head]);
      await keeper.sendHealthCalls([a.key]);
      const t = BigInt(await time.latest());
      [pending, sentAt, head] = await keeper.healthState(a.key);
      expect([pending, sentAt, head]).to.deep.equal([true, t, a.ch.head]);
      const v = a.ch.next();
      await keeper.connect(a.node).answerHealthCall(a.key, v);
      [pending, , head] = await keeper.healthState(a.key);
      expect([pending, head]).to.deep.equal([false, v]);                     // the answer is the new head
      await keeper.sendHealthCalls([a.key]);
      const fresh = H.makeChain();
      await keeper.connect(a.node).rotateChain(a.key, a.ch.next(), fresh.head);
      [pending, , head] = await keeper.healthState(a.key);
      expect([pending, head]).to.deep.equal([false, fresh.head]);            // a rotation leaves the new head
    });

    it("the owner can send health calls to many arbiters at once", async () => {
      await keeper.sendHealthCalls(arbs.map((a) => a.key));
      await time.increase(61);
      expect(await keeper.eligibleCount(1, H.MAX_FEE)).to.equal(0n);
    });
  });

  describe("chain re-sync (a mismatched answer)", () => {
    // A node whose chain does not match the keeper's head (registered from a browser with head 0,
    // or its chain files lost) answers with a fresh chain's head: the keeper adopts it as the head
    // and freezes the arbiter until it answers a health call sent after the re-sync. The node's first
    // valid answer after the re-sync sends that call, so its health job needs no other transaction.
    const RESYNC = 64n;
    const flagsOf = async (k) => (await info(k)).flags;

    it("a mismatched answer adopts the value as the head and freezes the arbiter at once", async () => {
      const a = arbs[0];
      const other = H.makeChain();
      await expect(keeper.connect(a.node).answerHealthCall(a.key, other.head))
        .to.emit(keeper, "ChainResynced").withArgs(a.key);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
      expect(await keeper.isEligible(a.key, H.MAX_FEE)).to.equal(false);
      expect((await flagsOf(a.key)) & RESYNC).to.equal(RESYNC);
      const [pending, , head] = await keeper.healthState(a.key);
      expect(pending).to.equal(true);                                         // the node's job keeps answering
      expect(head).to.equal(other.head);
    });

    it("the first valid answer after a re-sync sends the call (still frozen); answering it unfreezes", async () => {
      const a = arbs[0];
      const other = H.makeChain();
      await keeper.connect(a.node).rotateChain(a.key, other.head, other.head);   // the job's form
      await expect(keeper.connect(a.node).rotateChain(a.key, other.next(), other.chain[other.chain.length - 2]))
        .to.emit(keeper, "HealthCall");
      expect((await flagsOf(a.key)) & RESYNC).to.equal(0n);
      expect(await keeper.isFrozen(a.key)).to.equal(true);                    // until the call is answered
      expect((await keeper.healthState(a.key))[0]).to.equal(true);
      const v = other.next();
      await keeper.connect(a.node).rotateChain(a.key, v, v);
      expect(await keeper.isFrozen(a.key)).to.equal(false);
      expect(await keeper.isEligible(a.key, H.MAX_FEE)).to.equal(true);
      expect((await keeper.healthState(a.key))[0]).to.equal(false);
    });

    it("requestHealthCall after a re-sync sends the call; answering it unfreezes", async () => {
      const a = arbs[0];
      const other = H.makeChain();
      await keeper.connect(a.node).answerHealthCall(a.key, other.head);
      await expect(keeper.connect(a.node).requestHealthCall(a.key)).to.emit(keeper, "HealthCall");
      expect((await flagsOf(a.key)) & RESYNC).to.equal(0n);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
      await keeper.connect(a.node).answerHealthCall(a.key, other.next());
      expect(await keeper.isFrozen(a.key)).to.equal(false);
    });

    it("a call from selection or the owner also ends the re-sync", async () => {
      const a = arbs[0];
      const other = H.makeChain();
      await keeper.connect(a.node).answerHealthCall(a.key, other.head);
      await keeper.sendHealthCalls([a.key]);
      await keeper.connect(a.node).answerHealthCall(a.key, other.next());
      expect(await keeper.isFrozen(a.key)).to.equal(false);
    });

    it("a re-sync is never a beacon value: revealAfter skips it, and counts the next valid answer", async () => {
      const a = arbs[0];
      const other = H.makeChain();
      const b0 = BigInt(await ethers.provider.getBlockNumber());
      await keeper.connect(a.node).answerHealthCall(a.key, other.head);      // re-sync after b0
      let [v] = await keeper.revealAfter(a.key, b0);
      expect(v).to.equal(ethers.ZeroHash);                                    // withheld, as far as b0 goes
      const b1 = BigInt(await ethers.provider.getBlockNumber());
      const x = other.next();
      await keeper.connect(a.node).answerHealthCall(a.key, x);                // ends the re-sync (sends the call)
      [v] = await keeper.revealAfter(a.key, b1);
      expect(v).to.equal(x);                                                  // fixed at the re-sync, before b1
      [v] = await keeper.revealAfter(a.key, b0);
      expect(v).to.equal(ethers.ZeroHash);
    });

    it("a rotation to a different head never re-syncs: a wrong preimage reverts and changes nothing", async () => {
      const a = arbs[0];
      const fresh = H.makeChain();
      await expect(keeper.connect(a.node).rotateChain(a.key, fresh.head, H.makeChain().head))
        .to.be.revertedWithCustomError(keeper, "BadPreimage");
      expect((await keeper.healthState(a.key))[2]).to.equal(a.ch.head);
      expect(await keeper.isFrozen(a.key)).to.equal(false);
    });

    it("only the operator's owner or an authorized sender may re-sync or request a call", async () => {
      const a = arbs[0];
      const stranger = (await ethers.getSigners())[3];
      await expect(keeper.connect(stranger).answerHealthCall(a.key, ethers.ZeroHash))
        .to.be.revertedWithCustomError(keeper, "NotAuthorizedResponder");
      await expect(keeper.connect(stranger).requestHealthCall(a.key))
        .to.be.revertedWithCustomError(keeper, "NotAuthorizedResponder");
    });

    it("requestHealthCall with nothing pending sends a call like the owner's", async () => {
      const a = arbs[0];
      await keeper.connect(a.node).requestHealthCall(a.key);
      const t = BigInt(await time.latest());
      expect(await keeper.healthState(a.key)).to.deep.equal([true, t, a.ch.head]);
      await time.increase(61);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
      await keeper.connect(a.node).answerHealthCall(a.key, a.ch.next());
      expect(await keeper.isFrozen(a.key)).to.equal(false);
    });

    it("a re-sync does not reach back: a round that ended before it is still scored", async () => {
      const a = arbs[0];
      const end = await time.latest();
      await time.increase(10);
      await keeper.connect(a.node).answerHealthCall(a.key, H.makeChain().head);
      await apply([a.key], [H.code(H.T.NOCOMMIT_FAILED)], end);
      expect((await info(a.key)).timeliness).to.equal(100n);
    });

    it("registering with head 0 starts frozen in re-sync; the node's re-sync, a call and an answer make it eligible", async () => {
      const OpF = await ethers.getContractFactory("TestOperator");
      const node = (await ethers.getSigners())[5];
      const op = await OpF.deploy(await core.link.getAddress(), ethers.Wallet.createRandom().address, node.address);
      const jobId = ethers.zeroPadValue(ethers.toBeHex(99), 32);
      await keeper.registerArbiter(await op.getAddress(), jobId, H.FEE, [1], ethers.ZeroHash);
      const key = await keeper.keyOf(await op.getAddress(), jobId);
      expect(await keeper.isFrozen(key)).to.equal(true);
      expect((await flagsOf(key)) & RESYNC).to.equal(RESYNC);
      expect((await keeper.healthState(key))[0]).to.equal(true);             // so the node's job runs

      const ch = H.makeChain();
      await keeper.connect(node).answerHealthCall(key, ch.head);              // the node's own chain
      await keeper.connect(node).answerHealthCall(key, ch.next());            // sends the call
      expect(await keeper.isEligible(key, H.MAX_FEE)).to.equal(false);
      await keeper.connect(node).answerHealthCall(key, ch.next());            // answers it
      expect(await keeper.isEligible(key, H.MAX_FEE)).to.equal(true);
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

    it("a block of back-to-back registrations is drawn no more often than a random sample", async () => {
      // A stride walk visits an arithmetic progression of list positions, so the strides 1 and n-1 walk
      // straight through a block of back-to-back registrations: the block is drawn whole, or not at
      // all, far more often than chance. With 10 of 40 entries in one block and all 20 shortlisted
      // entries drawn, the jury should follow the hypergeometric distribution: P(<= 1 or >= 9
      // colluders) = 0.84%, so 8.4 of 1,000 seeds (the stride walk gave 51).
      arbs = arbs.concat(await H.registerArbiters(core, 28));
      await keeper.setSelection(20, 400, 0);
      const block = new Set(arbs.slice(10, 20).map((a) => a.key));
      const [bn, ts] = await at();
      const counts = [];
      for (let i = 0; i < 1000; i++) {
        const seed = ethers.keccak256(ethers.toUtf8Bytes(`walk ${i}`));   // fixed seeds: reproducible
        const sel = await keeper.connect(fakeAgg).selectArbiters.staticCall(SP(20), seed, bn, ts);
        counts.push(sel.filter((s) => block.has(s.key)).length);
      }
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const tails = counts.filter((c) => c <= 1 || c >= 9).length;
      expect(mean).to.be.within(4.8, 5.2);
      expect(tails).to.be.at.most(16);
    });

    it("the walk reaches every entry when the list fits in maxScan", async () => {
      // 20 of 40 eligible and 20 seats: every eligible entry must be found, including the last ones
      // the random draws are slow to hit (the walk finishes with a sweep of the unvisited entries)
      arbs = arbs.concat(await H.registerArbiters(core, 28));
      await keeper.setSelection(20, 400, 0);
      const live = [];
      for (let i = 0; i < arbs.length; i++) {
        if ((i * 7) % 3 === 0 || i % 5 === 1) await keeper.setPaused(arbs[i].key, true);
        else live.push(arbs[i].key);
      }
      const extra = live.splice(20);
      for (const k of extra) await keeper.setPaused(k, true);
      expect(live.length).to.equal(20);
      const [bn, ts] = await at();
      for (let i = 0; i < 10; i++) {
        const sel = await keeper.connect(fakeAgg).selectArbiters.staticCall(SP(20), rndSeed(), bn, ts);
        expect(sel.map((s) => s.key).sort()).to.deep.equal([...live].sort());
      }
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

    it("item 8: fees below the floor weigh the same, and a fee at or below the base cost gets the full boost", async () => {
      // arbs 0-5 cheap, arbs 6-11 at the ceiling (no boost); scaling factor 5
      const cheap = arbs.slice(0, 6).map((a) => a.key);
      for (const a of arbs.slice(6)) await keeper.setFee(a.key, H.MAX_FEE);
      const share = async (minFee) => {
        let c = 0;
        const n = 120;
        for (let r = 0; r < n; r++) {
          const [bn, ts] = await at();
          const sel = await keeper.connect(fakeAgg).selectArbiters.staticCall({ ...SP(1), minFee }, rndSeed(), bn, ts);
          if (cheap.includes(sel[0].key)) c++;
        }
        return c / n;
      };
      // no floor: the cheap arbiters get the full 5x boost, 6*5 / (6*5 + 6) = 83%
      expect(await share(0)).to.be.above(0.7);
      // a floor at the ceiling: every arbiter costs the requester the same, so 50%
      expect(await share(H.MAX_FEE)).to.be.within(0.33, 0.67);
      // posted at the base cost: the full boost (v1 gave none, while a fee just above it got nearly 5x)
      for (const a of arbs.slice(0, 6)) await keeper.setFee(a.key, H.BASE_COST);
      expect(await share(0)).to.be.above(0.7);
    });
  });
});
