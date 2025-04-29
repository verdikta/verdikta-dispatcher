#!/usr/bin/env node
/*
  scripts/withdraw-link-from-aggregator.js – Hardhat version

  Withdraws *all* LINK held by a ReputationAggregator to a user‑supplied
  destination address.

  Usage:

HARDHAT_NETWORK=base_sepolia node scripts/withdraw-link-from-aggregator.js \
  --aggregator 0xbabE69DdF8CBbe63fEDB6f49904efB35522667Af \
  --deposit    0xYourDepositAddress


*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------------- */
/* Minimal ABIs                                                              */
/* ------------------------------------------------------------------------- */
const AggregatorABI = [
  { inputs: [], name: "getContractConfig", outputs: [
      { name: "oracleAddr", type: "address" },
      { name: "linkAddr",   type: "address" },
      { name: "jobId",      type: "bytes32"  },
      { name: "fee",        type: "uint256"  }
    ], stateMutability: "view", type: "function" },
  { inputs: [ { name: "_to", type: "address" }, { name: "_amount", type: "uint256" } ], name: "withdrawLink", outputs: [], stateMutability: "nonpayable", type: "function" }
];

const ERC20_ABI = [
  { constant: true, inputs: [ { name: "", type: "address" } ], name: "balanceOf", outputs: [ { type: "uint256" } ], stateMutability: "view", type: "function" }
];

/* ------------------------------------------------------------------------- */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", { alias: "a", type: "string", describe: "Aggregator address", demandOption: true })
      .option("deposit",    { alias: "d", type: "string", describe: "Destination LINK address", demandOption: true })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const sender   = await signer.getAddress();
    console.log("Using account:", sender);

    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, signer);

    console.log("\nFetching LINK token address…");
    const cfg = await aggregator.getContractConfig();
    const linkAddr = cfg.linkAddr;
    console.log("LINK token:", linkAddr);

    const link = new ethers.Contract(linkAddr, ERC20_ABI, signer);
    const bal  = await link.balanceOf(argv.aggregator);
    console.log("LINK balance in aggregator:", ethers.formatEther(bal), "LINK");
    if (bal === 0n) {
      console.log("No LINK tokens to withdraw.");
      process.exit(0);
    }

    console.log("\nPreparing withdrawal of", ethers.formatEther(bal), "LINK →", argv.deposit);
    const gasEst = await aggregator.withdrawLink.estimateGas(argv.deposit, bal);
    console.log("Estimated gas:", gasEst.toString());

    const tx = await aggregator.withdrawLink(argv.deposit, bal, {
      gasLimit: gasEst * 12n / 10n, // +20% buffer
    });
    console.log("Tx sent:", tx.hash);
    await tx.wait();
    console.log("✓ Withdrawal confirmed");

    const finalAggBal = await link.balanceOf(argv.aggregator);
    const depositBal  = await link.balanceOf(argv.deposit);
    console.log("\nFinal balances:");
    console.log("Aggregator:", ethers.formatEther(finalAggBal), "LINK");
    console.log("Deposit:   ", ethers.formatEther(depositBal),  "LINK");

    process.exit(0);
  } catch (err) {
    console.error("\nError:", err);
    process.exit(1);
  }
})();

