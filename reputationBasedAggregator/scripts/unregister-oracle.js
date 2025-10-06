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
const ORACLE_ADDR = "0x00A08b75178de0e0d7FF13Fdd4ef925AC3572503";
const JOB_IDS = [
  "6c751f1a36f348dc8655c11e0f804b31",
  "4d48270ca94f45188b3ec06f0dba8742",
  "c6a5a82aa4814f8296c30fa44aff715e",
  "cdee0a127bc74a5188cbabf7aadcc84f",
  "39515f75ac2947beb7f2eeae4d8eaf3e",
  "38f19572c51041baa5f2dea284614590",
  "6f0ab41b6ffd4245bb1be16064043bfc",
  "6230e342f7ff47aca7e62f9b0bc097df",
  "184c2fd08a634719adc9183846e91380",
  "858acbb95d90492bbff6a0eb568112b0"
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
      const addr = process.env.WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA;
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

