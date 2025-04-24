// scripts/check_deployer.js
//
// ------------------------------------------------------------
// Prints the address and balance of the first signer for the
// network you invoke.
//
// Usage example (Base Sepolia):
//   npx hardhat run scripts/check_deployer.js --network base_sepolia
//
// Ensure that `hardhat.config.js` defines the network like:
//
//   networks: {
//     base_sepolia: {
//       url: "https://sepolia.base.org",
//       accounts: [process.env.PRIVATE_KEY]
//     }
//   }
//
// The script will automatically pick up that signer.
// ------------------------------------------------------------

require("dotenv").config();
const hre = require("hardhat");
const { ethers, network } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();   // first configured signer

  console.log(`Network:            ${network.name}`);
  console.log(`Deployer address:   ${deployer.address}`);

  const balanceWei = await ethers.provider.getBalance(deployer.address);
  console.log(`Account balance:    ${ethers.formatEther(balanceWei)} ETH`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

