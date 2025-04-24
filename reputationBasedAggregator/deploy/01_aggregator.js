// deploy/01_aggregator.js
// -----------------------------------------------------------------------------
// Deploys ReputationAggregator with a **dummy keeper address**. The real keeper
// is wired up later in deploy/003_config.js.
// -----------------------------------------------------------------------------
//   • Skips deployment entirely when the SKIP_MIGRATIONS env‑var is set
//   • Maps LINK token addresses by network name (same as the old Truffle script)
//   • Tagged "aggregator" so you can run: npx hardhat deploy --tags aggregator
// -----------------------------------------------------------------------------

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/01_aggregator] SKIP_MIGRATIONS is set → skipping deploy");
    return;
  }

  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  // LINK token address lookup (per‑network)
  const LINK_TOKEN_ADDRESS = {
    base:          "0xd886e2286fd1073df82462ea1822119600af80b6",
    base_goerli:   "0xd886e2286fd1073df82462ea1822119600af80b6",
    base_sepolia:  "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
    development:   "0x0000000000000000000000000000000000000000",
    hardhat:       "0x0000000000000000000000000000000000000000",
    localhost:     "0x0000000000000000000000000000000000000000",
  };

  const linkAddr = LINK_TOKEN_ADDRESS[network.name];
  if (!linkAddr) {
    throw new Error(`No LINK token address configured for network: ${network.name}`);
  }

  const ZERO = "0x0000000000000000000000000000000000000000"; // placeholder keeper

  await deploy("ReputationAggregator", {
    from: deployer,
    args: [linkAddr, ZERO],
    log: true,
  });
};

module.exports.tags = ["aggregator"];

