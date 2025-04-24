#!/usr/bin/env node
/*
  scripts/register-oracle.js – Hardhat version

  Hard‑coded oracle + job IDs (same as original Truffle script) for Base Sepolia.
  Uses contracts from hardhat‑deploy artifacts; no CLI flags required.

  Run:
    npx hardhat run scripts/register-oracle-base.js --network base_sepolia
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
  "cdee0a127bc74a5188cbabf7aadcc84f",
];
const LINK_FEE  = ethers.parseUnits("0.05", 18); // 0.05 LINK
const VDKA_STAKE= ethers.parseUnits("100", 18); // 100 wVDKA

/* ------------------------------------------------------------------------- */
(async () => {
  try {
    console.log("Starting oracle registration on Base Sepolia…\n");

    const [signer] = await ethers.getSigners();
    const owner = await signer.getAddress();
    console.log("Using owner:", owner);

    /* ------------------------------------------------------------------- */
    /* Resolver: contracts from deployments                                */
    /* ------------------------------------------------------------------- */
    const verdiktaInfo = await deployments.get("WrappedVerdiktaToken");
    const keeperInfo   = await deployments.get("ReputationKeeper");
    const aggInfo      = await deployments.get("ReputationAggregator");
    const linkInfo     = await deployments.get("LinkTokenInterface");

    const verdikta  = new ethers.Contract(verdiktaInfo.address, verdiktaInfo.abi, signer);
    const keeper    = new ethers.Contract(keeperInfo.address,   keeperInfo.abi,   signer);
    const aggregator= new ethers.Contract(aggInfo.address,      aggInfo.abi,      signer);
    const linkToken = new ethers.Contract(linkInfo.address,     linkInfo.abi,     signer);

    /* ------------------------------------------------------------------- */
    /* Ensure wVDKA allowance                                              */
    /* ------------------------------------------------------------------- */
    const vdkaBal = await verdikta.balanceOf(owner);
    if (vdkaBal < VDKA_STAKE) throw new Error("Insufficient wVDKA balance");

    let vdkaAllowance = await verdikta.allowance(owner, keeper.target);
    if (vdkaAllowance < VDKA_STAKE) {
      console.log("Approving keeper to spend wVDKA…");
      await (await verdikta.approve(keeper.target, VDKA_STAKE)).wait();
    }

    /* ------------------------------------------------------------------- */
    /* Register each job ID                                                */
    /* ------------------------------------------------------------------- */
    let idx = 0;
    for (const jobStr of JOB_IDS) {
      const jobId = ethers.hexlify(ethers.toUtf8Bytes(jobStr)).padEnd(66, "0");
      console.log(`\nJob ${++idx}: ${jobStr} → ${jobId}`);

      const info = await keeper.getOracleInfo(ORACLE_ADDR, jobId);
      if (info.isActive) {
        console.log("Already registered – skipping");
        continue;
      }

      const classes = [128, 129 + idx - 1];
      console.log("Calling registerOracle…", classes);
      await (await keeper.registerOracle(ORACLE_ADDR, jobId, LINK_FEE, classes)).wait();
      console.log("✓ Registered");
    }

    /* ------------------------------------------------------------------- */
    /* Ensure LINK approval for aggregator                                 */
    /* ------------------------------------------------------------------- */
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

