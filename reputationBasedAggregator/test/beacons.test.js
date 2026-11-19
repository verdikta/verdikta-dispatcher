// Item 9's beacon flag: JuryBeacons + the aggregator's beacon stage + the keeper's beacon pick.
// A flagged request escrows the beacon quorum; the first drawJury picks 4 beacons from the class's state
// as of block B and sends each a health call. A beacon answers like any arbiter, with its next chain
// value (verified by the keeper); its beacon value is its first reveal after B. The first 2 reveals (by
// block, ties by index) are used, mixed in beacon-index order; a missed quorum ends the round with no
// result and no refund.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

describe("JuryBeacons (item 9's beacon flag)", function () {
  let core, agg, keeper, beacons, arbs, drv, requester, stranger, deployer;
  const PH = { DRAW: 1n, BEACON: 2n, COMMIT: 3n, SETTLED: 7n, FAILED: 8n, CANCELLED: 9n };
  const phase = async (r) => (await agg.getRoundInfo(r.aggId))[0];
  const ev = (c, rcpt, name) => rcpt.logs
    .filter((l) => l.topics[0] === c.interface.getEvent(name).topicHash)
    .map((l) => c.interface.parseLog(l).args);
  const juryKeys = async (r, k = 6) => {
    const out = [];
    for (let i = 0; i < k; i++) out.push((await agg.getSlot(r.aggId, i)).key);
    return out;
  };
  /** snapshot restores roll back the keeper's chain heads; this rolls back the test's chains */
  const saveChains = () => {
    const u = arbs.map((a) => [a.ch, a.ch.used]);
    return () => arbs.forEach((a, i) => { a.ch = u[i][0]; a.ch.used = u[i][1]; });
  };
  const requestBlock = async (r) => (await agg.getRoundInfo(r.aggId))[1];
  const automine = (on) => ethers.provider.send("evm_setAutomine", [on]);

  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper, beacons, deployer } = core);
    [, requester, , stranger] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 12);
    await keeper.setSelection(60, 400, 0);
    await H.installHistory();
    drv = new RoundDriver(core, arbs, requester, { beacons: true });
  });

  it("a flagged request escrows the beacon quorum on top; without a beacon contract it is refused", async () => {
    const off = await agg.maxTotalFee(H.MAX_FEE, false);
    const on = await agg.maxTotalFee(H.MAX_FEE, true);
    expect(on - off).to.equal(2n * H.MAX_FEE);
    await expect(agg.connect(requester).requestAIEvaluationWithApproval(["Qm"], "", 500, H.MAX_FEE, H.BASE_COST, 5, 1, true, { value: off }))
      .to.be.revertedWithCustomError(agg, "InsufficientPayment");
    await agg.setContracts(keeper.target, ethers.ZeroAddress, deployer.address);
    await expect(agg.maxTotalFee(H.MAX_FEE, true)).to.be.reverted;
    await expect(agg.connect(requester).requestAIEvaluationWithApproval(["Qm"], "", 500, H.MAX_FEE, H.BASE_COST, 5, 1, true, { value: on }))
      .to.be.reverted;
  });

  it("the first drawJury picks and calls 4 beacons; the jury is drawn once 2 values are in", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 0 });
    expect(await phase(r)).to.equal(PH.BEACON);
    expect(r.beacons.length).to.equal(4);
    expect(new Set(r.beacons.map((b) => b.key)).size).to.equal(4);
    expect(H.oracleRequests(r.beaconRcpt).length).to.equal(0);                // no jury yet
    expect(ev(agg, r.beaconRcpt, "JuryDrawn").length).to.equal(0);
    for (const b of r.beacons) expect((await keeper.getArbiter(b.key)).flags & 16n).to.equal(16n);  // call pending
    await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");
    await drv.answerBeacon(r, 2);
    await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");
    await drv.answerBeacon(r, 0);
    await drv.draw(r, { waitBlocks: 0 });
    expect(await phase(r)).to.equal(PH.COMMIT);
    expect(Object.keys(r.slots).length).to.equal(6);
    await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "WrongPhase");
  });

  it("a beacon answers its health call like any arbiter: verified, by the arbiter only; the answer is the value", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 0 });
    const b = r.beacons[0];
    const B = await requestBlock(r);
    const ch = b.arb.ch;
    const v = ch.chain[ch.chain.length - 2 - ch.used];                          // its next value
    await expect(keeper.connect(stranger).answerHealthCall(b.key, v))
      .to.be.revertedWithCustomError(keeper, "NotAuthorizedResponder");
    await expect(keeper.connect(b.arb.node).answerHealthCall(b.key, ethers.ZeroHash))
      .to.be.revertedWithCustomError(keeper, "BadPreimage");
    await expect(keeper.connect(b.arb.node).answerHealthCall(b.key, ch.preimageOf(v)))   // skips a value
      .to.be.revertedWithCustomError(keeper, "BadPreimage");
    expect((await keeper.revealAfter(b.key, B)).value).to.equal(ethers.ZeroHash);
    const rc = await drv.answerBeacon(r, 0);
    expect((await keeper.getArbiter(b.key)).flags & 16n).to.equal(0n);       // call answered
    const rv = await keeper.revealAfter(b.key, B);
    expect(rv.value).to.equal(v);
    expect(rv.blk).to.equal(BigInt(rc.blockNumber));
    expect(rv.oracle).to.equal(b.arb.opAddr);
    const [keys, atBlock, deadline] = await beacons.getBeacons(agg.target, r.aggId);
    expect(keys).to.deep.equal(r.beacons.map((x) => x.key));
    expect(atBlock).to.equal(B);
    expect(deadline).to.equal(BigInt((await ethers.provider.getBlock(r.beaconRcpt.blockNumber)).timestamp) + 120n);
    // a later answer (to a later call) does not change the beacon value
    await keeper.sendHealthCalls([b.key]);
    await keeper.connect(b.arb.node).answerHealthCall(b.key, ch.next());
    expect((await keeper.revealAfter(b.key, B)).value).to.equal(v);
  });

  it("only an approved aggregator can start a stage; owner limits on the parameters", async () => {
    await expect(beacons.start(ethers.ZeroHash, ethers.ZeroHash, 1, 0, 0, 2)).to.be.revertedWithCustomError(beacons, "NotApproved");
    await expect(beacons.setParams(4, 0, 120)).to.be.revertedWithCustomError(beacons, "InvalidConfig");
    await expect(beacons.setParams(1, 2, 120)).to.be.revertedWithCustomError(beacons, "InvalidConfig");
    await expect(beacons.setParams(17, 2, 120)).to.be.revertedWithCustomError(beacons, "InvalidConfig");
    await expect(beacons.connect(stranger).setParams(4, 4, 120)).to.be.revertedWithCustomError(beacons, "OwnableUnauthorizedAccount");
    await beacons.setParams(4, 4, 120);                                       // the stricter variant: all 4 values
    expect((await agg.maxTotalFee(H.MAX_FEE, true)) - (await agg.maxTotalFee(H.MAX_FEE, false))).to.equal(4n * H.MAX_FEE);
  });

  it("the first 2 values are paid one fee each; later ones count for liveness only", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r);                                                 // all 4 answer, in pick order
    for (const b of r.beacons) expect((await keeper.getArbiter(b.key)).flags & 16n).to.equal(0n);   // calls answered
    await drv.draw(r, { waitBlocks: 0 });
    const paid = ev(agg, r.rcpt, "BeaconPayment");
    expect(paid.map((p) => p.payee)).to.deep.equal([await r.beacons[0].arb.op.owner(), await r.beacons[1].arb.op.owner()]);
    for (const p of paid) expect(p.amount).to.equal(H.MAX_FEE);
    const [, , , , , , , rewards] = await agg.getRoundInfo(r.aggId);
    expect(rewards).to.equal(4n * H.MAX_FEE);                                 // 2 x draw reward + 2 beacons
  });

  it("the seed mixes the first 2 values to arrive, in index order: same values, same jury, whoever draws and whenever", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 0 });
    const snap = await takeSnapshot();
    const restoreChains = saveChains();
    const juryAfter = async (order, { by = requester, wait = 0 } = {}) => {
      await snap.restore();
      restoreChains();
      for (const i of order) await drv.answerBeacon(r, i);
      if (wait) { await time.increase(wait); await mine(wait); }
      await drv.draw(r, { by, waitBlocks: 0 });
      return juryKeys(r);
    };
    const j01 = await juryAfter([0, 1]);
    expect(await juryAfter([0, 1], { by: stranger, wait: 400 })).to.deep.equal(j01);
    expect(await juryAfter([0, 1, 3, 2])).to.deep.equal(j01);                   // values after the quorum do not count
    expect(await juryAfter([1, 0])).to.deep.equal(j01);                         // arrival order within the pair does not matter
    expect(await juryAfter([2, 3])).to.not.deep.equal(j01);
    expect(await juryAfter([3, 0])).to.not.deep.equal(j01);
  });

  it("missed quorum: the round ends with no result, the answering beacon is paid, the rest goes to the treasury", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 1 });
    await time.increase(121);
    await drv.answerBeacon(r, 1);                                              // too late: answers its call, value not counted
    const t0 = await agg.ethOwed(deployer.address);
    const rc = await (await agg.connect(stranger).drawJury(r.aggId)).wait();
    expect(await agg.isFailed(r.aggId)).to.equal(true);
    expect(ev(agg, rc, "EvaluationFailed")[0].phase).to.equal(PH.BEACON);
    expect(ev(agg, rc, "BeaconPayment").length).to.equal(1);
    expect(H.oracleRequests(rc).length).to.equal(0);
    const [, , , , received, , , rewards] = await agg.getRoundInfo(r.aggId);
    expect(rewards).to.equal(H.MAX_FEE);
    expect((await agg.ethOwed(deployer.address)) - t0).to.equal(received - H.MAX_FEE);
    expect(await agg.ethOwed(requester.address)).to.equal(0n);
    for (const b of r.beacons.slice(2)) expect(await keeper.isFrozen(b.key)).to.equal(true);   // silent beacons freeze
    for (const b of r.beacons.slice(0, 2)) expect(await keeper.isFrozen(b.key)).to.equal(false);
    await expect(agg.drawJury(r.aggId)).to.be.revertedWithCustomError(agg, "WrongPhase");
  });

  it("the pick and the values depend only on the state as of B: earlier answers, rotations, the starter and the start time change nothing", async () => {
    await keeper.sendHealthCalls(arbs.map((a) => a.key));                     // every arbiter has a call pending
    const r = await drv.requestOnly();                                         // block B
    await mine(1);
    await agg.sealSeed(r.aggId);                                               // fix blockhash(B+1) for both branches
    const snap = await takeSnapshot();
    const restoreChains = saveChains();
    await drv.beaconStage(r, { answering: 2, waitBlocks: 0 });                 // beacons 0 and 1 answer after the start
    const keys = r.beacons.map((b) => b.key);
    await drv.draw(r, { waitBlocks: 0 });
    const jury = await juryKeys(r);
    await snap.restore();
    restoreChains();
    // after B and before the start, beacons 0 and 1 answer their pending calls (revealing the same next
    // values), beacon 0 rotating its chain in that answer; everyone else answers too; a stranger starts
    // the stage much later
    const byKey = new Map(arbs.map((a) => [a.key, a]));
    const first = [byKey.get(keys[0]), byKey.get(keys[1])];
    const fresh = H.makeChain();
    await keeper.connect(first[0].node).rotateChain(first[0].key, first[0].ch.next(), fresh.head);
    first[0].ch = fresh;
    await keeper.connect(first[1].node).answerHealthCall(first[1].key, first[1].ch.next());
    for (const a of arbs) if (!first.includes(a)) await keeper.connect(a.node).answerHealthCall(a.key, a.ch.next());
    await time.increase(600);
    await drv.beaconStage(r, { answering: 0, by: stranger, waitBlocks: 0 });
    expect(r.beacons.map((b) => b.key)).to.deep.equal(keys);
    expect((await beacons.result(agg.target, r.aggId)).state).to.equal(2n);   // ready at once: the values are in
    await drv.draw(r, { waitBlocks: 0 });
    expect(await juryKeys(r)).to.deep.equal(jury);
    // the beacon call is still a health call: answering it takes the next value (of the new chain)
    await keeper.connect(first[0].node).answerHealthCall(first[0].key, first[0].ch.next());
  });

  it("fewer beacon candidates at B than the quorum: the round fails and the requester is refunded", async () => {
    for (const a of arbs.slice(1)) await keeper.setPaused(a.key, true);
    const r = await drv.requestOnly();
    await mine(1);
    const rc = await (await agg.connect(stranger).drawJury(r.aggId)).wait();
    expect(ev(agg, rc, "EvaluationFailed").length).to.equal(1);
    expect(await agg.isFailed(r.aggId)).to.equal(true);
    const [, , , , received] = await agg.getRoundInfo(r.aggId);
    expect(await agg.ethOwed(requester.address)).to.equal(received);
  });

  it("frozen, paused, exiting and blocked arbiters are not picked as beacons", async () => {
    await keeper.setPaused(arbs[0].key, true);
    await keeper.requestExit(arbs[1].key);
    await keeper.sendHealthCalls([arbs[2].key]);
    await keeper.setApproved(deployer.address, true);
    await keeper.applyOutcomes([arbs[3].key], [H.code(H.T.MISS_FAILED)], (await time.latest()) + 1);   // blocked
    await time.increase(61);                                                   // arbs[2] frozen
    const bad = new Set([0, 1, 2, 3].map((i) => arbs[i].key));
    for (let i = 0; i < 6; i++) {
      const r = await drv.requestOnly();
      await drv.beaconStage(r, { answering: 0 });
      for (const b of r.beacons) expect(bad.has(b.key)).to.equal(false);
    }
  });

  it("a beacon cannot answer its call and keep its value back: a live beacon's answer is its value", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 0 });
    const b = r.beacons[3];
    await keeper.connect(b.arb.node).answerHealthCall(b.key, b.arb.ch.next());   // the only way to answer
    await drv.answerBeacon(r, 2);
    await drv.draw(r, { waitBlocks: 0 });
    expect(await phase(r)).to.equal(PH.COMMIT);
    const paid = ev(agg, r.rcpt, "BeaconPayment").map((p) => p.payee);
    expect(paid).to.deep.equal([await r.beacons[2].arb.op.owner(), await b.arb.op.owner()]);   // index order
  });

  it("only completed blocks count, and reveals in the same block go by beacon index", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 1 });                                // beacon 0
    const snap = await takeSnapshot();
    const restoreChains = saveChains();
    // beacon 1 answers and a draw follows in the same block: the draw sees only beacon 0
    await automine(false);
    const b1 = r.beacons[1];
    const a = await keeper.connect(b1.arb.node).answerHealthCall(b1.key, b1.arb.ch.next(), { gasLimit: 500_000 });
    const d = await agg.connect(requester).drawJury(r.aggId, { gasLimit: 16_000_000 });
    await mine(1);
    await automine(true);
    expect((await ethers.provider.getTransactionReceipt(a.hash)).status).to.equal(1);
    expect((await ethers.provider.getTransactionReceipt(d.hash)).status).to.equal(0);   // TooEarly
    await drv.draw(r, { waitBlocks: 0 });                                      // next block: ready
    const j01 = await juryKeys(r);
    await snap.restore();
    restoreChains();
    // beacons 3, 2 and 1 answer in one block after beacon 0: the tie goes to index 1, so the same pair
    await automine(false);
    for (const i of [3, 2, 1]) {
      const x = r.beacons[i];
      await keeper.connect(x.arb.node).answerHealthCall(x.key, x.arb.ch.next(), { gasLimit: 500_000 });
    }
    await mine(1);
    await automine(true);
    await drv.draw(r, { waitBlocks: 0 });
    expect(await juryKeys(r)).to.deep.equal(j01);
  });

  it("a beacon whose owner() cannot be read is not paid, and the draw goes ahead", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 2 });
    const op0 = r.beacons[0].arb.op, o = await op0.owner();
    await ethers.provider.send("hardhat_setBalance", [o, "0x1000000000000000000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [o]);
    await op0.connect(await ethers.getSigner(o)).setShortOwner(true);         // malformed after answering
    await r.beacons[1].arb.op.setBigOwner(true);                               // a return-data bomb: still readable
    await drv.draw(r, { waitBlocks: 0 });
    expect(await phase(r)).to.equal(PH.COMMIT);
    await r.beacons[1].arb.op.setBigOwner(false);
    expect(ev(agg, r.rcpt, "BeaconPayment").map((p) => p.payee)).to.deep.equal([await r.beacons[1].arb.op.owner()]);
    const [, , , , , , , rewards] = await agg.getRoundInfo(r.aggId);
    expect(rewards).to.equal(3n * H.MAX_FEE);                                 // 2 x draw reward + 1 beacon
  });

  it("the requester's 30 s draw priority runs from the quorum-th value", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r, { answering: 1 });
    await time.increase(60);                                                   // > 30 s after the request
    await drv.answerBeacon(r, 1);                                              // ready now
    const snap = await takeSnapshot();
    await drv.draw(r, { by: stranger, waitBlocks: 0 });
    expect(ev(agg, r.rcpt, "JuryDrawn")[0].reward).to.equal(0n);              // third party inside the window
    await snap.restore();
    await drv.draw(r, { by: requester, waitBlocks: 0 });
    expect(ev(agg, r.rcpt, "JuryDrawn")[0].reward).to.equal(2n * H.MAX_FEE);
    await snap.restore();
    await time.increase(31);
    await drv.draw(r, { by: stranger, waitBlocks: 0 });
    expect(ev(agg, r.rcpt, "JuryDrawn")[0].reward).to.equal(2n * H.MAX_FEE);
  });

  it("a beacon stage nobody concluded for a day goes to the treasury, unpaid", async () => {
    const r = await drv.requestOnly();
    await drv.beaconStage(r);
    await expect(agg.cancelUnsealed(r.aggId)).to.be.revertedWithCustomError(agg, "TooEarly");
    await time.increase(24 * 3600 + 1);
    const t0 = await agg.ethOwed(deployer.address);
    const [, , , , received] = await agg.getRoundInfo(r.aggId);
    await agg.connect(stranger).cancelUnsealed(r.aggId);
    expect((await agg.ethOwed(deployer.address)) - t0).to.equal(received);
    expect(await phase(r)).to.equal(PH.CANCELLED);
  });

  it("a full round with beacons settles and keeps the ETH solvency invariant", async () => {
    await drv.fullRound();
    const r = await drv.fullRound({ settle: false });
    await time.increase(301);
    const x = await drv.requestOnly();                                        // settles r through the queue
    expect(await phase(r)).to.equal(PH.SETTLED);
    await drv.beaconStage(x, { answering: 1 });
    await time.increase(121);
    await agg.drawJury(x.aggId);                                              // x: quorum missed, to the treasury
    const payees = [requester.address, deployer.address, ...(await Promise.all(arbs.map((a) => a.op.owner())))];
    let owed = 0n;
    for (const p of payees) owed += await agg.ethOwed(p);
    expect(await ethers.provider.getBalance(agg.target)).to.equal(owed);
  });
});
