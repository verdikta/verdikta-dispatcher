#!/usr/bin/env node
/*
  scripts/register-oracle.js – Hardhat + ethers (Base Sepolia)
  Run:
    npx hardhat run scripts/register-oracle.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

/* --------------------------------------------------------------------- */
const ORACLE_ADDR = "0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101";
const JOB_IDS = [
  "38f19572c51041baa5f2dea284614590",
  "39515f75ac2947beb7f2eeae4d8eaf3e",
  "cdee0a127bc74a5188cbabf7aadcc84f",
];
const LINK_FEE   = ethers.parseUnits("0.006", 18);  // 0.02 LINK
const VDKA_STAKE = ethers.parseUnits("100", 18);   // 100 wVDKA
/* --------------------------------------------------------------------- */

(async () => {
  try {
    console.log("Starting oracle registration on Base Sepolia…\n");

    const [signer] = await ethers.getSigners();
    const owner    = await signer.getAddress();
    console.log("Using owner:", owner);

    /* ----------------------------------------------------------------- */
    /* Resolve contracts                                                 */
    /* ----------------------------------------------------------------- */
    const keeperInfo = await deployments.get("ReputationKeeper");
    const aggInfo    = await deployments.get("ReputationAggregator");

    // wVDKA: deployment or .env
    let vdkaInfo;
    try {
      vdkaInfo = await deployments.get("WrappedVerdiktaToken");
    } catch {
      const addr = process.env.WRAPPED_VERDIKTA_TOKEN;
      if (!addr) throw new Error("WrappedVerdiktaToken not deployed and env var missing");
      vdkaInfo = {
        address: addr,
        abi: [
          "function balanceOf(address) view returns (uint256)",
          "function allowance(address,address) view returns (uint256)",
          "function approve(address,uint256) returns (bool)"
        ],
      };
    }

    // LINK token
    let linkInfo;
    try {
      linkInfo = await deployments.get("LinkTokenInterface");
    } catch {
      const cfg = await new ethers.Contract(
        aggInfo.address,
        aggInfo.abi,
        signer
      ).getContractConfig();
      linkInfo = {
        address: cfg.linkAddr,
        abi: [
          "function allowance(address,address) view returns (uint256)",
          "function approve(address,uint256) returns (bool)",
        ],
      };
    }

    /* ----------------------------------------------------------------- */
    /* Contract instances                                                */
    /* ----------------------------------------------------------------- */
    const verdikta   = new ethers.Contract(vdkaInfo.address, vdkaInfo.abi, signer);
    const keeper     = new ethers.Contract(keeperInfo.address, keeperInfo.abi, signer);
    const aggregator = new ethers.Contract(aggInfo.address,   aggInfo.abi,   signer);
    const linkToken  = new ethers.Contract(linkInfo.address,  linkInfo.abi,  signer);

    /* ----------------------------------------------------------------- */
    /* Approve total stake once                                          */
    /* ----------------------------------------------------------------- */
    const totalStake = VDKA_STAKE * BigInt(JOB_IDS.length);

    const vdkaBal = await verdikta.balanceOf(owner);
    if (vdkaBal < totalStake) throw new Error("Insufficient wVDKA balance");

    let vdkaAllowance = await verdikta.allowance(owner, keeperInfo.address);
    if (vdkaAllowance < totalStake) {
      console.log(`Approving ${ethers.formatEther(totalStake)} wVDKA for keeper…`);
      await (await verdikta.approve(keeperInfo.address, totalStake)).wait();
    }

    /* ----------------------------------------------------------------- */
    /* Register each job ID                                              */
    /* ----------------------------------------------------------------- */
    let idx = 0;
    for (const jobStr of JOB_IDS) {
      idx++;
      // encodeBytes32String requires ≤31 chars; our IDs are 32-hex, so use hexlify
      const jobId = ethers.hexlify(ethers.toUtf8Bytes(jobStr)).padEnd(66, "0");
      console.log(`\nJob ${idx}: ${jobStr} → ${jobId}`);

      const info = await keeper.getOracleInfo(ORACLE_ADDR, jobId);
      if (info.isActive) {
        console.log("Already registered – skipping");
        continue;
      }

      const classes = [128, 128 + idx];   // example classes
      console.log("Calling registerOracle…", classes);
      await (
        await keeper.registerOracle(ORACLE_ADDR, jobId, LINK_FEE, classes)
      ).wait();
      console.log("✓ Registered");
    }

    /* ----------------------------------------------------------------- */
    /* Ensure LINK approval for aggregator                               */
    /* ----------------------------------------------------------------- */
    const linkAllowance = await linkToken.allowance(owner, aggInfo.address);
    if (linkAllowance < LINK_FEE) {
      console.log("Approving LINK for aggregator…");
      await (await linkToken.approve(aggInfo.address, LINK_FEE)).wait();
    }

    console.log("\nSetup completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle registration:", err);
    process.exit(1);
  }
})();

