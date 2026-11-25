// sec5 fix review: chargeSilent had no time limit. A stage's silent beacons could be charged at any later
// time, also after a beacon exited (unbonding is 2 days) and re-registered as a fresh arbiter, whose
// score then took the old stage's -400. Charges now land within MAX_DRAW_AGE (1 day) of the pick,
// before any key picked for the stage can complete an exit.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("../helpers");
const { RoundDriver } = require("../round");

describe("sec5 fixreview: chargeSilent window", function () {
  let core, agg, keeper, beacons, arbs, drv, requester, stranger;
  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper, beacons } = core);
    [, requester, , stranger] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 12);
    await keeper.setSelection(60, 400, 0);
    await H.installHistory();
    drv = new RoundDriver(core, arbs, requester, { beacons: true });
  });

  it("an old stage cannot be charged to a key that exited and registered again", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 0 });
    await time.increase(121);
    const silent = arbs.find((a) => a.key === r.beacons[0].key);
    // the beacon answers its call (unfrozen), leaves and comes back as a fresh registration
    await keeper.connect(silent.node).answerHealthCall(silent.key, silent.ch.next());
    await keeper.requestExit(silent.key);
    await time.increase(2 * 24 * 3600 + 1);
    await keeper.completeExit(silent.key);
    const ch = H.makeChain();
    await keeper.registerArbiter(silent.opAddr, silent.jobId, H.FEE, [1], ch.head);
    const fresh = (await keeper.getArbiter(silent.key)).timeliness;
    await expect(beacons.connect(stranger).chargeSilent(agg.target, r.aggId)).to.be.revertedWithCustomError(keeper, "BadParams");
    expect((await keeper.getArbiter(silent.key)).timeliness).to.equal(fresh);
  });

  it("within a day of the pick the charge still lands", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 0 });
    await time.increase(23 * 3600);
    const before = (await keeper.getArbiter(r.beacons[0].key)).timeliness;
    await beacons.connect(stranger).chargeSilent(agg.target, r.aggId);
    expect((await keeper.getArbiter(r.beacons[0].key)).timeliness).to.equal(before - 400n);
  });
});
