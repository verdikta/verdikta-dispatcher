#!/usr/bin/env node
/*
  scripts/unregister-oracle.js – Hardhat version

  Hard‑coded oracle and job‑ID list for Base Sepolia. Deregisters each oracle
  identity and reclaims the 100‑wVDKA stake. No flags required.

  Run:
    npx hardhat run scripts/unregister-oracle.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

/* ------------------------------------------------------------------------- */
/* Constants                                                                 */
/* ------------------------------------------------------------------------- */
const ORACLE_ADDR = "0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101";
const JOB_IDS = [
  "38f19572c51041baa5f2dea284614590",
  "39515f75ac2947beb7f2eeae4d8eaf3e",
  "494db95af2944227b5b0c68453b8ad07",
];

/* ------------------------------------------------------------------------- */
(async () => {
  try {
    console.log("Starting oracle deregistration on Base Sepolia…\n");

    const [signer] = await ethers.getSigners();
    const caller = await signer.getAddress();
    console.log("Caller:", caller);

    /* ------------------------------------------------------------------- */
    /* Resolve contracts from artifacts                                   */
    /* ------------------------------------------------------------------- */
    const keeperInfo   = await deployments.get("ReputationKeeper");
    const verdiktaInfo = await deployments.get("WrappedVerdiktaToken");

    const keeper   = new ethers.Contract(keeperInfo.address,   keeperInfo.abi,   signer);
    const verdikta = new ethers.Contract(verdiktaInfo.address, verdiktaInfo.abi, signer);

    /* ------------------------------------------------------------------- */
    /* Auth check: caller must be keeper owner or oracle owner             */
    /* ------------------------------------------------------------------- */
    const keeperOwner  = await keeper.owner();
    const oracleOwner  = await new ethers.Contract(ORACLE_ADDR, [{
      constant: true,
      inputs: [],
      name: "owner",
      outputs: [{ type: "address" }],
      stateMutability: "view",
      type: "function",
    }], ethers.provider).owner();

    if (caller.toLowerCase() !== keeperOwner.toLowerCase() && caller.toLowerCase() !== oracleOwner.toLowerCase()) {
      throw new Error("Caller must be keeper owner or oracle owner");
    }

    /* ------------------------------------------------------------------- */
    /* Balance before                                                     */
    /* ------------------------------------------------------------------- */
    const balBefore = await verdikta.balanceOf(caller);
    console.log("Initial wVDKA balance:", ethers.formatEther(balBefore));

    /* ------------------------------------------------------------------- */
    /* Deregister each jobID                                              */
    /* ------------------------------------------------------------------- */
    let idx = 0;
    for (const jobStr of JOB_IDS) {
      const jobId = ethers.hexlify(ethers.toUtf8Bytes(jobStr)).padEnd(66, "0");
      console.log(`\nJob ${++idx}: ${jobStr} → ${jobId}`);
      const info = await keeper.getOracleInfo(ORACLE_ADDR, jobId);
      if (!info.isActive) {
        console.log("Not active – skipping");
        continue;
      }
      console.log("Calling deregisterOracle…");
      const tx = await keeper.deregisterOracle(ORACLE_ADDR, jobId);
      await tx.wait();
      console.log("✓ Deregistered (tx:", tx.hash, ")");
    }

    const balAfter = await verdikta.balanceOf(caller);
    console.log("\nFinal wVDKA balance:", ethers.formatEther(balAfter));
    console.log("Deregistration complete.");
    process.exit(0);
  } catch (err) {
    console.error("Error during deregistration:", err);
    process.exit(1);
  }
})();

