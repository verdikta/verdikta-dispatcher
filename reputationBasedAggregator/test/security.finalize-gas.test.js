// Security review "agg": how much colluding revealers can raise the finalizing (N-th) reveal's gas in a
// one-number round, which the N-th revealer's node pays. An arbiter's node sets its job gas limit from the
// class (TODO: "1.3M gas with one-number answers" at Jumbo); a reveal that runs out inside the callback is
// consumed by the operator and lost, and that arbiter is charged as a no-show.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

describe("security review (agg): finalizing-reveal gas", function () {
  this.timeout(600_000);
  const LARGE = H.jury(21, 16, 13, 10, 300);

  async function measure(colluders) {
    const core = await H.deployCore();
    const [, requester] = await ethers.getSigners();
    const arbs = await H.registerArbiters(core, 21);
    await core.keeper.setSelection(60, 400, 0);
    await H.installHistory();
    const drv = new RoundDriver(core, arbs, requester, { jury: LARGE });
    const r = await drv.request();
    await drv.answerAll(r);
    const slots = Object.keys(r.slots).map(Number);
    // colluders reveal 20 values; the honest a one-number answer
    const bad = new Set(slots.slice(0, colluders));
    const big = Array.from({ length: 20 }, (_, i) => BigInt(1e34) - BigInt(i));
    for (const s of slots) await drv.commit(r, s, bad.has(s) ? big : [BigInt(600_000 + s)]);
    if (!r.closing) { await time.increase(156); await drv.closeCommits(r); }
    await drv.promote(r);
    const prom = drv.promotedSlots(r);
    const order = prom.filter((s) => bad.has(s)).concat(prom.filter((s) => !bad.has(s)));
    let last;
    for (let i = 0; i < LARGE.N; i++) {
      const s = order[i];
      const sl = r.slots[s];
      // the colluders use the longest CID allowed (100 chars)
      const cid = (bad.has(s) ? "Q".repeat(100) : `QmJ${s}`) + ":" + H.saltHex(sl.salt);
      const rc = await (await H.fulfil(sl.revealReq, sl.arb.node, sl.reveal, cid)).wait();
      last = rc;
    }
    const info = await core.agg.getRoundInfo(r.aggId);
    expect(info.phase).to.equal(6n);
    return { gas: Number(last.gasUsed), counted: order.slice(0, LARGE.N).filter((s) => bad.has(s)).length };
  }

  it("measures the N-th reveal with 0 and 6 colluding 20-value / 100-char-CID revealers (Large, N = 13)", async () => {
    const a = await measure(0);
    const b = await measure(6);
    console.log(`      honest: ${a.gas} gas; with ${b.counted} colluding revealers counted: ${b.gas} gas (x${(b.gas / a.gas).toFixed(2)})`);
    expect(b.gas).to.be.greaterThan(a.gas);
  });
});
