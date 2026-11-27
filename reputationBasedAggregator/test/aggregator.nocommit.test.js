// The no-commit penalty (review 2026-11-26 finding 7). A round that fails for lack of commits charges
// -400 timeliness only to a slot that was DISPATCHED and did not commit, and only when at least half
// of M committed. Before, one committed hash (never opened, so any nonzero value) was enough to charge
// every other slot, including slots whose dispatch had failed: one colluding key and a request honest
// nodes refuse, or one node that alone could fetch the evidence, pushed a whole jury toward blocks.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

describe("ReputationAggregator: the no-commit penalty (review #7)", function () {
  let core, agg, keeper, arbs, drv, requester;
  const V = H.vec;
  const timeliness = async (a) => Number((await keeper.getArbiter(a.key)).timeliness);
  const offenses = async (a) => Number((await keeper.getArbiter(a.key)).offenses);
  const eventArgs = (rcpt, name) => rcpt.logs
    .filter((l) => l.topics[0] === agg.interface.getEvent(name).topicHash)
    .map((l) => agg.interface.parseLog(l).args);

  // Six arbiters for the default jury (K 6, M 5, N 4, P 3): the draw seats each of them once.
  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper } = core);
    [, requester] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 6);
    await keeper.setSelection(60, 400, 0);        // no random probes, so only jurors are called
    await H.installHistory();
    drv = new RoundDriver(core, arbs, requester);
  });

  // A round where the slots in `committers` commit and the rest stay silent but live, settled after
  // the deadline. Returns the round.
  async function failedWith(committers, { round } = {}) {
    const r = round || await drv.request();
    await drv.answerAll(r);
    for (const s of committers) await drv.commit(r, s, V(600_000));
    await time.increase(301);
    await drv.settle(r);
    expect(await agg.isFailed(r.aggId)).to.equal(true);
    return r;
  }

  it("one lone commit charges nobody", async () => {
    const r = await failedWith([0]);
    for (const a of arbs) {
      expect(await timeliness(a)).to.equal(500);
      expect(await offenses(a)).to.equal(0);
    }
    expect(Object.keys(r.slots).length).to.equal(6);
  });

  it("two commits, fewer than half of M (5), charge nobody", async () => {
    await failedWith([0, 1]);
    for (const a of arbs) expect(await timeliness(a)).to.equal(500);
  });

  it("three commits, half of M or more: each live, dispatched non-committer loses 400; committers are not charged", async () => {
    const r = await failedWith([0, 1, 2]);
    for (const s of [0, 1, 2]) expect(await timeliness(r.slots[s].arb)).to.equal(500);
    for (const s of [3, 4, 5]) expect(await timeliness(r.slots[s].arb)).to.equal(100);
  });

  it("a slot whose dispatch failed is never charged, even when enough others committed", async () => {
    const bombed = arbs[0];
    await bombed.op.setBomb(true);                  // its operator burns the dispatch's gas
    const r = await drv.request();
    const skipped = eventArgs(r.rcpt, "SlotSkipped").map((a) => Number(a.pollIndex));
    expect(skipped.length).to.equal(1);
    await bombed.op.setBomb(false);
    // the bombed arbiter is up: answer its health call, so a freeze cannot be what spares it
    if ((Number((await keeper.getArbiter(bombed.key)).flags) & 16) !== 0) {
      await keeper.connect(bombed.node).answerHealthCall(bombed.key, bombed.ch.next());
    }
    const dispatched = Object.keys(r.slots).map(Number);
    expect(dispatched).to.not.include(skipped[0]);
    await failedWith(dispatched.slice(0, 3), { round: r });
    expect(await timeliness(bombed)).to.equal(500);
    for (const s of dispatched.slice(3)) expect(await timeliness(r.slots[s].arb)).to.equal(100);
  });
});
