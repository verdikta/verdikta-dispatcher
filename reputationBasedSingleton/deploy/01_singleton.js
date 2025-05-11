// deploy/01_singleton.js
module.exports = async ({ getNamedAccounts, deployments }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // pull from your JSON
  const { keeper } = require("../deployment-addresses.json").base_sepolia;
  const LINK = "0x..."; // LINK token on Base Sepolia

  const singleton = await deploy("ReputationSingleton", {
    from: deployer,
    args: [ LINK, keeper ],
    log: true,
  });

  console.log("ReputationSingleton deployed at", singleton.address);
};

module.exports.tags = ["ReputationSingleton"];

