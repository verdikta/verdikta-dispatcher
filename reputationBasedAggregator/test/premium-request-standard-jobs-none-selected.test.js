// test/premium-request-standard-jobs-none-selected.test.js
// ----------------------------------------------------------------------------
// Class isolation in oracle selection: a request on one class never selects a job
// registered on another class, whatever its fee ceiling admits.
//
// Catalogue case `premium-request-standard-jobs-none-selected` (@verdikta/common
// data/code-review-fixtures.v1.json, layer "dispatcher", settles "none-selected"):
// jobs registered on code-standard, a request on code-premium with the premium fee
// ceiling -> no standard job is selected.
//
// Why (verdikta-arbiter docs/development/stake-attestation-design.md, sections 5 and
// 10.4): ReputationKeeper.selectOracles takes every active job in the requested class
// whose registered fee <= the request's fee ceiling, and the aggregator credits the
// job's REGISTERED fee, not the ceiling. So each price tier is its own class --
// code-standard (133) and code-premium (134) -- and a premium request must never reach
// a job registered, and paid, at the standard fee.
//
// What runs: the real ReputationKeeper, ReputationAggregator and AggregatorLib from
// contracts/, unmodified. Every case reads the selection two ways: the return value of
// keeper.selectOracles called by an approved account, and the OracleSelected /
// BasePayment events of a real requestAIEvaluationWithApproval, the path a request
// takes (fee clamp -> selectOracles -> per-slot dispatch and base credit). Only the
// arbiter operators and the two tokens are stand-ins.
// ----------------------------------------------------------------------------

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const CODE_STANDARD = 133n;
const CODE_PREMIUM = 134n;

// Indicative registered fee per tier (design section 10.4).
const STANDARD_FEE = ethers.parseEther("0.00012");
const PREMIUM_FEE = ethers.parseEther("0.0007");

const ALPHA = 500n;
const BASE_COST = 8n * 10n ** 9n;
const SCALING = 5n;
const NONE_SELECTED = "No active oracles available with fee <= maxFee and requested class";

// Arbiter-operator stand-in, installed with hardhat_setCode. registerOracle needs the
// oracle to answer supportsInterface(IArbiterOperator) and isReputationKeeperListEmpty()
// with true; a request then calls its owner() (the payee) and its ERC-677
// onTokenTransfer hook (the 0-juel dispatch). This runtime code answers every call with
// the 32-byte word 1, which reads as true, as owner() == address(1), and is ignored by
// the hook call:  PUSH1 0x01 PUSH1 0x00 MSTORE PUSH1 0x20 PUSH1 0x00 RETURN.
// (The repo's MockArbiterOperator has no ERC-165 support, so the real keeper refuses to
// register it; this keeps the change to test code only.)
const OPERATOR_STUB_CODE = "0x600160005260206000f3";
const operatorAddress = (i) => ethers.getAddress(ethers.toBeHex(0xc0de0000n + BigInt(i), 20));

function job(operator, label, fee, classes) {
  return { label, oracle: operatorAddress(operator), jobId: ethers.encodeBytes32String(label), fee, classes };
}

// Three operators serve code-standard at the standard fee.
const STANDARD_JOBS = [0, 1, 2].map((i) => job(i, `standard-${i}`, STANDARD_FEE, [CODE_STANDARD]));
// Two of the same operators also serve code-premium, on separate jobs at the premium fee,
// as an arbiter that serves both tiers would.
const PREMIUM_JOBS = [0, 1].map((i) => job(i, `premium-${i}`, PREMIUM_FEE, [CODE_PREMIUM]));
// A code-standard job registered at the premium fee: one class with jobs at two fees.
const STANDARD_JOB_AT_PREMIUM_FEE = job(3, "standard-3-premium-fee", PREMIUM_FEE, [CODE_STANDARD]);

const keyOf = (oracle, jobId) => `${ethers.getAddress(oracle)}/${jobId}`;

