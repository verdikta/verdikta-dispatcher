#!/usr/bin/env node
/*
  scripts/withdraw-link-from-oracle.js  – Hardhat + Ethers

  • Optionally reads the “secondary” signer when the env-var USE_SECONDARY=1 is set  
    (first account otherwise).  
  • Turns *off* yargs’ automatic number-parsing so 0x-addresses stay
    strings.  
  • Withdraws the contract’s `withdrawable()` LINK balance to the address
    you pass with --deposit.

  Example (run with the secondary key):

  USE_SECONDARY=1 HARDHAT_NETWORK=base_sepolia node scripts/withdraw-link-from-oracle.js \
    --operator 0x00A08b75178de0e0d7FF13Fdd4ef925AC3572503 \
    --deposit  0xFBDE840eb654E0f8B9F3e6c69C354B309A9ffE6b \
    --link     0xE4aB69C077896252FAFBD49EFD26B5D171A32410
*/

require("dotenv").config();
const hre             = require("hardhat");
const { ethers }      = hre;
const yargs           = require("yargs/yargs");
const { hideBin }     = require("yargs/helpers");

/* ──────────────────── minimal ABIs ──────────────────── */
const OperatorABI = [
  "function owner() view returns (address)",
  "function withdrawable() view returns (uint256)",
  "function withdraw(address,uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

/* ───────────────── helper: choose signer ─────────────── */
async function pickSigner() {
  const signers = await ethers.getSigners();
  const useSecondary = process.env.USE_SECONDARY === "1";
  return signers[useSecondary && signers.length > 1 ? 1 : 0];
}

/* ───────────────────────── main ──────────────────────── */
(async () => {
  try {
    /* argv with number-parsing disabled so 0x… stays a string */
    const argv = yargs(hideBin(process.argv))
      .parserConfiguration({          // ← prevents 0x… → number
        "parse-numbers": false,
        "parse-positional-numbers": false,
      })
      .option("operator", { alias: "a", demandOption: true, describe: "Operator (oracle) contract address" })
      .option("deposit",  { alias: "d", demandOption: true, describe: "Destination address for LINK"      })
      .option("link",     { alias: "l", demandOption: true, describe: "LINK token contract address"       })
      .strict()
      .argv;

    const signer = await pickSigner();
    const sender = await signer.getAddress();
    console.log(`Using signer: ${sender} ${process.env.USE_SECONDARY === "1" ? "(secondary key)" : "(default key)"}`);

    /* contracts */
    const operator = new ethers.Contract(argv.operator, OperatorABI, signer);
    const link     = new ethers.Contract(argv.link,     ERC20_ABI,   signer);

    /* ownership check */
    const ownerAddr = await operator.owner();
    console.log("Operator owner:", ownerAddr);
    if (ownerAddr.toLowerCase() !== sender.toLowerCase()) {
      throw new Error("Signer is *not* the Operator owner – aborting.");
    }

    /* balances */
    const [totalBal, withdrawable] = await Promise.all([
      link.balanceOf(argv.operator),
      operator.withdrawable(),
    ]);

    console.log("\nTotal LINK in operator:", ethers.formatEther(totalBal));
    console.log("Withdrawable amount:     ", ethers.formatEther(withdrawable));

    if (withdrawable === 0n) {
      console.log("Nothing to withdraw – exiting.");
      return;
    }

    /* withdraw */
    console.log(`\nWithdrawing ${ethers.formatEther(withdrawable)} LINK → ${argv.deposit}`);
    const gasEst = await operator.withdraw.estimateGas(argv.deposit, withdrawable);
    const tx     = await operator.withdraw(argv.deposit, withdrawable, {
      gasLimit: gasEst * 12n / 10n,   // +20 % buffer
    });
    console.log("Tx sent:", tx.hash);
    await tx.wait();
    console.log("Withdrawal confirmed.");
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

