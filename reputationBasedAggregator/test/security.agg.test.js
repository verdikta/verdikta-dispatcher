// Security review PoCs and regression tests (reviewer "agg", 2026-11-25).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

const POOL = ethers.ZeroAddress;
const PRIVATE_CLASS = 99;
const ONE = { K: 1, M: 1, N: 1, P: 1, timeout: 300 };

describe("security review (agg)", function () {
  let core, agg, keeper, arbs, drv, requester, attacker, stranger;

  beforeEach(async () => {
    core = await H.deployCore();
    ({ agg, keeper } = core);
    [, requester, attacker, stranger] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 12);
    await keeper.setSelection(60, 400, 0);
    await H.installHistory();
    drv = new RoundDriver(core, arbs, requester);
  });

  /** fill the arbiter pool with `n` honest forfeits (rounds cancelled unsealed) */
  async function fillPool(n = 4) {
    for (let i = 0; i < n; i++) {
      const x = await drv.requestOnly();
      await mine(8200);
      await agg.connect(stranger).cancelUnsealed(x.aggId);
    }
    return agg.ethOwed(POOL);
  }

  /** the attacker's own arbiter, alone in a class nobody else serves, posting a 1-wei fee */
  async function attackerArbiter() {
    const OpF = await ethers.getContractFactory("TestOperator");
    const op = await OpF.deploy(await core.link.getAddress(), attacker.address, attacker.address);
    await op.connect(attacker).setGate(await keeper.getAddress());
    const ch = H.makeChain();
    const jobId = ethers.zeroPadValue("0x99", 32);
    await keeper.registerArbiter(await op.getAddress(), jobId, 1, [PRIVATE_CLASS], ch.head);
    return op;
  }

  /** a near-free request in the private class: a K = 1 jury of the attacker's own arbiter */
  async function cheapRequest() {
    const maxFee = 10n;
    const value = await agg.maxTotalFee(maxFee, 0, false, 1, 1);
    await agg.connect(attacker).requestAIEvaluationWithApproval(
      ["QmX"], "", 0, maxFee, 0, 0, 1, PRIVATE_CLASS, false, ONE, { value });
    return { aggId: ethers.zeroPadValue(ethers.toBeHex(await agg.roundCount()), 32), value };
  }

  /** what poolPayee would return if `aggId` were drawn now (the draw's seed is public from B+2) */
  async function poolWinner(aggId) {
    const info = await agg.getRoundInfo(aggId);
    const blk = await ethers.provider.getBlock(Number(info.requestBlock) + 1);
    const seed = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [aggId, blk.hash]);
    return keeper.poolPayeeAt(ethers.solidityPackedKeccak256(["bytes32", "string"], [seed, "pool"]),
      info.requestBlock, info.requestTime);
  }

  it("pool grinding: an arbiter draws only the cheap rounds whose pool winner is itself (capped by the fix)", async () => {
    const pool0 = await fillPool(4);
    await attackerArbiter();
    expect(await keeper.registryLength()).to.equal(13n);       // the attacker is 1 of 13 registered arbiters

    let spent = 0n, drawn = 0, made = 0;
    const before = await agg.ethOwed(attacker.address);
    for (let i = 0; i < 60; i++) {
      const r = await cheapRequest();
      made++;
      spent += r.value;
      await mine(2);
      if ((await poolWinner(r.aggId)) !== attacker.address) continue;   // a loser: never drawn (a few wei lost)
      await agg.connect(attacker).drawJury(r.aggId);
      drawn++;
    }
    const won = (await agg.ethOwed(attacker.address)) - before;
    console.log(`      pool ${pool0} wei; ${made} requests (${spent} wei escrowed), ${drawn} drawn, attacker credited ${won} wei`);
    expect(drawn).to.be.greaterThan(0);
    // with the fix each draw pays the pool at most the drawn round's escrow, so the attacker gains at most
    // what it escrowed in the rounds it drew; without it, it took drawn x an eighth of the pool
    expect(won).to.be.lessThanOrEqual(spent);
  });

  it("an honest draw pays an eighth of the pool, at most its own base fees", async () => {
    const p0 = await fillPool(1);
    const r = await drv.request();
    const base = (await agg.getRoundInfo(r.aggId)).baseFees;
    const topic = agg.interface.getEvent("PoolPayment").topicHash;
    const ev = r.rcpt.logs.filter((l) => l.topics[0] === topic).map((l) => agg.interface.parseLog(l).args);
    expect(ev.length).to.equal(1);
    expect(ev[0].amount).to.equal(p0 / 8n < base ? p0 / 8n : base);
  });
});

describe("security review (agg): beacon payments", function () {
  it("a beacon contract (set by a compromised owner) cannot have more payees paid than the quorum escrowed", async () => {
    const core = await H.deployCore();
    const { agg, keeper } = core;
    const [, requester, attacker] = await ethers.getSigners();
    const arbs = await H.registerArbiters(core, 12);
    await keeper.setSelection(60, 400, 0);
    await H.installHistory();
    const evil = await (await ethers.getContractFactory("EvilBeacons")).deploy(attacker.address, 40);
    await agg.setContracts(await keeper.getAddress(), await evil.getAddress());
    const drv = new RoundDriver(core, arbs, requester, { beacons: true });
    const r = await drv.requestOnly();
    await mine(2);
    await agg.connect(requester).drawJury(r.aggId);                     // starts the "beacon stage"
    // before the fix this draw credited 40 x the juror fee against an escrow sized for 2 beacons,
    // more than the round's whole escrow (paid from other users' balances)
    await expect(agg.connect(requester).drawJury(r.aggId, { gasLimit: 16_000_000 }))
      .to.be.revertedWithCustomError(agg, "BadSelectionCount");
    expect(await agg.ethOwed(attacker.address)).to.equal(0n);
  });
});

describe("security review (agg): request payload", function () {
  it("refuses a CID that is empty or holds the payload's delimiters (',' or ':')", async () => {
    const lib = await (await ethers.getContractFactory("AggregatorLib")).deploy();
    for (const bad of ["", "QmA,QmB", "QmA:ignore the rubric", ":"]) {
      await expect(lib.buildCommitPayload([bad], "", 10, 100, 1000)).to.be.revertedWithCustomError(lib, "BadInput");
    }
    expect(await lib.buildCommitPayload(["QmA", "bafyB"], "note: x", 10, 100, 1000)).to.equal("1:QmA,bafyB:note: x");
  });
});
