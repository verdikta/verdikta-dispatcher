// deploy/02_keeper.js
// -----------------------------------------------------------------------------
// Deploys ReputationKeeper and JuryBeacons, then wires them to the aggregator from
// 01_aggregator.js:
//   keeper.setApproved(aggregator)   the aggregator selects juries and reports outcomes
//   keeper.setApproved(beacons)      JuryBeacons picks beacons and relays their answers
//   beacons.setApproved(aggregator)  the aggregator starts beacon stages
//   aggregator.setContracts(keeper, beacons, treasury)
// -----------------------------------------------------------------------------
//   • Token: WRAPPED_VERDIKTA_TOKEN_BASE / _BASE_SEPOLIA / WRAPPED_VERDIKTA_TOKEN;
//     local networks get a TestToken
//   • Treasury: TREASURY_ADDRESS, else the deployer
//   • Skips entirely when SKIP_MIGRATIONS is set
// -----------------------------------------------------------------------------

require("dotenv").config();
const { verifyContract, isLocal } = require("./helpers");

module.exports = async ({ deployments, getNamedAccounts, ethers, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/02_keeper] SKIP_MIGRATIONS set → skipping deploy");
    return;
  }

  const { deploy, execute, read } = deployments;
  const { deployer } = await getNamedAccounts();
  const CONFIRMATIONS = /^base(_|$)/.test(network.name) ? 2 : 1;
  const opts = { from: deployer, log: true, waitConfirmations: CONFIRMATIONS };

  /* token ------------------------------------------------------------------ */
  let TOKEN_ADDR;
  if (network.name === "base") TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN_BASE;
  else if (network.name === "base_sepolia") TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA;
  else if (isLocal(network.name)) TOKEN_ADDR = (await deploy("TestToken", { from: deployer, log: true })).address;
  else TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN;
  if (!ethers.isAddress(TOKEN_ADDR)) throw new Error("WRAPPED_VERDIKTA_TOKEN not set or invalid in .env");
  console.log("Stake token:", TOKEN_ADDR);

  /* contracts --------------------------------------------------------------- */
  const keeper = await deploy("ReputationKeeper", { ...opts, args: [TOKEN_ADDR] });
  if (keeper.newlyDeployed) await verifyContract(keeper.address, [TOKEN_ADDR], "contracts/ReputationKeeper.sol:ReputationKeeper");

  const beacons = await deploy("JuryBeacons", { ...opts, args: [keeper.address] });
  if (beacons.newlyDeployed) await verifyContract(beacons.address, [keeper.address], "contracts/JuryBeacons.sol:JuryBeacons");

  const agg = await deployments.getOrNull("ReputationAggregator");
  if (!agg || !ethers.isAddress(agg.address)) throw new Error("Aggregator not deployed yet; run the aggregator tag first.");

  /* wiring (each step skipped if already done) ------------------------------ */
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const tx = { from: deployer, log: true, waitConfirmations: CONFIRMATIONS };

  if (!(await read("ReputationKeeper", "approvedContracts", agg.address))) {
    await execute("ReputationKeeper", tx, "setApproved", agg.address, true);
  }
  if (!(await read("ReputationKeeper", "approvedContracts", beacons.address))) {
    await execute("ReputationKeeper", tx, "setApproved", beacons.address, true);
  }
  if (!(await read("JuryBeacons", "approved", agg.address))) {
    await execute("JuryBeacons", tx, "setApproved", agg.address, true);
  }

  const treasury = process.env.TREASURY_ADDRESS || (await read("ReputationAggregator", "treasury"));
  if (!ethers.isAddress(treasury)) throw new Error("TREASURY_ADDRESS invalid");
  const curKeeper = await read("ReputationAggregator", "keeper");
  const curBeacons = await read("ReputationAggregator", "beacons");
  const curTreasury = await read("ReputationAggregator", "treasury");
  if (!eq(curKeeper, keeper.address) || !eq(curBeacons, beacons.address) || !eq(curTreasury, treasury)) {
    await execute("ReputationAggregator", tx, "setContracts", keeper.address, beacons.address, treasury);
  }
  console.log(`Wired: aggregator ${agg.address}, keeper ${keeper.address}, beacons ${beacons.address}, treasury ${treasury}`);
};

module.exports.tags = ["keeper"];
module.exports.dependencies = ["aggregator"];
