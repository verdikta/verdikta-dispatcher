// sec4-outside: how the v2 contracts age. Compressed months: many rounds on one pool (checkpoints and
// head checkpoints per key, settleQueue), then churn (register / exit / re-register) and a sparse class
// list. Prints gas against N; asserts only the per-transaction cap.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

const TX_CAP = 16_777_216;
const ROUNDS = Number(process.env.AGING_ROUNDS || 240);
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Opt-in (a few minutes): AGING=1 npx hardhat test test/aging.outside.test.js
(process.env.AGING ? describe : describe.skip)("aging (sec4-outside)", function () {
  this.timeout(3_600_000);
  const report = [];

  it("many rounds on one pool: draw, promote and settle gas stay flat as history grows", async () => {
    const core = await H.deployCore();
    const requester = (await ethers.getSigners())[1];
    // long hash chains: ~1 health answer per arbiter per round
    const signers = await ethers.getSigners();
    const OpF = await ethers.getContractFactory("TestOperator");
    const arbs = [];
    for (let i = 0; i < 10; i++) {
      const node = signers[10 + i];
      const op = await OpF.deploy(await core.link.getAddress(), ethers.Wallet.createRandom().address, node.address);
      await op.setGate(await core.keeper.getAddress());
      const jobId = ethers.zeroPadValue(ethers.toBeHex(i + 1), 32);
      const ch = H.makeChain(ROUNDS * 2 + 50);
      await core.keeper.registerArbiter(await op.getAddress(), jobId, H.FEE, [1], ch.head);
      arbs.push({ op, opAddr: await op.getAddress(), jobId, key: await core.keeper.keyOf(await op.getAddress(), jobId), node, ch });
    }
    const drv = new RoundDriver(core, arbs, requester, { jury: H.jury(6, 5, 4, 3, 300) });
    const marks = new Set([1, 10, 30, 60, 120, ROUNDS]);
    for (let i = 1; i <= ROUNDS; i++) {
      drv.gas = {};
      await drv.fullRound();
      if (marks.has(i)) {
        const key = arbs[0].key;
        const v = await core.keeper.getArbiter(key);
        const row = {
          rounds: i,
          checkpointsKey0: Number(v.checkpoints),
          settleQueue: Number(await core.agg.settleHead()),
          draw: med(drv.gas["drawJury (select + dispatch K)"]),
          promote: med(drv.gas["promote (dispatches M reveals)"]),
          settle: med(drv.gas["settle (applyOutcomes x K)"]),
          request: med(drv.gas["request (escrow)"]),
          health: med(drv.gas["health answer"] || [0]),
        };
        report.push(["rounds", row]);
        for (const k of ["draw", "promote", "settle", "request"]) expect(row[k]).to.be.lessThan(TX_CAP);
      }
    }
  });

  it("churn: a class list that peaked high and thinned out (freed slots are visits)", async () => {
    const core = await H.deployCore();
    const signers = await ethers.getSigners();
    const requester = signers[1];
    const PEAK = Number(process.env.AGING_PEAK || 1200);
    const all = await H.registerArbiters(core, PEAK, { cls: 1, jobsPerOperator: 20 });
    const g0 = Number((await core.keeper.eligibleCount.estimateGas(1, H.MAX_FEE)));
    // most exit; their slots are freed (zeroed) but the list keeps its length
    const stay = new Set();
    for (let i = 0; i < PEAK; i += 20) stay.add(i);         // keep 1 in 20 (5%)
    const leaving = all.filter((_, i) => !stay.has(i));
    for (const a of leaving) await core.keeper.requestExit(a.key);
    await time.increase(2 * 86400 + 1);
    for (const a of leaving) await core.keeper.completeExit(a.key);
    const kept = all.filter((_, i) => stay.has(i));
    const classSize = Number(await core.keeper.classSize(1));
    const free = Number(await core.keeper.freeSlotCount(1));
    const g1 = Number((await core.keeper.eligibleCount.estimateGas(1, H.MAX_FEE)));
    report.push(["churn", { peak: PEAK, active: kept.length, classSize, freeSlots: free, scansAll: await core.keeper.scansAll(1), eligibleCountGasPeak: g0, eligibleCountGasAfter: g1 }]);
    // jury draws from the thinned list: how many distinct arbiters does a Large / Jumbo jury get?
    for (const [name, j] of [["Small", H.jury(6, 5, 4, 3, 300)], ["Large", H.jury(21, 16, 13, 10, 300)], ["Jumbo", H.jury(50, 38, 27, 17, 600)]]) {
      const drv = new RoundDriver(core, kept, requester, { jury: j });
      const distinct = [];
      const gas = [];
      for (let t = 0; t < 4; t++) {
        const r = await drv.requestOnly();
        try {
          await drv.draw(r);
          distinct.push(new Set(Object.values(r.slots).map((s) => s.arb && s.arb.key)).size);
          gas.push(Number(r.rcpt.gasUsed));
        } catch (e) { distinct.push("revert:" + (e.shortMessage || e.message).slice(0, 40)); }
        await time.increase(j.timeout + 1);
        await core.agg.settle(r.aggId).catch(() => {});
        // the drawn arbiters answer their health calls, so the pool stays live for the next draw
        await drv.answerAll(r).catch(() => {});
      }
      report.push(["churn draw " + name, { distinctPerDraw: distinct.join(","), drawGas: gas.join(",") }]);
    }
    // re-registration reuses freed slots: the list does not grow
    const back = leaving.slice(0, 100);
    for (const a of back) await core.keeper.registerArbiter(a.opAddr, a.jobId, H.FEE, [1], H.makeChain().head);
    report.push(["re-register 100", { classSize: Number(await core.keeper.classSize(1)), freeSlots: Number(await core.keeper.freeSlotCount(1)) }]);
  });

  it("eligibleCount (an off-chain view) against class size", async () => {
    const core = await H.deployCore();
    const rows = [];
    let have = 0;
    for (const n of [100, 400, 1600]) {
      await H.registerArbiters(core, n - have, { cls: 1, jobsPerOperator: 50 });
      have = n;
      rows.push(`${n}: ${Number(await core.keeper.eligibleCount.estimateGas(1, H.MAX_FEE))}`);
    }
    report.push(["eligibleCount gas", rows.join("  ")]);
  });

  after(() => {
    console.log("\n=== aging report ===");
    for (const [k, v] of report) console.log(k, typeof v === "string" ? v : JSON.stringify(v));
  });
});
