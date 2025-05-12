// deploy/02_config.js
require("dotenv").config();

module.exports = async (hre) => {
  const { ethers, getNamedAccounts, deployments } = hre;
  const { deployer } = await getNamedAccounts();
  const signer = await ethers.getSigner(deployer);

  // 1) Grab the singleton address from hardhat-deploy
  const singletonDeployment = await deployments.get("ReputationSingleton");
  const singletonAddress = singletonDeployment.address;
  console.log("→ singletonAddress:", singletonAddress);

  // 2) Read keeper address from your JSON
  const allAddrs = require("../deployment-addresses.json");
  const keeperAddr = allAddrs.base_sepolia?.keeper;
  console.log("→ keeperAddr:", keeperAddr);
  if (!ethers.isAddress(keeperAddr)) {
    throw new Error("Invalid or missing keeper in deployment-addresses.json");
  }

  // 3) Connect to the on-chain keeper via your interface stub
  const keeperContract = await ethers.getContractAt(
    "IReputationKeeper",
    keeperAddr,
    signer
  );

  // 4) Send the approval tx
  console.log(`Approving singleton ${singletonAddress} on keeper ${keeperAddr}…`);
  const tx = await keeperContract.approveContract(singletonAddress);
  await tx.wait();
  console.log("✅ ReputationSingleton approved");
};

module.exports.tags = ["ConfigSingleton"];
module.exports.dependencies = ["ReputationSingleton"];

