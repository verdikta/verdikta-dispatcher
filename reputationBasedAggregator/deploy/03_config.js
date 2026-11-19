// deploy/03_config.js
// -----------------------------------------------------------------------------
// Sets the aggregator's jury for one bounty class (TODO item 15). K/M/N/P, T+ and the
// timeout are per aggregator, so each class is its own deployment. Choose it with
// AGG_CLASS (small, medium, large, jumbo; default small). Bondless Small uses the
// small jury. Jumbo requests set the beacon flag per request (BountyEscrow's class
// preset), so the beacon contract keeps its defaults: 4 polled, first 2 used, 120 s.
//
// Tags:    config
// Depends: aggregator, keeper
// -----------------------------------------------------------------------------

require("dotenv").config();

// item 15 (2026-11-18): K/M/N/P, response timeout (s), T+ (s, item 14's measured 155 s)
const CLASSES = {
  small:  { K: 6,  M: 5,  N: 4,  P: 3,  timeout: 300, tPlus: 155 },
  medium: { K: 8,  M: 5,  N: 4,  P: 3,  timeout: 300, tPlus: 155 },
  large:  { K: 21, M: 16, N: 13, P: 10, timeout: 300, tPlus: 155 },
  jumbo:  { K: 50, M: 38, N: 27, P: 17, timeout: 600, tPlus: 155 },
};

module.exports = async ({ ethers, getNamedAccounts, deployments, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/03_config] SKIP_MIGRATIONS set → skipping");
    return;
  }

  const { execute, read } = deployments;
  const { deployer } = await getNamedAccounts();
  const CONFIRMATIONS = /^base(_|$)/.test(network.name) ? 2 : 1;
  const tx = { from: deployer, log: true, waitConfirmations: CONFIRMATIONS };

  const name = (process.env.AGG_CLASS || "small").toLowerCase();
  const c = CLASSES[name];
  if (!c) throw new Error(`AGG_CLASS must be one of ${Object.keys(CLASSES).join(", ")}`);
  console.log(`Configuring aggregator for class ${name}: ${c.K}/${c.M}/${c.N}, P = ${c.P}, timeout ${c.timeout} s, T+ ${c.tPlus} s`);

  // Jumbo's selection walk must fill a 50-juror shortlist: shortlistSize >= K (keeper default 60)
  const shortlist = Number(await read("ReputationKeeper", "shortlistSize"));
  if (shortlist < c.K) throw new Error(`keeper shortlistSize ${shortlist} < K = ${c.K}`);

  await execute("ReputationAggregator", tx, "setConfig", c.K, c.M, c.N, c.P, c.timeout, c.tPlus);

  // bonus x3, settle 2 due rounds per request, 250k dispatch stipend, 3-point spread floor, and the
  // ETH fee ceiling: 0.0004 ETH (4e14 wei), the live 0.05 LINK ceiling scaled by /125 (docs 4.6)
  await execute("ReputationAggregator", tx, "setParams", 3, 2, 250_000, 30_000, ethers.parseEther("0.0004"));

  console.log("Aggregator configured.");
};

module.exports.tags = ["config"];
module.exports.dependencies = ["aggregator", "keeper"];
