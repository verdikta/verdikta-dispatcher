#!/usr/bin/env node
/*
  scripts/withdraw-link-from-oracle.js – Hardhat version

  Withdraws the *withdrawable* LINK held by an Operator (Oracle) contract to a
  destination address you supply on the CLI.

  Example (Base Sepolia):

HARDHAT_NETWORK=base_sepolia node scripts/withdraw-link-from-oracle.js \
  --operator 0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101 \
  --deposit  0xFBDE840eb654E0f8B9F3e6c69C354B309A9ffE6b \
  --link     0xE4aB69C077896252FAFBD49EFD26B5D171A32410


*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------------- */
/* Minimal ABIs                                                              */
/* ------------------------------------------------------------------------- */
const OperatorABI = [
  { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [ { name: "_recipient", type: "address" }, { name: "_amount", type: "uint256" } ], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "withdrawable", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }
];

const ERC20_ABI = [
  { constant: true, inputs: [ { name: "", type: "address" } ], name: "balanceOf", outputs: [ { type: "uint256" } ], stateMutability: "view", type: "function" }
];

/* ------------------------------------------------------------------------- */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("operator", { alias: "a", type: "string", describe: "Operator contract address", demandOption: true })
      .option("deposit",  { alias: "d", type: "string", describe: "Destination address",        demandOption: true })
      .option("link",     { alias: "l", type: "string", describe: "LINK token address",         demandOption: true })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const sender   = await signer.getAddress();
    console.log("Using account:", sender);

    const operator = new ethers.Contract(argv.operator, OperatorABI, signer);
    const ownerAddr = await operator.owner();
    console.log("Operator owner:", ownerAddr);
    console.log("Sender == owner?", ownerAddr.toLowerCase() === sender.toLowerCase() ? "Yes" : "No");

    const link = new ethers.Contract(argv.link, ERC20_ABI, signer);
    const totalBal = await link.balanceOf(argv.operator);
    const withdrawable = await operator.withdrawable();
    console.log("\nTotal LINK in operator:", ethers.formatEther(totalBal));
    console.log("Withdrawable amount:   ", ethers.formatEther(withdrawable));

    if (withdrawable === 0n) {
      console.log("No LINK tokens to withdraw.");
      process.exit(0);
    }

    console.log(`\nWithdrawing ${ethers.formatEther(withdrawable)} LINK → ${argv.deposit}`);
    const gasEst = await operator.withdraw.estimateGas(argv.deposit, withdrawable);
    const tx     = await operator.withdraw(argv.deposit, withdrawable, { gasLimit: gasEst * 12n / 10n });
    console.log("Tx sent:", tx.hash);
    await tx.wait();
    console.log("✓ Withdrawal confirmed");

    const finalOpBal = await link.balanceOf(argv.operator);
    const finalDepBal= await link.balanceOf(argv.deposit);
    console.log("\nFinal balances:");
    console.log("Operator:", ethers.formatEther(finalOpBal), "LINK");
    console.log("Deposit: ", ethers.formatEther(finalDepBal),  "LINK");

    process.exit(0);
  } catch (err) {
    console.error("\nError:", err);
    process.exit(1);
  }
})();

