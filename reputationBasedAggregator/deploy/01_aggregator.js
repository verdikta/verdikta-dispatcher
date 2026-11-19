// deploy/01_aggregator.js
// -----------------------------------------------------------------------------
// Deploys the two external libraries and ReputationAggregator with a placeholder
// keeper. 02_keeper.js deploys the keeper and JuryBeacons and wires all three.
// -----------------------------------------------------------------------------
//   • Skips deployment entirely when the SKIP_MIGRATIONS env var is set
//   • LINK token by network; local networks get a MockLinkToken
//   • Tagged "aggregator":  npx hardhat deploy --tags aggregator
// -----------------------------------------------------------------------------

const { verifyContract, isLocal } = require("./helpers");

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/01_aggregator] SKIP_MIGRATIONS is set → skipping deploy");
    return;
  }

  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const CONFIRMATIONS = /^base(_|$)/.test(network.name) ? 2 : 1;

  const LINK_TOKEN_ADDRESS = {
    base:         "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196",
    base_sepolia: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
  };

  let linkAddr = LINK_TOKEN_ADDRESS[network.name];
  if (!linkAddr && isLocal(network.name)) {
    // the aggregator sends requests with transferAndCall(operator, 0, data), so a local chain
    // needs an ERC-677 token that fires onTokenTransfer
    linkAddr = (await deploy("MockLinkToken", { from: deployer, args: [10n ** 27n], log: true })).address;
  }
  if (!linkAddr) throw new Error(`No LINK token address configured for network: ${network.name}`);

  // AggregatorLib (CID / hex / payload helpers) and ScoringLib (cluster, classes, promotion draw)
  // are linked (DELEGATECALL) so the aggregator stays under the 24 KB code-size limit.
  const libs = {};
  for (const name of ["AggregatorLib", "ScoringLib"]) {
    const lib = await deploy(name, { from: deployer, log: true, waitConfirmations: CONFIRMATIONS });
    libs[name] = lib.address;
    if (lib.newlyDeployed) await verifyContract(lib.address, [], `contracts/${name}.sol:${name}`);
  }

  // The aggregator is ETH-funded. It still takes the LINK token because the Chainlink request rail
  // dispatches via transferAndCall(operator, 0, data) (0 juel).
  const ZERO = "0x0000000000000000000000000000000000000000";   // keeper, set by 02_keeper.js
  const result = await deploy("ReputationAggregator", {
    from: deployer,
    args: [linkAddr, ZERO],
    libraries: libs,
    log: true,
    waitConfirmations: CONFIRMATIONS,
  });

  if (result.newlyDeployed) {
    await verifyContract(result.address, [linkAddr, ZERO], "contracts/ReputationAggregator.sol:ReputationAggregator", {
      "contracts/AggregatorLib.sol:AggregatorLib": libs.AggregatorLib,
      "contracts/ScoringLib.sol:ScoringLib": libs.ScoringLib,
    });
  }
};

module.exports.tags = ["aggregator"];
