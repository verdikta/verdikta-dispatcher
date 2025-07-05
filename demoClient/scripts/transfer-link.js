#!/usr/bin/env node
// Usage:
//   node scripts/transfer-link.js <recipient> <amount>
//   # example: node scripts/transfer-link.js 0x60B781D220d78127bF189E8CfD15fc0E4c38f9E3 0.5
//
// Or, via Hardhat (no extra args allowed—use env vars):
//   RECIP=0x60B781D220d78127bF189E8CfD15fc0E4c38f9E3 AMOUNT=0.5 npx hardhat run scripts/transfer-link.js --network base_sepolia

const hre = require("hardhat");
const { ethers } = hre;

const LINK = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"; // LINK on Base Sepolia

(async () => {
  // read params: CLI or env
  const recipient = process.argv[2] || process.env.RECIP;
  const amountEth = process.argv[3] || process.env.AMOUNT;
  if (!recipient || !amountEth) {
    console.error("Provide recipient and amount (e.g. 0.1)");
    process.exit(1);
  }

  const amount = ethers.parseUnits(amountEth, 18);

  const [signer] = await ethers.getSigners();
  const abi = (await hre.artifacts.readArtifact("LinkTokenInterface")).abi;
  const link = new ethers.Contract(LINK, abi, signer);

  const tx = await link.transfer(recipient, amount);
  console.log("transfer tx:", tx.hash);
  await tx.wait();
  console.log(`sent ${amountEth} LINK to ${recipient}`);
})();

