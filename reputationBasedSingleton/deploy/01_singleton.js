// deploy/01_singleton.js
module.exports = async ({ getNamedAccounts, deployments }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // pull keeper & LINK from your JSON
  const { keeper, linkToken } =
    require("../deployment-addresses.json").base_sepolia;

  const singleton = await deploy("ReputationSingleton", {
    from: deployer,
    args: [ linkToken, keeper ],
    log: true,
  });

  console.log("ReputationSingleton deployed at", singleton.address);
};

module.exports.tags = ["ReputationSingleton"];

