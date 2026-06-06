// scripts/whoami.js
// Read-only diagnostic: prints the configured accounts (ADDRESSES ONLY, never keys),
// the hardhat-deploy named accounts, and on-chain balances for the target network.
//   npx hardhat run scripts/whoami.js --network base_sepolia
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  console.log("network:", network.name);
  let named = {};
  try { named = await hre.getNamedAccounts(); } catch (_) {}
  console.log("namedAccounts.deployer:", named.deployer);
  console.log("namedAccounts.owner   :", named.owner);

  const signers = await ethers.getSigners();
  if (!signers.length) {
    console.log("No accounts configured (PRIVATE_KEY not loaded?).");
    return;
  }
  for (let i = 0; i < signers.length; i++) {
    const addr = signers[i].address;
    const bal = await ethers.provider.getBalance(addr);
    console.log(`account[${i}] (this is the deployer if i==0): ${addr}  balance: ${ethers.formatEther(bal)} ETH`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
