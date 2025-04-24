// test/keeper.test.js  – Hardhat version
// -------------------------------------------------

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ReputationKeeper (register & config only)", function () {
  let keeper, token, owner, fee, stakeRequirement;
  const validClasses = [1, 2, 3];
  const dummy = ethers.ZeroAddress; // overwritten in before()

  before(async () => {
    [owner] = await ethers.getSigners();

    keeper = await ethers.getContract("ReputationKeeper");
    token  = await ethers.getContract("WrappedVerdiktaToken");

    stakeRequirement = await keeper.STAKE_REQUIREMENT();
    fee = ethers.parseEther("0.05");

    // Ensure owner has enough tokens & approve staking
    const bal = await token.balanceOf(owner.address);
    expect(bal).to.be.gte(stakeRequirement);

    await token.approve(keeper.target, stakeRequirement);
  });

  it("registers an oracle and returns correct info", async () => {
    const jobId = ethers.hexlify(ethers.randomBytes(32));

    await expect(
      keeper
        .connect(owner)
        .registerOracle(owner.address, jobId, fee, validClasses)
    )
      .to.emit(keeper, "OracleRegistered")
      .withArgs(owner.address, jobId, fee);

    const info = await keeper.getOracleInfo(owner.address, jobId);
    expect(info.isActive).to.equal(true);
    expect(info.fee).to.equal(fee);
    expect(info.stakeAmount).to.be.gte(stakeRequirement);
  });

  it("reverts if fee == 0", async () => {
    await expect(
      keeper
        .connect(owner)
        .registerOracle(owner.address, ethers.hexlify(ethers.randomBytes(32)), 0, validClasses)
    ).to.be.revertedWith("Fee must be greater than 0");
  });

  it("reverts if classes array is empty", async () => {
    await expect(
      keeper
        .connect(owner)
        .registerOracle(owner.address, ethers.hexlify(ethers.randomBytes(32)), fee, [])
    ).to.be.revertedWith("At least one class must be provided");
  });

  it("reverts if more than 5 classes provided", async () => {
    const tooMany = [1, 2, 3, 4, 5, 6];
    await expect(
      keeper
        .connect(owner)
        .registerOracle(owner.address, ethers.hexlify(ethers.randomBytes(32)), fee, tooMany)
    ).to.be.revertedWith("A maximum of 5 classes allowed");
  });

  it("can approve and then remove an external contract", async () => {
    const contractToApprove = owner.address; // using owner address as dummy

    await expect(keeper.connect(owner).approveContract(contractToApprove))
      .to.emit(keeper, "ContractApproved")
      .withArgs(contractToApprove);

    await expect(keeper.connect(owner).removeContract(contractToApprove))
      .to.emit(keeper, "ContractRemoved")
      .withArgs(contractToApprove);
  });
});