async function deployWith(jobs, { maxOracleFee } = {}) {
  const [, requester, selector] = await ethers.getSigners();

  const lib = await (await ethers.getContractFactory("AggregatorLib")).deploy();
  const Token = await ethers.getContractFactory("MockLinkToken");
  const link = await Token.deploy(0n); // request rail only: dispatch moves 0 juel
  const stakeToken = await Token.deploy(ethers.parseEther("1000000")); // registration stake
  const keeper = await (await ethers.getContractFactory("ReputationKeeper")).deploy(
    await stakeToken.getAddress(),
  );
  const agg = await (
    await ethers.getContractFactory("ReputationAggregator", {
      libraries: { AggregatorLib: await lib.getAddress() },
    })
  ).deploy(await link.getAddress(), await keeper.getAddress());

  await (await keeper.approveContract(await agg.getAddress())).wait();
  await (await keeper.approveContract(selector.address)).wait(); // reads selectOracles directly
  if (maxOracleFee !== undefined) await (await agg.setMaxOracleFee(maxOracleFee)).wait();

  const K = await agg.commitOraclesToPoll();
  // Every registered job fits in one round's K slots. With n <= K eligible jobs the
  // keeper's unique-draw pass picks each of them, so the selected set is exactly the
  // eligible set, and a filter that let a wrong job through would show on every run,
  // not by chance.
  expect(BigInt(jobs.length)).to.be.lte(K);

  await (await stakeToken.approve(await keeper.getAddress(), ethers.MaxUint256)).wait();
  for (const oracle of new Set(jobs.map((j) => j.oracle))) {
    await network.provider.send("hardhat_setCode", [oracle, OPERATOR_STUB_CODE]);
  }
  for (const j of jobs) {
    await (await keeper.registerOracle(j.oracle, j.jobId, j.fee, j.classes)).wait();
  }
  return { agg, keeper, requester, selector, jobs, K };
}

// Fixtures (loadFixture needs named functions).
async function standardJobsTodaysCeiling() {
  return deployWith(STANDARD_JOBS);
}
async function standardJobsPremiumCeiling() {
  return deployWith(STANDARD_JOBS, { maxOracleFee: PREMIUM_FEE });
}
async function premiumJobsPremiumCeiling() {
  return deployWith(PREMIUM_JOBS, { maxOracleFee: PREMIUM_FEE });
}
async function bothClassesPremiumCeiling() {
  return deployWith([...STANDARD_JOBS, ...PREMIUM_JOBS, STANDARD_JOB_AT_PREMIUM_FEE], {
    maxOracleFee: PREMIUM_FEE,
  });
}

function registeredJob(ctx, oracle, jobId) {
  const j = ctx.jobs.find((x) => keyOf(x.oracle, x.jobId) === keyOf(oracle, jobId));
  expect(j, `selected ${keyOf(oracle, jobId)} is not a registered job`).to.not.equal(undefined);
  return j;
}

function keeperSelect(ctx, requestedClass, ceiling) {
  return ctx.keeper
    .connect(ctx.selector)
    .selectOracles.staticCall(ctx.K, ALPHA, ceiling, BASE_COST, SCALING, requestedClass);
}

async function sendRequest(ctx, requestedClass, ceiling) {
  const value = await ctx.agg.maxTotalFee(ceiling);
  return ctx.agg
    .connect(ctx.requester)
    .requestAIEvaluationWithApproval(
      ["QmCodeReviewClaim"], "", ALPHA, ceiling, BASE_COST, SCALING, requestedClass, { value },
    );
}

// The slots a real request polled: [{ oracle, jobId, basePaid }] in slot order.
async function requestSelect(ctx, requestedClass, ceiling) {
  const receipt = await (await sendRequest(ctx, requestedClass, ceiling)).wait();
  const aggAddress = await ctx.agg.getAddress();
  const slots = [];
  for (const log of receipt.logs) {
    if (log.address !== aggAddress) continue;
    const parsed = ctx.agg.interface.parseLog(log);
    if (!parsed) continue;
    const slot = Number(parsed.args.pollIndex);
    if (parsed.name === "OracleSelected") {
      slots[slot] = { ...slots[slot], oracle: parsed.args.oracle, jobId: parsed.args.jobId };
    } else if (parsed.name === "BasePayment") {
      slots[slot] = { ...slots[slot], basePaid: parsed.args.amount };
    }
  }
  return slots;
}

