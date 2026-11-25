// Security review PoCs for ReputationKeeper (keeper reviewer, 2026-11-25).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");

const DAY = 24 * 3600;

describe("ReputationKeeper security PoCs", function () {
  let core, keeper, token, arbs, fakeAgg, signers;

  const SP = (count, maxFee = H.MAX_FEE) => ({
    count, alpha: 500, maxFee, minFee: 0, estimatedBaseCost: H.BASE_COST, maxFeeBasedScalingFactor: 5, requestedClass: 1,
  });
  async function at() {
    await ethers.provider.send("evm_mine", []);
    const b = await ethers.provider.getBlock((await ethers.provider.getBlockNumber()) - 1);
    return [b.number, b.timestamp];
  }
  const rndSeed = () => ethers.hexlify(ethers.randomBytes(32));

  beforeEach(async () => {
    core = await H.deployCore({ withAggregator: false });
    ({ keeper, token } = core);
    signers = await ethers.getSigners();
    fakeAgg = signers[2];
    await keeper.setApproved(fakeAgg.address, true);
    arbs = await H.registerArbiters(core, 12);
  });

  // ------------------------------------------------------------------ pool payee
  describe("arbiter pool pick", () => {
    /** an attacker operator (owned by `atk`) with `n` keys registered in class 1 */
    async function attacker(n, atk) {
      const op = await (await ethers.getContractFactory("TestOperator"))
        .deploy(await core.link.getAddress(), atk.address, atk.address);
      await token.transfer(atk.address, H.STAKE * 40n);
      await token.connect(atk).approve(await keeper.getAddress(), ethers.MaxUint256);
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(await reg(op, atk, 1000 + i));
      return { op, keys };
    }
    async function reg(op, atk, j) {
      const jobId = ethers.zeroPadValue(ethers.toBeHex(j), 32);
      await keeper.connect(atk).registerArbiter(await op.getAddress(), jobId, H.FEE, [1], H.makeChain().head);
      return keeper.keyOf(await op.getAddress(), jobId);
    }

    it("the pick reads only state as of the request block: registering after B cannot steer it", async () => {
      const atk = signers[5];
      const A = await attacker(1, atk);
      let base = 0, steered = 0;
      const N = 40;
      for (let s = 0; s < N; s++) {
        const [bn, ts] = await at();
        const seed = rndSeed();
        const snap = await ethers.provider.send("evm_snapshot", []);
        if ((await keeper.poolPayeeAt(seed, bn, ts)) === atk.address) base++;
        // the attacker knows the seed (blockhash(B+1)) and registers more keys before the draw
        let won = false;
        for (let k = 0; k < 6 && !won; k++) {
          await reg(A.op, atk, 2000 + s * 10 + k);
          await ethers.provider.send("evm_mine", []);
          won = (await keeper.poolPayeeAt(seed, bn, ts)) === atk.address;
        }
        if (won) steered++;
        await ethers.provider.send("evm_revert", [snap]);
      }
      // as of B the extra keys do not exist, so they change nothing
      expect(steered).to.equal(base);
    });

    it("legacy poolPayee(seed) reads live state: registrations after the seed is known steer it (PoC)", async () => {
      const atk = signers[5];
      const A = await attacker(1, atk);
      let base = 0, steered = 0;
      const N = 40;
      for (let s = 0; s < N; s++) {
        const seed = rndSeed();
        const snap = await ethers.provider.send("evm_snapshot", []);
        if ((await keeper.poolPayee(seed)) === atk.address) base++;
        let won = false;
        for (let k = 0; k < 6 && !won; k++) {
          await reg(A.op, atk, 2000 + s * 10 + k);
          won = (await keeper.poolPayee(seed)) === atk.address;
        }
        if (won) steered++;
        await ethers.provider.send("evm_revert", [snap]);
      }
      console.log(`      legacy pick: attacker (1 of 13 keys) wins ${base}/${N} honestly, ${steered}/${N} steering with <= 6 extra registrations`);
      expect(steered).to.be.greaterThan(base * 2);
    });

    it("frozen (dead) and blocked arbiters do not win the pool; paused ones do not either", async () => {
      const [bn0] = await at();
      // freeze all but arbs[0]; block arbs[1] instead of freezing it
      await keeper.sendHealthCalls(arbs.slice(2).map((a) => a.key));
      await time.increase(61);
      for (let i = 0; i < 3; i++) await keeper.connect(fakeAgg).applyOutcomes([arbs[1].key], [H.code(H.T.MISS_FAILED)], (await time.latest()) + 1);
      const [bn, ts] = await at();
      expect(bn).to.be.greaterThan(bn0);
      const winner = await arbs[0].op.owner();
      for (let i = 0; i < 20; i++) {
        const w = await keeper.poolPayeeAt(ethers.id(`p${i}`), bn, ts);
        expect([winner, ethers.ZeroAddress]).to.include(w);
      }
    });

    it("the as-of-B pick fits the aggregator's 80k pool stipend, also for keys changed since B", async () => {
      const [bn, ts] = await at();
      for (const a of arbs) await keeper.setFee(a.key, H.FEE + 1n);   // every key has a checkpoint after B
      for (let i = 0; i < 8; i++) {
        const g = await keeper.poolPayeeAt.estimateGas(ethers.id(`g${i}`), bn, ts);
        expect(g).to.be.lessThan(80_000n);
      }
    });

    it("exits keep the registry slots dense in use: a freed slot is reused and registryLength counts registered arbiters", async () => {
      const a = arbs[3];
      await keeper.requestExit(a.key);
      await time.increase(2 * DAY + 1);
      await keeper.completeExit(a.key);
      expect(await keeper.registryLength()).to.equal(11n);
      await expect(keeper.completeExit(a.key)).to.be.reverted;   // nothing left to exit
      const atk = signers[5];
      await attacker(1, atk);
      expect(await keeper.registryLength()).to.equal(12n);
      expect(await keeper.registrySlots()).to.equal(12n);   // took the freed slot
    });
  });

  // ------------------------------------------------------------------ health answers
  describe("health answers", () => {
    it("a duplicate (stale) answer of an already revealed value reverts instead of re-syncing and freezing", async () => {
      const a = arbs[0];
      await keeper.sendHealthCalls([a.key]);
      const v = a.ch.next();
      await keeper.connect(a.node).rotateChain(a.key, v, v);         // the answer lands
      // the health job re-sends the same answer (tx delayed past the adapter's 20 s in-flight window)
      await expect(keeper.connect(a.node).rotateChain(a.key, v, v)).to.be.revertedWithCustomError(keeper, "StaleAnswer");
      expect(await keeper.isEligible(a.key, H.MAX_FEE)).to.equal(true);
      // an older revealed value (a lagging RPC) is refused too
      await keeper.sendHealthCalls([a.key]);
      const v2 = a.ch.next();
      await keeper.connect(a.node).answerHealthCall(a.key, v2);
      await expect(keeper.connect(a.node).answerHealthCall(a.key, v)).to.be.revertedWithCustomError(keeper, "StaleAnswer");
      // a fresh value still re-syncs
      await expect(keeper.connect(a.node).answerHealthCall(a.key, H.makeChain().head)).to.emit(keeper, "ChainResynced");
    });

    it("a juror can dodge the no-commit penalty by re-syncing just before the round deadline (PoC, not fixed)", async () => {
      const a = arbs[0];
      const [bn, ts] = await at();
      await keeper.connect(fakeAgg).selectArbiters(SP(12), rndSeed(), bn, ts);  // every arbiter is a juror
      await keeper.connect(a.node).answerHealthCall(a.key, a.ch.next());       // answers the draw's call: live
      const deadline = (await time.latest()) + 300;
      await time.setNextBlockTimestamp(deadline);
      await keeper.connect(a.node).answerHealthCall(a.key, H.makeChain().head); // re-sync at the deadline: frozen at once
      await time.increase(10);
      // settlement: the round failed for lack of commits, a did not commit
      await expect(keeper.connect(fakeAgg).applyOutcomes([a.key], [H.code(H.T.NOCOMMIT_FAILED)], deadline))
        .to.emit(keeper, "OutcomeSkippedFrozen");
      expect((await keeper.getArbiter(a.key)).timeliness).to.equal(500n);
    });

    it("the owner's sendHealthCalls skips unregistered keys (no checkpoint that would zero a later registration's scores)", async () => {
      const op = arbs[0].op;
      const jobId = ethers.zeroPadValue("0x7777", 32);
      const key = await keeper.keyOf(await op.getAddress(), jobId);
      await keeper.sendHealthCalls([key]);
      await keeper.registerArbiter(await op.getAddress(), jobId, H.FEE, [1], H.makeChain().head);
      const v = await keeper.getArbiter(key);
      expect(v.quality).to.equal(500n);
      expect(v.timeliness).to.equal(500n);
    });
  });

  // ------------------------------------------------------------------ selection padding
  describe("selection walk padding", () => {
    it("ineligible padding in a class makes the bounded walk find few arbiters, so juries repeat (PoC, not fixed)", async () => {
      // scaled down: shortlist 10, maxScan 20 (mainnet 60 / 400); 12 eligible honest arbiters
      await keeper.setSelection(10, 20, 0);
      const atk = signers[5];
      await token.transfer(atk.address, H.STAKE * 100n);
      await token.connect(atk).approve(await keeper.getAddress(), ethers.MaxUint256);
      const op = await (await ethers.getContractFactory("TestOperator"))
        .deploy(await core.link.getAddress(), atk.address, atk.address);
      for (let i = 0; i < 60; i++) {   // paused padding: never selected, never scored
        const jobId = ethers.zeroPadValue(ethers.toBeHex(5000 + i), 32);
        await keeper.connect(atk).registerArbiter(await op.getAddress(), jobId, H.FEE, [1], H.makeChain().head);
        await keeper.connect(atk).setPaused(await keeper.keyOf(await op.getAddress(), jobId), true);
      }
      expect(await keeper.scansAll(1)).to.equal(false);
      let repeats = 0, fails = 0;
      const N = 40;
      for (let r = 0; r < N; r++) {
        const [bn, ts] = await at();
        try {
          const sel = await keeper.connect(fakeAgg).selectArbiters.staticCall(SP(6), rndSeed(), bn, ts);
          if (new Set(sel.map((s) => s.key)).size < 6) repeats++;
        } catch (e) { fails++; }
      }
      console.log(`      12 eligible + 60 paused padding: ${repeats}/${N} juries of 6 had repeats, ${fails}/${N} found none`);
      expect(repeats + fails).to.be.greaterThan(N / 2);
    });
  });

  // ------------------------------------------------------------------ roles
  describe("least-privilege approvals", () => {
    it("setRoles grants the operator gate, selection and scoring separately; setApproved grants all three", async () => {
      const x = signers[6];
      await keeper.setRoles(x.address, 1);   // ROLE_GATE only
      expect(await keeper.isContractApproved(x.address)).to.equal(true);
      expect(await keeper.approvedContracts(x.address)).to.equal(false);
      await expect(keeper.connect(x).applyOutcomes([arbs[0].key], [H.code(H.T.MISS_FAILED)], 0))
        .to.be.revertedWithCustomError(keeper, "NotApproved");
      const [bn, ts] = await at();
      await expect(keeper.connect(x).selectArbiters(SP(1), rndSeed(), bn, ts)).to.be.revertedWithCustomError(keeper, "NotApproved");
      await keeper.setRoles(x.address, 2);   // ROLE_SELECT: selection and the beacon pick, no scoring, no gate
      expect(await keeper.isContractApproved(x.address)).to.equal(false);
      await keeper.connect(x).pickBeacons(rndSeed(), 1, bn, ts, 2, H.MAX_FEE);
      await expect(keeper.connect(x).applyOutcomes([arbs[0].key], [H.code(H.T.MISS_FAILED)], 0))
        .to.be.revertedWithCustomError(keeper, "NotApproved");
      await keeper.setApproved(x.address, true);
      expect(await keeper.roles(x.address)).to.equal(7n);
      expect(await keeper.approvedContracts(x.address)).to.equal(true);
      await keeper.setApproved(x.address, false);
      expect(await keeper.roles(x.address)).to.equal(0n);
    });
  });
  // ------------------------------------------------------------------ checkpoint lookups
  describe("checkpoint lookups (search back from the end)", () => {
    it("the state and the hash-chain reveal as of every past block match a replay", async () => {
      // one arbiter alone in class 9, toggled paused / unpaused and answering across 40 blocks
      const op = arbs[0].op;
      const jobId = ethers.zeroPadValue("0x0999", 32);
      const ch = H.makeChain(128);
      await keeper.registerArbiter(await op.getAddress(), jobId, H.FEE, [9], ch.head);
      const key = await keeper.keyOf(await op.getAddress(), jobId);
      const node = arbs[0].node;
      const hist = [];   // [block, paused, headAfter]
      let paused = false, head = ch.head;
      hist.push([await ethers.provider.getBlockNumber(), paused, head]);
      for (let i = 0; i < 40; i++) {
        if (i % 3 !== 2) { paused = !paused; await keeper.setPaused(key, paused); }
        else { head = ch.next(); await keeper.connect(node).answerHealthCall(key, head); }
        hist.push([await ethers.provider.getBlockNumber(), paused, head]);
        if (i % 5 === 0) await ethers.provider.send("evm_mine", []);
      }
      await ethers.provider.send("evm_mine", []);
      const ts = await time.latest();
      const first = hist[0][0], last = hist[hist.length - 1][0];
      for (let b = first; b <= last; b++) {
        let st = hist[0];
        for (const h of hist) if (h[0] <= b) st = h;
        const got = await keeper.connect(fakeAgg).pickBeacons.staticCall(rndSeed(), 9, b, ts, 1, H.MAX_FEE);
        expect(got.length, `block ${b}`).to.equal(st[1] ? 0 : 1);
        // revealAfter(b): the first answer after b reveals the preimage of the head as of b
        const nxt = hist.find((h) => h[0] > b && h[2] !== st[2]);
        const r = await keeper.revealAfter(key, b);
        expect(r.value, `reveal after ${b}`).to.equal(nxt ? nxt[2] : ethers.ZeroHash);
      }
    });
  });
});

