// Dense class lists, eviction and the class-health views (review 2026-11-27, item 1).
//
// Before: completeExit left a hole in every class list of the arbiter for good, and a selection walk
// visits at most maxScan (400) slots, holes included. Registering junk keys and exiting them (all the
// stake back after the 2-day unbonding) thinned every later jury of the class.
// Now: a hole is closed by moving the last listed arbiter into it (recorded for a day, so a draw still
// reads the list as of its request block), idle arbiters can be evicted from the lists after
// evictAfter (2 days), and classStats shows a list's slots against its arbiters.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");

const DAY = 24 * 3600;

describe("ReputationKeeper: dense lists, eviction (review 2026-11-27, item 1)", function () {
  this.timeout(600_000);
  let core, keeper, token, arbs, fakeAgg, signers;

  const SP = (count, cls = 1) => ({
    count, alpha: 500, maxFee: H.MAX_FEE, minFee: 0, estimatedBaseCost: H.BASE_COST, maxFeeBasedScalingFactor: 5, requestedClass: cls,
  });
  async function at() {
    await ethers.provider.send("evm_mine", []);
    const b = await ethers.provider.getBlock((await ethers.provider.getBlockNumber()) - 1);
    return [b.number, b.timestamp];
  }
  const seedOf = (i) => ethers.id(`seed ${i}`);
  const jury = async (count, seed, B, cls = 1) => (await keeper.connect(fakeAgg).selectArbiters.staticCall(SP(count, cls), seed, B[0], B[1])).map((s) => s.key);
  // every eligible arbiter of the class, as the walk finds them (the beacon pick returns each it meets)
  const eligibleSet = async (B, cls = 1, seed = seedOf("set")) => [...(await keeper.connect(fakeAgg).pickBeacons.staticCall(seed, cls, B[0], B[1], 200, H.MAX_FEE))];
  const stats = async (cls = 1) => (await keeper.classStats(cls)).map(Number);

  beforeEach(async () => {
    core = await H.deployCore({ withAggregator: false });
    ({ keeper, token } = core);
    signers = await ethers.getSigners();
    fakeAgg = signers[2];
    await keeper.setApproved(fakeAgg.address, true);
    arbs = await H.registerArbiters(core, 12);
  });

  describe("the dilution attack no longer lasts", () => {
    it("junk keys registered and exited leave no holes behind: the list returns to its arbiters and juries to six distinct", async () => {
      const N = 300;
      const attacker = signers[3];
      await token.transfer(attacker.address, (await keeper.stakeRequirement()) * BigInt(N));
      await token.connect(attacker).approve(await keeper.getAddress(), ethers.MaxUint256);
      const op = await (await ethers.getContractFactory("TestOperator")).deploy(await core.link.getAddress(), attacker.address, attacker.address);
      const opAddr = await op.getAddress();
      const keys = [];
      for (let i = 0; i < N; i++) {
        const jobId = ethers.zeroPadValue(ethers.toBeHex(1_000_000 + i), 32);
        await keeper.connect(attacker).registerArbiter(opAddr, jobId, 1, [1], ethers.id("head"));
        const key = await keeper.keyOf(opAddr, jobId);
        await keeper.connect(attacker).requestExit(key);
        keys.push(key);
      }
      expect(await stats()).to.deep.equal([12 + N, 12 + N, 0]);
      await time.increase(2 * DAY + 10);
      const bal0 = await token.balanceOf(attacker.address);
      for (const k of keys) await keeper.connect(attacker).completeExit(k);
      expect(await token.balanceOf(attacker.address) - bal0).to.equal((await keeper.stakeRequirement()) * BigInt(N));
      expect((await stats())[1]).to.equal(12);
      // anyone tidies up: within a day or two the list is its 12 arbiters again (the junk keys were last,
      // so nothing honest had to move; a ghost or a hole only ever sits where a junk key was)
      for (let i = 0; i < 3 && (await stats())[0] > 12; i++) {
        await time.increase(DAY + 1);
        await keeper.compact(1, 400);
      }
      expect(await stats()).to.deep.equal([12, 12, 0]);
      for (let i = 0; i < 40; i++) {
        const keysDrawn = await jury(6, seedOf(i), await at());
        expect(new Set(keysDrawn).size, `jury ${i}`).to.equal(6);
      }
    });

    it("holes in the middle (honest arbiters behind the junk) are closed by moves, each arbiter still drawn once", async () => {
      const junk = await H.registerArbiters(core, 30);
      const late = await H.registerArbiters(core, 8);               // honest arbiters registered after the junk
      for (const j of junk) await keeper.requestExit(j.key);
      await time.increase(2 * DAY + 10);
      for (const j of junk) await keeper.completeExit(j.key);
      const honest = [...arbs, ...late].map((a) => a.key).sort();
      expect([...(await eligibleSet(await at()))].sort()).to.deep.equal(honest);
      for (let i = 0; i < 6 && (await stats())[0] > 20; i++) {
        await time.increase(DAY + 1);
        await keeper.compact(1, 100);
        expect([...(await eligibleSet(await at()))].sort(), `round ${i}`).to.deep.equal(honest);
      }
      expect(await stats()).to.deep.equal([20, 20, 0]);
    });
  });

  describe("eviction", () => {
    it("a paused arbiter is evictable after evictAfter (2 days), not before; it returns when it unpauses", async () => {
      const a = arbs[4];
      expect(await keeper.evictAfter()).to.equal(BigInt(2 * DAY));
      await keeper.setPaused(a.key, true);
      await time.increase(2 * DAY - 60);
      await expect(keeper.connect(signers[7]).evict(a.key)).to.be.revertedWithCustomError(keeper, "NotEvictable");
      await time.increase(120);
      await expect(keeper.connect(signers[7]).evict(a.key)).to.emit(keeper, "ArbiterUnlisted").withArgs(a.key);   // anyone
      expect(await keeper.isListed(a.key)).to.equal(false);
      expect(await keeper.slotIn(a.key, 1)).to.equal(0n);
      expect((await stats())[1]).to.equal(11);
      await expect(keeper.evict(a.key)).to.be.revertedWithCustomError(keeper, "NotEvictable");   // already out
      // nothing else changed: registered, staked, scored
      const v = await keeper.getArbiter(a.key);
      expect([v.stake, v.quality, v.timeliness]).to.deep.equal([await keeper.stakeRequirement(), 500n, 500n]);
      expect(await keeper.arbiterClasses(a.key)).to.deep.equal([1n]);
      await expect(keeper.setPaused(a.key, false)).to.emit(keeper, "ArbiterListed").withArgs(a.key);
      expect(await keeper.isListed(a.key)).to.equal(true);
      expect(await eligibleSet(await at())).to.include(a.key);
      expect((await stats())[1]).to.equal(12);
    });

    it("an arbiter that is not idle is never evictable", async () => {
      await time.increase(10 * DAY);
      await expect(keeper.evict(arbs[0].key)).to.be.revertedWithCustomError(keeper, "NotEvictable");
      await expect(keeper.evict(ethers.id("no such key"))).to.be.revertedWithCustomError(keeper, "NotEvictable");
      // a pause shorter than evictAfter, however often repeated, never is either
      await keeper.setPaused(arbs[1].key, true);
      await time.increase(DAY);
      await keeper.setPaused(arbs[1].key, false);
      await keeper.setPaused(arbs[1].key, true);
      await time.increase(DAY + 3600);
      await expect(keeper.evict(arbs[1].key)).to.be.revertedWithCustomError(keeper, "NotEvictable");
    });

    it("a frozen arbiter (an unanswered health call) is evictable after evictAfter, and returns when it answers", async () => {
      const a = arbs[2];
      await keeper.sendHealthCalls([a.key]);
      await time.increase(61 + 2 * DAY - 120);
      expect(await keeper.isFrozen(a.key)).to.equal(true);
      await expect(keeper.evict(a.key)).to.be.revertedWithCustomError(keeper, "NotEvictable");
      await time.increase(240);
      await keeper.evict(a.key);
      expect(await keeper.isListed(a.key)).to.equal(false);
      await expect(keeper.connect(a.node).answerHealthCall(a.key, a.ch.next())).to.emit(keeper, "ArbiterListed").withArgs(a.key);
      expect(await eligibleSet(await at())).to.include(a.key);
    });

    it("an exiting arbiter is evictable from its exitAt, and completeExit still refunds it", async () => {
      const a = arbs[6];
      await keeper.requestExit(a.key);
      await time.increase(2 * DAY - 60);
      await expect(keeper.evict(a.key)).to.be.revertedWithCustomError(keeper, "NotEvictable");
      await time.increase(120);
      await keeper.connect(signers[7]).evict(a.key);
      expect((await stats())[1]).to.equal(11);
      const owner = await a.op.owner();
      await expect(keeper.completeExit(a.key)).to.changeTokenBalance(token, owner, await keeper.stakeRequirement());
      expect(await keeper.registryLength()).to.equal(11n);
    });

    it("a banned arbiter is evictable evictAfter after its block ends", async () => {
      const a = arbs[8];
      for (let i = 0; i < 3; i++) {                                 // three blocks: banned
        await keeper.connect(fakeAgg).applyOutcomes([a.key], [H.code(H.T.MISS_FAILED)], (await time.latest()) + 1);
        const v = await keeper.getArbiter(a.key);
        if (i < 2) await time.increaseTo(v.blockedUntil + 1n);
      }
      const v = await keeper.getArbiter(a.key);
      expect(v.flags & 4n).to.equal(4n);
      await expect(keeper.evict(a.key)).to.be.revertedWithCustomError(keeper, "NotEvictable");
      await time.increaseTo(v.blockedUntil + BigInt(2 * DAY) + 1n);
      await keeper.evict(a.key);
      expect(await keeper.isListed(a.key)).to.equal(false);
    });

    it("registered with head 0 (frozen until its node re-syncs): not listed until it answers a call", async () => {
      const op = arbs[0];
      const jobId = ethers.zeroPadValue(ethers.toBeHex(777), 32);
      await keeper.registerArbiter(op.opAddr, jobId, H.FEE, [1, 2], ethers.ZeroHash);
      const key = await keeper.keyOf(op.opAddr, jobId);
      expect(await keeper.isListed(key)).to.equal(false);
      expect(await stats(2)).to.deep.equal([0, 0, 0]);
      expect(await keeper.registryLength()).to.equal(13n);          // registered, staked
      const ch = H.makeChain();
      await keeper.connect(op.node).answerHealthCall(key, ch.head);            // the re-sync onto its chain
      expect(await keeper.isListed(key)).to.equal(false);
      await keeper.connect(op.node).answerHealthCall(key, ch.next());          // sends the call a re-sync waits for
      expect(await keeper.isListed(key)).to.equal(false);
      await expect(keeper.connect(op.node).answerHealthCall(key, ch.next())).to.emit(keeper, "ArbiterListed").withArgs(key);
      expect(await stats(2)).to.deep.equal([1, 1, 0]);
      expect(await keeper.isEligible(key, H.MAX_FEE)).to.equal(true);
    });

    it("the owner sets evictAfter, never below MAX_DRAW_AGE + 1 hour", async () => {
      await expect(keeper.connect(signers[5]).setEvictAfter(3 * DAY)).to.be.reverted;
      await expect(keeper.setEvictAfter(DAY + 3599)).to.be.revertedWithCustomError(keeper, "BadParams");
      await keeper.setEvictAfter(DAY + 3600);
      expect(await keeper.evictAfter()).to.equal(BigInt(DAY + 3600));
      await keeper.setPaused(arbs[0].key, true);
      await time.increase(DAY + 3601);
      await keeper.evict(arbs[0].key);
    });
  });

  describe("scripts/tidy-classes.js (the runbook's check)", () => {
    it("reports holes and evictable arbiters, and with send evicts and compacts", async () => {
      const { tidy } = require("../scripts/tidy-classes");
      const keys = arbs.map((a) => a.key);
      const quiet = { log() {} };
      let r = await tidy({ keeper, keys, now: await time.latest(), ...quiet });
      expect([r.attention, r.evictable.length, r.classes.get("1")]).to.deep.equal([false, 0, { slots: 12, listed: 12, ghosts: 0 }]);
      await keeper.setPaused(arbs[0].key, true);                    // paused 2 days: evictable
      await keeper.sendHealthCalls([arbs[1].key]);                  // frozen 2 days: evictable
      await keeper.setPaused(arbs[2].key, true);
      await time.increase(DAY);
      await keeper.setPaused(arbs[3].key, true);                    // paused 1 day: not yet
      await time.increase(DAY + 120);
      r = await tidy({ keeper, keys, now: await time.latest(), ...quiet });
      expect(r.attention).to.equal(true);
      expect(r.evictable.map((e) => e.key).sort()).to.deep.equal([arbs[0].key, arbs[1].key, arbs[2].key].sort());
      expect(r.sent).to.equal(0);
      r = await tidy({ keeper, keys, now: await time.latest(), send: true, ...quiet });
      expect(r.sent).to.be.greaterThan(3);
      expect((await stats())[1]).to.equal(9);
      await keeper.setPaused(arbs[3].key, false);                   // back before its 2 days were up
      await time.increase(DAY + 1);
      await tidy({ keeper, keys, now: await time.latest(), send: true, ...quiet });
      expect(await stats()).to.deep.equal([9, 9, 0]);
      r = await tidy({ keeper, keys, now: await time.latest(), ...quiet });
      expect(r.attention).to.equal(false);
    });
  });

  describe("scansAllAt: as of the request block", () => {
    it("a list longer than maxScan at B is not 'scanned whole' because it shrank later", async () => {
      await keeper.setSelection(4, 12, 3);                          // maxScan 12: the 12 arbiters just fit
      const extra = await H.registerArbiters(core, 1);
      const B = await at();
      expect(await keeper.scansAllAt(1, B[0])).to.equal(false);
      await keeper.requestExit(extra[0].key);
      await time.increase(2 * DAY + 1);
      await keeper.completeExit(extra[0].key);
      expect(await keeper.scansAll(1)).to.equal(true);              // now
      expect(await keeper.scansAllAt(1, B[0])).to.equal(false);     // as of B
    });
  });

  // The property everything rests on: whatever happens to the lists after block B (exits, evictions,
  // moves, returns, registrations, compaction), a draw as of B gives the same jury, the same beacons and
  // the same pool payee for as long as B can be read (MAX_DRAW_AGE), and a draw as of now meets every
  // eligible arbiter exactly once.
  for (const run of [1, 2, 3]) {
    it(`random list changes never change a draw as of an earlier block (run ${run})`, async () => {
      let r = BigInt(ethers.id(`lists run ${run}`));
      const rnd = (n) => { r = BigInt(ethers.keccak256(ethers.toBeHex(r, 32))); return Number(r % BigInt(n)); };
      const live = new Map(arbs.map((a) => [a.key, { a, paused: false, exiting: 0, listed: true }]));
      const snaps = [];
      const eligibleNow = () => [...live.values()].filter((x) => x.listed && !x.paused && !x.exiting).map((x) => x.a.key).sort();
      async function snapshot() {
        const B = await at();
        const seed = seedOf(`${run}-${snaps.length}`);
        if (eligibleNow().length === 0) return;
        snaps.push({ B, seed, jury: await jury(5, seed, B), set: await eligibleSet(B, 1, seed), payee: await keeper.poolPayeeAt(seed, B[0], B[1]) });
      }
      async function check(what) {
        const now = await time.latest();
        for (const s of snaps) {
          if (s.B[1] + DAY < now + 5) continue;                     // no longer readable (StaleBlock)
          expect(await jury(5, s.seed, s.B), `jury as of ${s.B[0]} after ${what}`).to.deep.equal(s.jury);
          expect(await eligibleSet(s.B, 1, s.seed), `beacons as of ${s.B[0]} after ${what}`).to.deep.equal(s.set);
          expect(await keeper.poolPayeeAt(s.seed, s.B[0], s.B[1]), `payee as of ${s.B[0]} after ${what}`).to.equal(s.payee);
        }
        // as of now: every eligible arbiter met once, nothing else
        const set = await eligibleSet(await at());
        expect([...set].sort(), `the walk now, after ${what}`).to.deep.equal(eligibleNow());
        const [slots, listed] = await stats();
        expect(listed, `listed after ${what}`).to.equal([...live.values()].filter((x) => x.listed).length);
        expect(slots).to.be.at.least(listed);
      }
      for (let step = 0; step < 70; step++) {
        const all = [...live.values()];
        const pick = (f) => { const c = all.filter(f); return c.length ? c[rnd(c.length)] : null; };
        const now = await time.latest();
        let what = "";
        switch (rnd(9)) {
          case 0: {
            const [a] = await H.registerArbiters(core, 1, { nodes: signers.slice(10, 40) });
            // registerArbiters numbers job ids from 1 per call: use a fresh operator each time (it does)
            live.set(a.key, { a, paused: false, exiting: 0, listed: true });
            what = "a registration";
            break;
          }
          case 1: {
            const x = pick((v) => !v.exiting && all.filter((w) => !w.exiting).length > 6);
            if (!x) continue;
            await keeper.requestExit(x.a.key);
            x.exiting = (await time.latest()) + 2 * DAY;
            what = "requestExit";
            break;
          }
          case 2: {
            const x = pick((v) => v.exiting && v.exiting <= now);
            if (!x) continue;
            await keeper.completeExit(x.a.key);
            live.delete(x.a.key);
            what = "completeExit";
            break;
          }
          case 3: {
            const x = pick((v) => !v.paused && !v.exiting);
            if (!x) continue;
            await keeper.setPaused(x.a.key, true);
            x.paused = await time.latest();
            what = "a pause";
            break;
          }
          case 4: {
            const x = pick((v) => v.paused && !v.exiting);
            if (!x) continue;
            await keeper.setPaused(x.a.key, false);
            x.paused = false;
            x.listed = true;
            what = "an unpause";
            break;
          }
          case 5: {
            const x = pick((v) => v.listed && ((v.paused && v.paused + 2 * DAY < now) || (v.exiting && v.exiting <= now)));
            if (!x) continue;
            await keeper.connect(signers[7]).evict(x.a.key);
            x.listed = false;
            what = "an eviction";
            break;
          }
          case 6:
            await keeper.compact(1, 1 + rnd(20));
            await keeper.compactRegistry(1 + rnd(20));
            what = "compaction";
            break;
          default:
            await time.increase([600, 3600, 6 * 3600, 20 * 3600, DAY + 60, 2 * DAY + 60][rnd(6)]);
            what = "time passing";
        }
        await check(what);
        if (rnd(2) === 0) await snapshot();
      }
      expect(snaps.length).to.be.greaterThan(10);
    });
  }
});
