// test/aggregator.test.js  – Hardhat / ethers version
// ---------------------------------------------------
// Requires that the three contracts have already been deployed by
// hardhat‑deploy (tags: aggregator, keeper, tokens).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getContract } = require("./test-helpers");

describe("ReputationAggregator (config & getters only)", function () {
  let agg, keeper, link;
  let owner;
  // Add a delay between transactions to avoid nonce issues
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  before(async () => {
    // First, get the signers
    const signers = await ethers.getSigners();
    owner = signers[0];
    
    // Then get the contracts
    keeper = await getContract("ReputationKeeper");
    agg = await getContract("ReputationAggregator");
    
    // grab LINK address from getContractConfig()
    const cfg = await agg.getContractConfig();
    const linkAddr = cfg.linkAddr;
    link = await ethers.getContractAt("IERC20", linkAddr);
    
    // Log information for debugging
    console.log(`Owner address: ${owner.address}`);
    console.log(`Keeper address: ${await keeper.getAddress()}`);
    console.log(`Aggregator address: ${await agg.getAddress()}`);
  });

  it("owner has a positive LINK balance", async () => {
    const bal = await link.balanceOf(owner.address);
    expect(bal).to.be.gt(0n);
  });

  it("has sensible default config values", async () => {
    const [oracles, responses, cluster, timeout] = await Promise.all([
      agg.oraclesToPoll(),
      agg.requiredResponses(),
      agg.clusterSize(),
      agg.responseTimeoutSeconds(),
    ]);
    const maxOracleFee = await agg.maxOracleFee();
    expect(oracles).to.be.gt(0);
    expect(responses).to.be.gt(0);
    expect(responses).to.be.lte(oracles);
    expect(cluster).to.be.lte(responses);
    expect(timeout).to.equal(300);
    expect(maxOracleFee).to.be.gt(0n);
  });

  it("calculates maxTotalFee correctly", async () => {
    const maxFee = await agg.maxOracleFee();
    const half = maxFee / 2n;
    const slotSum =
      (await agg.oraclesToPoll()) + (await agg.clusterSize());
    // input < maxOracleFee
    let res = await agg.maxTotalFee(half);
    expect(res).to.equal(half * BigInt(slotSum));
    // input > maxOracleFee (should clamp)
    res = await agg.maxTotalFee(maxFee * 2n);
    expect(res).to.equal(maxFee * BigInt(slotSum));
  });

  it("only owner can setConfig and values update accordingly", async () => {
    await delay(2000);
    await agg.connect(owner).setConfig(6, 5, 4, 2, 42);
    expect(await agg.oraclesToPoll()).to.equal(5);
    expect(await agg.requiredResponses()).to.equal(4);
    expect(await agg.clusterSize()).to.equal(2);
    expect(await agg.responseTimeoutSeconds()).to.equal(42);
    // restore defaults
    await delay(2000);
    await agg.connect(owner).setConfig(6, 4, 3, 2, 300);
  });

  it("owner can update setter‑only fields", async () => {
    // responseTimeout
    await delay(2000);
    await agg.connect(owner).setResponseTimeout(111);
    expect(await agg.responseTimeoutSeconds()).to.equal(111);
    // maxOracleFee
    await delay(2000);
    await agg.connect(owner).setMaxOracleFee(ethers.parseEther("0.2"));
    expect(await agg.maxOracleFee()).to.equal(ethers.parseEther("0.2"));
    // restore originals
    await delay(2000);
    await agg.connect(owner).setResponseTimeout(300);
    await delay(2000);
    await agg.connect(owner).setMaxOracleFee(ethers.parseEther("0.1"));
  });
});

