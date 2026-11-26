// Efficiency-set review (C3): fulfill's own operator check (replacing recordChainlinkFulfillment).
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("../helpers");
const { RoundDriver } = require("../round");

describe("effsec: fulfill operator check and reentry", function () {
  let core, agg, keeper, arbs, drv, requester, stranger;
  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper } = core);
    [, requester, , stranger] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 8);
    await keeper.setSelection(60, 400, 0);
    await H.installHistory();
    drv = new RoundDriver(core, arbs, requester);
  });

  async function as(addr, f) {
    await network.provider.send("hardhat_impersonateAccount", [addr]);
    await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    const s = await ethers.getSigner(addr);
    try { return await f(s); } finally { await network.provider.send("hardhat_stopImpersonatingAccount", [addr]); }
  }

  it("only the request's operator may answer, once; other operators, nodes and strangers get UnknownRequest", async () => {
    const round = await drv.request();
    await drv.answerAll(round);
    const s0 = round.slots[0];
    const other = Object.values(round.slots).find((s) => s.arb.opAddr !== s0.arb.opAddr);
    const id = s0.commitReq.requestId;
    const word = H.commitWord(round.aggId, s0.arb.opAddr, H.vec(600_000), 5n);
    await expect(agg.connect(stranger).fulfill(id, [word], "")).to.be.revertedWithCustomError(agg, "UnknownRequest");
    await expect(agg.connect(s0.arb.node).fulfill(id, [word], "")).to.be.revertedWithCustomError(agg, "UnknownRequest");
    await as(other.arb.opAddr, (s) => expect(agg.connect(s).fulfill(id, [word], "")).to.be.revertedWithCustomError(agg, "UnknownRequest"));
    // its own operator: accepted once, then the id is gone
    await as(s0.arb.opAddr, async (s) => {
      await agg.connect(s).fulfill(id, [word], "");
      expect(await agg.requestRef(id)).to.equal(0n);
      await expect(agg.connect(s).fulfill(id, [word + 1n], "")).to.be.revertedWithCustomError(agg, "UnknownRequest");
    });
    expect((await agg.getSlot(round.aggId, 0)).commitHash).to.equal(ethers.toBeHex(word, 32));
  });

  it("an uncommitted slot's still-open commit request cannot be used to reveal", async () => {
    const round = await drv.request();
    await drv.answerAll(round);
    const slots = Object.keys(round.slots).map(Number).sort((a, b) => a - b);
    const spare = slots[slots.length - 1];
    for (const sl of slots.slice(0, -1)) await drv.commit(round, sl, H.vec(600_000));
    if (!round.closing) { await time.increase(Number(await agg.tPlus()) + 1); await drv.closeCommits(round); }
    await drv.promote(round);
    const s = round.slots[spare];
    const salt = 7n;
    const cid = `QmX:${H.saltHex(salt)}`;
    const rcpt = await as(s.arb.opAddr, async (sg) => (await agg.connect(sg).fulfill(s.commitReq.requestId, H.vec(600_000), cid)).wait());
    expect(rcpt.logs.length).to.equal(0);
    expect(Number((await agg.getSlot(round.aggId, spare)).flags) & 0x08).to.equal(0);
  });

  it("an operator re-entering from onTokenTransfer cannot answer its own request or withdraw", async () => {
    const owner = ethers.Wallet.createRandom().address;
    const ev = await (await ethers.getContractFactory("ReenterOperator")).deploy(await core.link.getAddress(), owner);
    // a pool of only this operator (several jobs) so it is drawn
    const core2 = await H.deployCore();
    const ev2 = await (await ethers.getContractFactory("ReenterOperator")).deploy(await core2.link.getAddress(), owner);
    await core2.keeper.setSelection(60, 400, 0);
    for (let i = 0; i < 6; i++) {
      await core2.keeper.registerArbiter(ev2.target, ethers.zeroPadValue(ethers.toBeHex(i + 1), 32), H.FEE, [1], H.makeChain().head);
    }
    const d2 = new RoundDriver(core2, [], requester);
    const round = await d2.requestOnly();
    await mine(1);
    const rcpt = await (await core2.agg.connect(requester).drawJury(round.aggId, { gasLimit: 16_000_000 })).wait();
    expect(await ev2.attempts()).to.equal(12n);
    expect(await ev2.successes()).to.equal(0n);
    const ref = await core2.agg.requestRef(await ev2.lastId());
    expect(ref >> 96n).to.equal(BigInt(ev2.target));
    void ev; void rcpt;
  });
});
