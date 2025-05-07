// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  // 1) Pick the right LINK token address for the network you pass on the CLI
  const LINK = {
    base_sepolia: "0x4200000000000000000000000000000000000006",
    sepolia:      "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  }[hre.network.name];

  if (!LINK) throw new Error(`No LINK token address configured for ${hre.network.name}`);

  // 2) Show deployer address
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  // 3) Deploy
  const ArbiterOperator = await hre.ethers.getContractFactory("ArbiterOperator");
  const op = await ArbiterOperator.deploy(LINK);
  await op.waitForDeployment();                     // <-- v6

  console.log("ArbiterOperator deployed to:", await op.getAddress()); // v6 getter
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

