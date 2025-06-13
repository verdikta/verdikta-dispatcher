#!/usr/bin/env node
/*
  scripts/unregister-oracle.js – Hardhat + ethers (Base Sepolia)

  Hard-coded oracle + job IDs.  Removes each identity and reclaims the
  100-wVDKA stake.

  Run:
    npx hardhat run scripts/unregister-oracle.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

/* ------------------------------------------------------------------- */
/* Constants                                                           */
/* ------------------------------------------------------------------- */
const ORACLE_ADDR = "0xb8b2302759e1FB7144d35f6F41057f11dbFAdDbD";
const JOB_IDS = [
  "38f19572c51041baa5f2dea284614590",
  "39515f75ac2947beb7f2eeae4d8eaf3e",
  "cdee0a127bc74a5188cbabf7aadcc84f",
];
/* ------------------------------------------------------------------- */

(async () => {
  try {
    console.log("Starting oracle deregistration on Base Sepolia…\n");

    /* ----------------------------------------------------------------- */
    /* Signer                                                            */
    /* ----------------------------------------------------------------- */
    const [signer] = await ethers.getSigners();
    const caller   = await signer.getAddress();
    console.log("Caller:", caller);

    /* ----------------------------------------------------------------- */
    /* Resolve keeper deployment                                         */
    /* ----------------------------------------------------------------- */
    const keeperInfo = await deployments.get("ReputationKeeper");
    const keeper     = new ethers.Contract(
      keeperInfo.address,
      keeperInfo.abi,
      signer
    );

    /* ----------------------------------------------------------------- */
    /* Resolve wVDKA (deployment or env)                                 */
    /* ----------------------------------------------------------------- */
    let vdkaInfo;
    try {
      vdkaInfo = await deployments.get("WrappedVerdiktaToken");
    } catch {
      const addr = process.env.WRAPPED_VERDIKTA_TOKEN;
      if (!addr)
        throw new Error("WrappedVerdiktaToken not deployed and env var missing");
      vdkaInfo = {
        address: addr,
        abi: [
          "function balanceOf(address) view returns (uint256)",
          "function transfer(address,uint256) returns (bool)",
        ],
      };
    }
    const verdikta = new ethers.Contract(
      vdkaInfo.address,
      vdkaInfo.abi,
      signer
    );

    /* ----------------------------------------------------------------- */
    /* Auth check: caller must be keeper owner or oracle owner           */
    /* ----------------------------------------------------------------- */
    const keeperOwner = await keeper.owner();

    const MIN_OWNER_ABI = [
      "function owner() view returns (address)",
    ];
    const oracleOwner = await new ethers.Contract(
      ORACLE_ADDR,
      MIN_OWNER_ABI,
      signer
    ).owner();

    if (
      caller.toLowerCase() !== keeperOwner.toLowerCase() &&
      caller.toLowerCase() !== oracleOwner.toLowerCase()
    ) {
      throw new Error("Caller must be keeper owner or oracle owner");
    }

    /* ----------------------------------------------------------------- */
    /* Balance before                                                    */
    /* ----------------------------------------------------------------- */
    const balBefore = await verdikta.balanceOf(caller);
    console.log("Initial wVDKA balance:", ethers.formatEther(balBefore));

    /* ----------------------------------------------------------------- */
    /* Deregister each job ID                                            */
    /* ----------------------------------------------------------------- */
    let idx = 0;
    for (const jobStr of JOB_IDS) {
      idx++;
      const jobId = ethers.hexlify(ethers.toUtf8Bytes(jobStr)).padEnd(66, "0");
      console.log(`\nJob ${idx}: ${jobStr} → ${jobId}`);

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

    /* ----------------------------------------------------------------- */
    /* Balance after                                                     */
    /* ----------------------------------------------------------------- */
    const balAfter = await verdikta.balanceOf(caller);
    console.log("\nFinal wVDKA balance:", ethers.formatEther(balAfter));
    console.log("Deregistration complete.");
    process.exit(0);
  } catch (err) {
    console.error("Error during deregistration:", err);
    process.exit(1);
  }
})();

