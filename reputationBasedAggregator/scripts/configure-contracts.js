// scripts/configure-contracts.js
//
// ------------------------------------------------------------
// Post‑deployment configuration for Base Sepolia.
// Pulls Keeper & Aggregator addresses from hardhat‑deploy
// artifacts, token address from WRAPPED_VERDIKTA_TOKEN.
//
// Usage:
//   npx hardhat run scripts/configure-contracts.js --network base_sepolia
// ------------------------------------------------------------

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments, network } = hre;

async function main() {
  console.log(`Starting post‑deployment configuration on ${network.name}…`);

  // ---------- 0. Environment & artifact checks ----------
  const TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN;
  if (!ethers.isAddress(TOKEN_ADDR)) {
    throw new Error("Set WRAPPED_VERDIKTA_TOKEN in .env");
  }

  // `deployments.get` reads address + ABI from artifacts written by hardhat‑deploy
  const keeperInfo     = await deployments.get("ReputationKeeper");
  const aggregatorInfo = await deployments.get("ReputationAggregator");

  const keeper     = await ethers.getContractAt(
    "ReputationKeeper",
    keeperInfo.address
  );
  const aggregator = await ethers.getContractAt(
    "ReputationAggregator",
    aggregatorInfo.address
  );
  const token      = await ethers.getContractAt("IERC20", TOKEN_ADDR);

  console.table({
    WrappedVerdiktaToken: TOKEN_ADDR,
    ReputationKeeper:     keeper.target,
    ReputationAggregator: aggregator.target,
  });

  // ---------- 1. Keeper → set token ----------
  console.log("→ keeper.setVerdiktaToken()");
  await (await keeper.setVerdiktaToken(TOKEN_ADDR)).wait();

  // ---------- 2. Aggregator → config ----------
  console.log("→ aggregator.setConfig(4, 3, 2, 300)");
  await (await aggregator.setConfig(4, 3, 2, 300)).wait();

  const maxFee = ethers.parseEther("0.08");
  console.log(`→ aggregator.setMaxOracleFee(${maxFee})`);
  await (await aggregator.setMaxOracleFee(maxFee)).wait();

  // ---------- 3. Keeper → approve aggregator ----------
  console.log("→ keeper.approveContract()");
  await (await keeper.approveContract(aggregator.target)).wait();

  console.log("🎉 Post‑deployment configuration completed successfully");
}

main().catch((err) => {
  console.error("❌  Error:", err);
  process.exit(1);
});

