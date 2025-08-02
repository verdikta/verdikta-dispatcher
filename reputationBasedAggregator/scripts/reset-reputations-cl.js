#!/usr/bin/env node
/*
  scripts/reset-reputations-cl.js – Hardhat + ethers

  Hard-reset all oracle scores, status flags, and recent-history records
  in the ReputationKeeper, reached *via* a ReputationAggregator.

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/reset-reputations-cl.js \
  --aggregator 0xC60f4532F104EDD422335a9103c8Ce7B2DF5Bc84
*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------- */
/* Minimal ABIs                                                        */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)"
];

const KeeperABI = [
  "function resetAllReputations()",
  "function owner() view returns (address)"
];

/* ------------------------------------------------------------------- */
/* Main                                                                */
/* ------------------------------------------------------------------- */
(async () => {
  try {
    /* Args ------------------------------------------------------------ */
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", { alias: "a", type: "string", demandOption: true })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const caller   = await signer.getAddress();
    console.log("Using signer:", caller);

    /* Contracts ------------------------------------------------------- */
    const provider   = ethers.provider;
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);

    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper     = new ethers.Contract(keeperAddr, KeeperABI, signer);

    /* Optional safety check ------------------------------------------ */
    const keeperOwner = await keeper.owner();
    if (keeperOwner.toLowerCase() !== caller.toLowerCase()) {
      throw new Error("Signer is NOT the owner of the ReputationKeeper (aborting).");
    }

    /* Reset ----------------------------------------------------------- */
    console.log("Calling resetAllReputations() …");
    const tx = await keeper.resetAllReputations();
    console.log("Tx sent →", tx.hash);
    await tx.wait();
    console.log("All arbiter reputations have been reset.");

    process.exit(0);
  } catch (err) {
    console.error("Error during reset:", err);
    process.exit(1);
  }
})();

