// Stateful solvency fuzz (security review "agg", 2026-11-25). Random interleavings of requests (credit and
// value, fee floors, beacons, juries), draws by the requester or others, beacon answers, commits, closes,
// promotions, reveals, settlements, cancellations and withdrawals. After every step:
//   balance == sum of ethOwed + the unspent escrow of every round not yet finalized or ended,
// and every round's credited total stays within what it received.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

function rng(seed) {
  let s = BigInt(seed) | 1n;
  return () => {
    s ^= s << 13n; s &= (1n << 64n) - 1n; s ^= s >> 7n; s ^= s << 17n; s &= (1n << 64n) - 1n;
    return Number(s % 1000000n) / 1e6;
  };
}

describe("solvency fuzz (agg)", function () {
  this.timeout(1_200_000);
  const SEEDS = (process.env.FUZZ_SEEDS || "7,1234").split(",").map(Number);
  const STEPS = Number(process.env.FUZZ_STEPS || 90);

  for (const seed of SEEDS) {
    it(`seed ${seed}: balance == ethOwed + open escrow after every step`, async () => {
      const R = rng(seed);
      const pick = (a) => a[Math.floor(R() * a.length)];
      const core = await H.deployCore();
      const { agg, keeper } = core;
      const signers = await ethers.getSigners();
      const [deployer, req1, req2, stranger] = signers;
      const arbs = await H.registerArbiters(core, 12);
      await keeper.setSelection(60, 400, 0);
      await H.installHistory();
      const drivers = [req1, req2].map((rq) => ({ rq, drv: new RoundDriver(core, arbs, rq), drvB: new RoundDriver(core, arbs, rq, { beacons: true }) }));
      const addrs = new Set([deployer.address, req1.address, req2.address, stranger.address, ethers.ZeroAddress]);
      for (const a of arbs) addrs.add(await a.op.owner());
      const rounds = [];
      const juries = [H.jury(6, 5, 4, 3), H.jury(4, 3, 2, 2), H.jury(3, 1, 1, 1), H.jury(8, 6, 5, 3, 400)];
      const counts = {};
      const note = (k) => (counts[k] = (counts[k] || 0) + 1);

      async function check(step) {
        let owed = 0n;
        for (const a of addrs) owed += await agg.ethOwed(a);
        let open = 0n;
        for (const r of rounds) {
          const i = await agg.getRoundInfo(r.aggId);
          const credited = i.baseFees + i.bonuses + i.rewards;
          expect(credited <= i.received, `round ${r.aggId} over-credited`).to.equal(true);
          if (Number(i.phase) <= 5) open += i.received - credited;
        }
        const bal = await ethers.provider.getBalance(agg.target);
        expect(bal, `step ${step}`).to.equal(owed + open);
      }

      const errs = {};
      const tryDo = async (k, f) => {
        try { await f(); note(k); } catch (e) {
          note(k + "!");
          const m = (e.shortMessage || e.message || "").slice(0, 90);
          errs[k + ": " + m] = (errs[k + ": " + m] || 0) + 1;
        }
      };

      for (let step = 0; step < STEPS; step++) {
        const x = R();
        const live = [];
        for (const r of rounds) live.push([r, Number((await agg.getRoundInfo(r.aggId)).phase)]);
        const inPh = (ph) => live.filter(([, p]) => p === ph).map(([r]) => r);
        if (x < 0.12 || rounds.length === 0) {
          const d = pick(drivers);
          const beacons = R() < 0.25;
          const drv = beacons ? d.drvB : d.drv;
          const jury = pick(juries);
          const minFee = R() < 0.3 ? H.FEE * 3n : 0n;
          const q = await H.quote(agg, H.MAX_FEE, minFee, beacons, jury);
          const credit = await agg.ethOwed(d.rq.address);
          const value = R() < 0.3 && credit >= q / 2n ? q - q / 2n : R() < 0.3 ? q + 12345n : q;
          await tryDo("request", async () => {
            const r = await drv.requestOnly({ value, minFee, jury, beacons });
            rounds.push({ ...r, drv, jury });
          });
        } else if (x < 0.30) {
          const r = pick(inPh(1).concat(inPh(2)));
          if (r) {
            const by = R() < 0.6 ? r.drv.requester : stranger;
            if (R() < 0.3) await time.increase(31);
            await tryDo("draw", async () => {
              await mine(2);
              const before = Number((await agg.getRoundInfo(r.aggId)).phase);
              if (before === 1 && r.drv.beacons) {
                await r.drv.beaconStage(r, { by, waitBlocks: 0, answering: Math.floor(R() * 5) });
              } else if (before === 2) {
                if (R() < 0.3) await time.increase(130);
                await r.drv.draw(r, { by, waitBlocks: 0 });
              } else {
                await r.drv.draw(r, { by, waitBlocks: 0 });
              }
              if (Number((await agg.getRoundInfo(r.aggId)).phase) === 3) await r.drv.answerAll(r);
            });
          }
        } else if (x < 0.50) {
          const r = pick(inPh(3));
          if (r && r.slots) {
            const slots = Object.keys(r.slots).map(Number).filter((s) => !r.slots[s].committed);
            const n = 1 + Math.floor(R() * slots.length);
            for (const s of slots.slice(0, n)) {
              const v = R() < 0.6 ? H.vec(500_000 + Math.floor(R() * 100) * 1000) : [BigInt(Math.floor(R() * 1e6))];
              await tryDo("commit", () => r.drv.commit(r, s, R() < 0.8 ? v : H.vec(Math.floor(R() * 1e6))));
            }
            if (R() < 0.2) { await time.increase(160); await tryDo("close", () => r.drv.closeCommits(r)); }
          }
        } else if (x < 0.58) {
          const r = pick(inPh(4));
          if (r) await tryDo("promote", () => r.drv.promote(r, { by: pick([stranger, r.drv.requester]) }));
        } else if (x < 0.75) {
          const r = pick(inPh(5).concat(inPh(6)));
          if (r) {
            const ps = r.drv.promotedSlots(r).filter((sl) => !r.slots[sl].revealed);
            for (const s of ps.slice(0, 1 + Math.floor(R() * ps.length)))
              await tryDo("reveal", async () => { await r.drv.reveal(r, s); r.slots[s].revealed = true; });
          }
        } else if (x < 0.85) {
          await time.increase(pick([10, 30, 60, 200, 200, 500, 3600]));
          if (R() < 0.5) { const d = pick(drivers); await tryDo("settleDue", async () => rounds.push({ ...(await d.drv.requestOnly()), drv: d.drv })); }
          const r = pick(rounds);
          await tryDo("settle", () => agg.settle(r.aggId, { gasLimit: 16_000_000 }));
        } else if (x < 0.865) {
          const r = pick(inPh(1).concat(inPh(2)));
          if (r) {
            if (R() < 0.5) await mine(8200); else await time.increase(86401);
            await tryDo("cancel", () => agg.connect(stranger).cancelUnsealed(r.aggId));
          }
        } else if (x < 0.93) {
          // a burst: one committed-phase round driven through close, promote and (some) reveals
          const r = pick(inPh(3));
          if (r && r.slots) {
            for (const s of Object.keys(r.slots).map(Number)) {
              if (!r.slots[s].committed && R() < 0.85) await tryDo("commit", () => r.drv.commit(r, s, R() < 0.7 ? H.vec(600_000 + Math.floor(R() * 40) * 1000) : H.vec(Math.floor(R() * 1e6))));
            }
            if (Number((await agg.getRoundInfo(r.aggId)).phase) === 3) { await time.increase(160); await tryDo("close", () => r.drv.closeCommits(r)); }
            if (R() < 0.9) await tryDo("promote", () => r.drv.promote(r, { by: pick([stranger, r.drv.requester]) }));
            for (const s of r.drv.promotedSlots(r)) {
              if (!r.slots[s].revealed && R() < 0.85) await tryDo("reveal", async () => { await r.drv.reveal(r, s); r.slots[s].revealed = true; });
            }
          }
        } else {
          const who = pick(signers.slice(0, 4));
          await tryDo("withdraw", () => agg.connect(who).withdrawEth());
        }
        await check(step);
      }
      // end: settle everything that can be, then check again
      await time.increase(90_000);
      for (const r of rounds) await tryDo("final settle", () => agg.settle(r.aggId, { gasLimit: 16_000_000 }));
      await check("end");
      console.log(`      seed ${seed}: ${JSON.stringify(counts)}`);
      if (process.env.FUZZ_ERRS) console.log(errs);
    });
  }
});
