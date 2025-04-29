#!/usr/bin/env node
/*
  scripts/withdraw-link-from-oracle.js  – Hardhat + ethers
  Uses the secondary key when the env-var USE_SECONDARY=1 is present.
  Example:
USE_SECONDARY=1 HARDHAT_NETWORK=base_sepolia node scripts/withdraw-link-from-oracle.js \
  --operator  "0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101" \
  --deposit   "0xFBDE840eb654E0f8B9F3e6c69C354B309A9ffE6b" \
  --link      "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs       = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ──────────────── minimal ABIs ──────────────── */
const OperatorABI = [
  "function owner() view returns (address)",
  "function withdrawable() view returns (uint256)",
  "function withdraw(address,uint256)",
];

const ERC20_ABI   = [
  "function balanceOf(address) view returns (uint256)",
];

/* ───────────── helper: pick signer ───────────── */
async function getSigner() {
  const signers = await ethers.getSigners();
  const use2nd  = process.env.USE_SECONDARY === "1";
  return signers[use2nd && signers.length > 1 ? 1 : 0];
}

/* ────────────────── main ─────────────────────── */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("operator", { alias: "a", demandOption: true, describe: "Operator (oracle) contract" })
      .option("deposit",  { alias: "d", demandOption: true, describe: "Destination address"       })
      .option("link",     { alias: "l", demandOption: true, describe: "LINK token address"        })
      .strict()
      .argv;

    const signer   = await getSigner();
    const sender   = await signer.getAddress();
    console.log("Using signer:", sender, process.env.USE_SECONDARY === "1" ? "(secondary key)" : "(default key)");

    const operator = new ethers.Contract(argv.operator, OperatorABI, signer);
    const link     = new ethers.Contract(argv.link,     ERC20_ABI,  signer);

    /* ─ owner check ─ */
    const ownerAddr = await operator.owner();
    console.log("Operator owner:", ownerAddr);
    if (ownerAddr.toLowerCase() !== sender.toLowerCase()) {
      throw new Error("This script must be run with the operator-owner key");
    }

    /* ─ balances ─ */
    const totalBal     = await link.balanceOf(argv.operator);
    const withdrawable = await operator.withdrawable();

    console.log("\nTotal LINK in operator:", ethers.formatEther(totalBal));
    console.log("Withdrawable amount:     ", ethers.formatEther(withdrawable));

    if (withdrawable === 0n) {
      console.log("Nothing to withdraw – exiting.");
      return;
    }

    /* ─ withdraw ─ */
    console.log(`\nWithdrawing ${ethers.formatEther(withdrawable)} LINK → ${argv.deposit}`);
    const gasEst = await operator.withdraw.estimateGas(argv.deposit, withdrawable);
    const tx     = await operator.withdraw(argv.deposit, withdrawable, { gasLimit: gasEst * 12n / 10n });
    console.log("Tx sent:", tx.hash);
    await tx.wait();
    console.log("✓ Withdrawal confirmed");
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

