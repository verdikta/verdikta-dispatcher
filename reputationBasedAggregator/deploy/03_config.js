// deploy/03_config.js
// -----------------------------------------------------------------------------
// One aggregator serves every bounty class (TODO item 15): each request carries its
// jury (K/M/N/P and the round timeout), so this sets only the bounds a request may ask
// for, and the shared parameters. The class presets live with the consumers
// (BountyEscrow's site and API: example-bounty-program/shared/classPresets.js):
//   Small / Bondless Small 6/5/4/3, 300 s; Medium 8/5/4/3, 300 s;
//   Large 21/16/13/10, 300 s; Jumbo 50/38/27/17, 600 s (with beacons).
// Jumbo requests set the beacon flag per request, so the beacon contract keeps its
// defaults: 4 polled, first 2 used, 120 s.
//
// Tags:    config
// Depends: aggregator, keeper
// -----------------------------------------------------------------------------

require("dotenv").config();

// the largest jury a request may ask for (Jumbo), the longest timeout, and T+ (item 14's measured 155 s)
const MAX_JURY = 50;
const MAX_TIMEOUT = 3600;
const T_PLUS = 155;

module.exports = async ({ ethers, getNamedAccounts, deployments, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/03_config] SKIP_MIGRATIONS set → skipping");
    return;
  }

  const { execute, read } = deployments;
  const { deployer } = await getNamedAccounts();
  const CONFIRMATIONS = /^base(_|$)/.test(network.name) ? 2 : 1;
  const tx = { from: deployer, log: true, waitConfirmations: CONFIRMATIONS };

  // every request's K must fit the keeper's shortlist (the aggregator checks it per request too)
  const shortlist = Number(await read("ReputationKeeper", "shortlistSize"));
  if (shortlist < MAX_JURY) throw new Error(`keeper shortlistSize ${shortlist} < the largest jury ${MAX_JURY}`);

  console.log(`Configuring aggregator: juries up to K = ${MAX_JURY}, timeouts up to ${MAX_TIMEOUT} s, T+ ${T_PLUS} s`);
  await execute("ReputationAggregator", tx, "setLimits", MAX_JURY, MAX_TIMEOUT, T_PLUS);

  // bonus x3, settle due rounds up to 2 x the request's K slots per request, 250k dispatch stipend,
  // 3-point spread floor, and the ETH fee ceiling: 0.0004 ETH (4e14 wei), the live 0.05 LINK ceiling
  // scaled by /125 (docs 4.6)
  await execute("ReputationAggregator", tx, "setParams", 3, 2, 250_000, 30_000, ethers.parseEther("0.0004"));

  console.log("Aggregator configured.");
};

module.exports.tags = ["config"];
module.exports.dependencies = ["aggregator", "keeper"];
