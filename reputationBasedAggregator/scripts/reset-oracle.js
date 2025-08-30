#!/usr/bin/env node
/*
  scripts/reset-reputations.js – Hardhat + ethers (Base / Base Sepolia)

  Call ReputationKeeper.resetAllReputations(), wiping every oracle’s
  quality/timeliness scores, call counters, history, and any blocks/locks.

  Run, e.g.:
    npx hardhat run scripts/reset-reputations.js --network base_sepolia
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
    /* 3. optional: how many identities are we about to wipe           */
    /* --------------------------------------------------------------- */
    const count = await keeper.getRegisteredOraclesCount();
    console.log(`Resetting reputations for ${count} oracle identities …`);

    /* --------------------------------------------------------------- */
    /* 4. send tx with explicit EIP-1559 caps                          */
    /*    Defaults: 0.01 gwei cap, 0.001 gwei tip (override via .env)  */
    /* --------------------------------------------------------------- */
    const targetGwei = process.env.L2_GAS_PRICE_GWEI || "0.01";
    const tipGwei    = process.env.L2_PRIORITY_FEE_GWEI || "0.001";

    const overrides = {
      maxFeePerGas:         ethers.parseUnits(targetGwei, "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits(tipGwei,   "gwei"),
    };

    // (Optional) log node fee data for visibility
    const fee = await ethers.provider.getFeeData();
    console.log("RPC fee data:", {
      gasPrice: fee.gasPrice?.toString(),
      maxFeePerGas: fee.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas?.toString(),
    });
    console.log("Using overrides:", overrides);

    const tx = await keeper.resetAllReputations(overrides);
    console.log("Tx sent:", tx.hash, "(waiting …)");

    const net = hre.network.name;
    const confs = (net === "base" || net === "base_sepolia") ? 2 : 1;
    const receipt = await tx.wait(confs);

    console.log(
      `Success. Done in block ${receipt.blockNumber} - gas used ${receipt.gasUsed}`
    );

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

