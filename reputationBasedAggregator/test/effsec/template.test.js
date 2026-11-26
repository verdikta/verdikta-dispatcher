// Efficiency-set review (C3): the aggregator's hand-built LINK transferAndCall calldata must be byte-for-byte
// what ChainlinkClient + Chainlink.Request would send for the same operator, job, nonce and parameters, for
// every commit payload length (CBOR 1-, 2- and 3-byte string headers) and for the reveal payload.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("../helpers");
const { RoundDriver } = require("../round");

async function deployRecording() {
  const [deployer] = await ethers.getSigners();
  const link = await (await ethers.getContractFactory("RecordingLink")).deploy();
  const token = await (await ethers.getContractFactory("TestToken")).deploy();
  const keeper = await (await ethers.getContractFactory("ReputationKeeper")).deploy(await token.getAddress());
  const aggLib = await (await ethers.getContractFactory("AggregatorLib")).deploy();
  const scoring = await (await ethers.getContractFactory("ScoringLib")).deploy();
  const F = await ethers.getContractFactory("ReputationAggregator", {
    libraries: { AggregatorLib: await aggLib.getAddress(), ScoringLib: await scoring.getAddress() },
  });
  const agg = await F.deploy(await link.getAddress(), await keeper.getAddress());
  await keeper.setApproved(await agg.getAddress(), true);
  await token.approve(await keeper.getAddress(), ethers.MaxUint256);
  return { deployer, link, token, keeper, agg, aggLib, scoring, beacons: null };
}

/** cids + addendum whose commit payload "1:<cids>[:addendum]" is exactly L bytes (3..2012) */
function payloadOf(L) {
  let cids, add = "";
  if (L <= 102) cids = ["Q".repeat(L - 2)];
  else if (L <= 1103) { cids = ["Q".repeat(100)]; add = "a".repeat(L - 103); }
  else { cids = Array.from({ length: 10 }, () => "Q".repeat(100)); add = "a".repeat(L - 1012); }
  const payload = "1:" + cids.join(",") + (add.length ? ":" + add : "");
  if (payload.length !== L) throw new Error("bad length");
  return { cids, add, payload };
}

describe("effsec: request template vs ChainlinkClient", function () {
  this.timeout(600_000);
  let core, agg, keeper, link, arbs, chk, requester, sel;
  before(async () => {
    core = await deployRecording();
    ({ agg, keeper, link } = core);
    [, requester] = await ethers.getSigners();
    arbs = await H.registerArbiters(core, 8);
    await keeper.setSelection(60, 400, 0);
    await H.installHistory();
    chk = await (await ethers.getContractFactory("TemplateCheck")).deploy();
    sel = agg.interface.getFunction("fulfill").selector;
  });

  const calls = (rcpt) => rcpt.logs.filter((l) => l.address === link.target)
    .map((l) => link.interface.parseLog(l).args.data);

  async function checkCalls(rcpt, aggId, payloadFor, reveal) {
    const id = BigInt(aggId);
    const reqs = H.oracleRequests(rcpt);
    const cs = calls(rcpt);
    expect(cs.length).to.equal(reqs.length);
    expect(cs.length).to.be.greaterThan(0);
    for (let k = 0; k < cs.length; k++) {
      const r = reqs[k];
      const ref = await agg.requestRef(r.requestId);
      expect(ref >> 96n).to.equal(BigInt(r.operator));
      const slot = ref & 0xffn;
      expect((ref & ((1n << 96n) - 1n)) >> 8n).to.equal(id);
      const nonce = ((id << 8n) | slot) << 1n | (reveal ? 1n : 0n);
      expect(r.requestId).to.equal(ethers.solidityPackedKeccak256(["address", "uint256"], [agg.target, nonce]));
      const want = await chk.expected(await payloadFor(slot), aggId.toLowerCase(), r.operator, r.specId, nonce, sel);
      expect(cs[k]).to.equal(want);
      expect(r.dataVersion).to.equal(2n);
      expect(r.callbackAddr).to.equal(agg.target);
    }
  }

  for (const L of [3, 4, 22, 23, 24, 25, 66, 102, 254, 255, 256, 257, 258, 104, 1000, 1103, 1104, 2012]) {
    it(`commit request, payload length ${L}`, async () => {
      const { cids, add, payload } = payloadOf(L);
      const value = await H.quote(agg, H.MAX_FEE, 0n, false);
      await (await agg.connect(requester).requestAIEvaluationWithApproval(
        cids, add, 500, H.MAX_FEE, 0, H.BASE_COST, 5, 1, false, H.JURY, { value, gasLimit: 16_000_000 })).wait();
      const aggId = ethers.zeroPadValue(ethers.toBeHex(await agg.roundCount()), 32);
      await mine(1);
      const rcpt = await (await agg.connect(requester).drawJury(aggId, { gasLimit: 16_000_000 })).wait();
      await checkCalls(rcpt, aggId, async () => payload, false);
    });
  }

  it("reveal requests match, and the round then finalizes", async () => {
    const drv = new RoundDriver(core, arbs, requester);
    const round = await drv.requestOnly();
    await drv.draw(round);
    await drv.answerAll(round);
    for (const sl of Object.keys(round.slots).map(Number)) await drv.commit(round, sl, H.vec(600_000));
    if (!round.closing) { await time.increase(Number(await agg.tPlus()) + 1); await drv.closeCommits(round); }
    const rcpt = await drv.promote(round);
    await checkCalls(rcpt, round.aggId, async (slot) => "2:" + (await agg.getSlot(round.aggId, slot)).commitHash.slice(2), true);
    const prom = drv.promotedSlots(round);
    for (const s of prom) await drv.reveal(round, s);
    const [, , valid] = await agg.getEvaluation(round.aggId);
    expect(valid).to.equal(true);
  });
});
