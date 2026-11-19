// EIP-170 / EIP-3860 limits: every deployable contract must stay under 24,576 bytes of runtime code
// and 49,152 bytes of initcode.
const { expect } = require("chai");
const { artifacts } = require("hardhat");

const RUNTIME_LIMIT = 24576;
const INITCODE_LIMIT = 49152;
const CONTRACTS = ["ReputationAggregator", "ReputationKeeper", "JuryBeacons", "ScoringLib", "AggregatorLib"];

describe("contract size limits", function () {
  for (const name of CONTRACTS) {
    it(`${name} fits`, async () => {
      const a = await artifacts.readArtifact(name);
      const runtime = (a.deployedBytecode.length - 2) / 2;
      const init = (a.bytecode.length - 2) / 2;
      console.log(`      ${name.padEnd(24)} runtime ${String(runtime).padStart(6)} B (${(100 * runtime / RUNTIME_LIMIT).toFixed(1)}%), ` +
        `headroom ${RUNTIME_LIMIT - runtime} B; initcode ${init} B`);
      expect(runtime).to.be.lessThan(RUNTIME_LIMIT);
      expect(init).to.be.lessThan(INITCODE_LIMIT);
    });
  }
});
