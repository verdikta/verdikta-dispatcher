// hardhat-deploy loads every file in deploy/ as a deploy script; deploy/helpers.js must be one that
// skips, or `hardhat deploy` and `hardhat node` fail after the last real step (sec4-outside).
const { expect } = require("chai");

describe("deploy/helpers.js under hardhat-deploy", () => {
  it("is a deploy function that always skips, and keeps its helpers", async () => {
    const helpers = require("../deploy/helpers");
    expect(helpers).to.be.a("function");
    expect(await helpers.skip()).to.equal(true);
    expect(helpers.tags).to.equal(undefined);
    expect(helpers.verifyContract).to.be.a("function");
    expect(helpers.isLocal("hardhat")).to.equal(true);
  });
});
