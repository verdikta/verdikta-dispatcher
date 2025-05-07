const hre = require("hardhat");

async function main() {
  const LINK   = "0x326C977E6efc84E512bB9C30f76E30c160eD06FB"; // Sepolia LINK
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  const ArbiterOperator = await hre.ethers.getContractFactory("ArbiterOperator");
  const op = await ArbiterOperator.deploy(LINK);
  await op.deployed();

  console.log("ArbiterOperator deployed to:", op.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

