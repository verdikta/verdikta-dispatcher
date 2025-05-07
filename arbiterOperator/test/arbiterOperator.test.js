const { expect } = require("chai");

describe("ArbiterOperator", () => {
  it("deploys", async () => {
    const [owner] = await ethers.getSigners();
    const MockLink = await ethers.getContractFactory("LinkToken");
    const link = await MockLink.deploy();
    await link.deployed();

    const ArbiterOperator = await ethers.getContractFactory("ArbiterOperator");
    const op = await ArbiterOperator.deploy(link.address);
    await op.deployed();

    expect(await op.owner()).to.equal(owner.address);
  });
});

