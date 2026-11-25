// deploy/02_keeper.js
// -----------------------------------------------------------------------------
// Deploys ReputationKeeper and JuryBeacons, then wires them to the aggregator from
// 01_aggregator.js:
//   keeper.setApproved(aggregator)   the aggregator selects juries and reports outcomes
//   keeper.setRoles(beacons, 2)      JuryBeacons picks beacons (ROLE_SELECT only: it never sends
//                                    operator requests, and scores only its own picks' silent
//                                    beacons, once each, through keeper.missedBeacons)
//   beacons.setApproved(aggregator)  the aggregator starts beacon stages
//   aggregator.setContracts(keeper, beacons)
// -----------------------------------------------------------------------------
//   • Token: WRAPPED_VERDIKTA_TOKEN_BASE / _BASE_SEPOLIA / WRAPPED_VERDIKTA_TOKEN;
//     local networks get a TestToken
//   • No treasury: forfeits go to the aggregator's arbiter pool (ethOwed[address(0)]), paid out
//     to random registered arbiters at draws (TREASURY_ADDRESS is no longer read)
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
  const ROLE_SELECT = 2;
  if (Number(await read("ReputationKeeper", "roles", beacons.address)) !== ROLE_SELECT) {
    await execute("ReputationKeeper", tx, "setRoles", beacons.address, ROLE_SELECT);
  }
  if (!(await read("JuryBeacons", "approved", agg.address))) {
    await execute("JuryBeacons", tx, "setApproved", agg.address, true);
  }

  const curKeeper = await read("ReputationAggregator", "keeper");
  const curBeacons = await read("ReputationAggregator", "beacons");
  if (!eq(curKeeper, keeper.address) || !eq(curBeacons, beacons.address)) {
    await execute("ReputationAggregator", tx, "setContracts", keeper.address, beacons.address);
  }
  console.log(`Wired: aggregator ${agg.address}, keeper ${keeper.address}, beacons ${beacons.address}`);
};

module.exports.tags = ["keeper"];
module.exports.dependencies = ["aggregator"];
