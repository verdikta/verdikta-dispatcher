#!/usr/bin/env node
/*
  scripts/reset-reputations.js – Hardhat + ethers (Base Sepolia)

  Call ReputationKeeper.resetAllReputations(), wiping every oracle’s
  quality/timeliness scores, call counters, history, and any blocks/locks.

  Run:
    npx hardhat run scripts/reset-oracle.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

(async () => {
  try {
    /* --------------------------------------------------------------- */
    /* 0. signer / owner                                               */
    /* --------------------------------------------------------------- */
    const [signer] = await ethers.getSigners();
    const owner    = await signer.getAddress();
    console.log("Using owner:", owner);

    /* --------------------------------------------------------------- */
    /* 1. contract instance                                            */
    /* --------------------------------------------------------------- */
    // If you prefer a hard-coded address, replace the next line with:
    // const keeperAddr = "0xYourKeeperAddress";
    // const keeperAbi  = (await deployments.getArtifact("ReputationKeeper")).abi;
    const { address: keeperAddr, abi: keeperAbi } =
      await deployments.get("ReputationKeeper");

    const keeper = new ethers.Contract(keeperAddr, keeperAbi, signer);

    /* --------------------------------------------------------------- */
    /* 2. sanity-check: is signer really the on-chain owner?           */
    /* --------------------------------------------------------------- */
    const onChainOwner = await keeper.owner();
    if (onChainOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `Signer ${owner} is not the contract owner (${onChainOwner})`
      );
    }

    /* --------------------------------------------------------------- */
    /* 3. optional: show how many identities we’re about to wipe       */
    /* --------------------------------------------------------------- */
    const count = await keeper.getRegisteredOraclesCount();
    console.log(`Resetting reputations for ${count} oracle identities …`);

    /* --------------------------------------------------------------- */
    /* 4. send tx                                                      */
    /* --------------------------------------------------------------- */
    const tx = await keeper.resetAllReputations();
    console.log("Tx sent:", tx.hash, "(waiting …)");
    const receipt = await tx.wait();
    console.log(
      `✔︎  Done in block ${receipt.blockNumber} - gas used ${receipt.gasUsed}`
    );

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

