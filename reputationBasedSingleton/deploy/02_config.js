// deploy/02_config.js
module.exports = async ({ getNamedAccounts, deployments, ethers }) => {
  const { deployer } = await getNamedAccounts();

  const keeperDeployment = await deployments.get("ReputationKeeper");
  const singletonDeployment = await deployments.get("ReputationSingleton");

  const keeper = await ethers.getContractAt(
    "ReputationKeeper",
    keeperDeployment.address,
    ethers.provider.getSigner(deployer)
  );

  console.log("Approving singleton at", singletonDeployment.address);
  await keeper.approveContract(singletonDeployment.address);
  console.log("Approved!");
};

module.exports.tags = ["ConfigSingleton"];
module.exports.dependencies = ["ReputationSingleton"];