async function expectSelection(ctx, requestedClass, ceiling, expectedJobs) {
  const expected = expectedJobs.map((j) => keyOf(j.oracle, j.jobId)).sort();
  // The request clamps its ceiling to maxOracleFee before selectOracles; keep it unclamped
  // here so the direct keeper call and the request select under the same ceiling.
  expect(ceiling).to.be.lte(await ctx.agg.maxOracleFee());

  // 1. ReputationKeeper.selectOracles itself.
  const ids = await keeperSelect(ctx, requestedClass, ceiling);
  expect(ids.length).to.equal(Number(ctx.K));
  for (const id of ids) {
    const j = registeredJob(ctx, id.oracle, id.jobId);
    expect(j.classes, `${j.label} selected for class ${requestedClass}`).to.include(requestedClass);
    expect(j.fee <= ceiling, `${j.label} fee ${j.fee} above ceiling ${ceiling}`).to.equal(true);
  }
  expect([...new Set(ids.map((id) => keyOf(id.oracle, id.jobId)))].sort()).to.deep.equal(expected);

  // 2. A real request through the aggregator: every one of the K slots dispatched, each to
  //    a job of the requested class, each credited that job's registered fee.
  const slots = await requestSelect(ctx, requestedClass, ceiling);
  expect(slots.length).to.equal(Number(ctx.K));
  for (const s of slots) {
    expect(s && s.oracle, "a polled slot was not dispatched").to.not.equal(undefined);
    const j = registeredJob(ctx, s.oracle, s.jobId);
    expect(j.classes, `${j.label} polled for class ${requestedClass}`).to.include(requestedClass);
    expect(s.basePaid, `${j.label} base credit`).to.equal(j.fee);
  }
  expect([...new Set(slots.map((s) => keyOf(s.oracle, s.jobId)))].sort()).to.deep.equal(expected);
}

// "none-selected": selection reverts, so the request reverts before any dispatch,
// base credit or escrow.
async function expectNoneSelected(ctx, requestedClass, ceiling) {
  await expect(keeperSelect(ctx, requestedClass, ceiling)).to.be.revertedWith(NONE_SELECTED);
  await expect(sendRequest(ctx, requestedClass, ceiling)).to.be.revertedWith(NONE_SELECTED);
}

describe("premium-request-standard-jobs-none-selected (class isolation in selectOracles)", function () {
  describe("jobs registered on code-standard only", function () {
    it("a request on code-premium with the premium fee ceiling selects no standard job", async function () {
      const ctx = await loadFixture(standardJobsPremiumCeiling);
      // The ceiling admits every standard job on fee; only the class keeps them out.
      for (const j of ctx.jobs) expect(j.fee <= PREMIUM_FEE).to.equal(true);
      await expectNoneSelected(ctx, CODE_PREMIUM, PREMIUM_FEE);
    });

    it("the same under today's aggregator ceiling, which clamps the premium ceiling", async function () {
      const ctx = await loadFixture(standardJobsTodaysCeiling);
      const clamped = await ctx.agg.maxOracleFee();
      expect(clamped).to.be.lt(PREMIUM_FEE);
      expect(STANDARD_FEE).to.be.lte(clamped);
      await expectNoneSelected(ctx, CODE_PREMIUM, PREMIUM_FEE);
    });

    it("control: the same jobs serve a code-standard request at that ceiling", async function () {
      const ctx = await loadFixture(standardJobsPremiumCeiling);
      await expectSelection(ctx, CODE_STANDARD, PREMIUM_FEE, STANDARD_JOBS);
    });
  });

  describe("mirror: jobs registered on code-premium only", function () {
    it("a request on code-standard whose ceiling admits the premium fee selects no premium job", async function () {
      const ctx = await loadFixture(premiumJobsPremiumCeiling);
      await expectNoneSelected(ctx, CODE_STANDARD, PREMIUM_FEE);
    });

    it("control: the same jobs serve a code-premium request", async function () {
      const ctx = await loadFixture(premiumJobsPremiumCeiling);
      await expectSelection(ctx, CODE_PREMIUM, PREMIUM_FEE, PREMIUM_JOBS);
    });
  });

  describe("both classes registered, on the same operators", function () {
    it("a code-premium request selects only code-premium jobs, though its ceiling admits every standard job", async function () {
      const ctx = await loadFixture(bothClassesPremiumCeiling);
      await expectSelection(ctx, CODE_PREMIUM, PREMIUM_FEE, PREMIUM_JOBS);
    });

    it("a code-standard request whose ceiling admits the premium fee selects only code-standard jobs, each paid its registered fee", async function () {
      const ctx = await loadFixture(bothClassesPremiumCeiling);
      await expectSelection(ctx, CODE_STANDARD, PREMIUM_FEE, [...STANDARD_JOBS, STANDARD_JOB_AT_PREMIUM_FEE]);
    });

    it("within one class, only jobs with fee <= the ceiling are selected (a fee equal to the ceiling is)", async function () {
      const ctx = await loadFixture(bothClassesPremiumCeiling);
      await expectSelection(ctx, CODE_STANDARD, STANDARD_FEE, STANDARD_JOBS);
    });

    it("a ceiling below every fee in the class selects none", async function () {
      const ctx = await loadFixture(bothClassesPremiumCeiling);
      await expectNoneSelected(ctx, CODE_STANDARD, STANDARD_FEE - 1n);
    });
  });
});
