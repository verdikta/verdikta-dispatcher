// scripts/show-gas.js
const { ethers, network } = require("hardhat");

async function main() {
  const provider = ethers.provider;                 // current Hardhat network
  const fee      = await provider.getFeeData();     // v6 API

  // helper to print BigInt nicely
  const fmt = (x) => x ? ethers.formatUnits(x, "gwei") + " gwei" : "n/a";

  console.log(`\n[${network.name}] suggested fee data`);
  console.log("──────────────────────────────────────────────");
  console.log("gasPrice (legacy)        :", fmt(fee.gasPrice));          // L2s & old chains
  console.log("baseFeePerGas            :", fmt(fee.lastBaseFeePerGas)); // current block
  console.log("maxPriorityFeePerGas (tip):", fmt(fee.maxPriorityFeePerGas));
  console.log("maxFeePerGas             :", fmt(fee.maxFeePerGas));
  console.log("──────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

