// scripts/check-address.js
//
// -----------------------------------------
// Utility: Convert an Ethereum address to its
// EIP‑55 checksummed form.
//
// Usage example:
//   npx hardhat run scripts/check-address.js --network hardhat 0x8e5e40f8f9103168c7d7cf361c6c0fcbcb8b9b2b
//
// Output:
//   Checksummed address: 0x8E5E40f8F9103168C7d7cF361C6c0fCbCB8b9B2B
//
// If you omit the address argument, the script throws an error.
// -----------------------------------------

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const rawAddress = process.argv[2];

  if (!rawAddress) {
    throw new Error(
      "Missing address.\nExample:\n  npx hardhat run scripts/check-address.js --network hardhat 0x123..."
    );
  }

  const checksummed = ethers.getAddress(rawAddress);
  console.log("Checksummed address:", checksummed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

