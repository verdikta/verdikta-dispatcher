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
const ORACLE_ADDR = "0xcD98fbbeEF2234e6AaA7E0eA0895f14BeB06b4aD";
const JOB_IDS = [
"639f4810bf3543ccac0249b44f49d87d",
"34281012a46b45a98f6db07d79f6c7d0",
"60568680560b40538301f8a85d77a110",
"cbcc6e32520e444f9c6dbff906dc2008",
"75b40e14138b42abaf2ee306273805d7",
"41efd4f85fd2451d99da15467d0ec4f5",
"053fdd8194c5452895ee57e858bd2b2c",
"d1eb055ce8c847d79d1996bebbab971f",
"8cd27da50f384cfa9142c50ce429f6ed",
"358a35ba97c640e285f24bfda5b925e8"
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

