#!/usr/bin/env node
/*
  scripts/oracle-poller.js  – Hardhat + ethers

  • If you pass --aggregator (-a) the keeper address is read from that
    contract. Otherwise the keeper address is taken from hardhat-deploy
    artefacts (mimics Truffle’s .deployed()).

  Examples
  --------
  # With an explicit aggregator address
  npx hardhat run scripts/oracle-poller.js --network base_sepolia \
    --aggregator 0xbabE69DdF8CBbe63fEDB6f49904efB35522667Af

  # Using the keeper from deployments (no flags)
  npx hardhat run scripts/oracle-poller.js --network base_sepolia
*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers, deployments } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------ ABIs ---------------------------------- */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)"
];

const minimalOwnerABI = [
  "function owner() view returns (address)"
];

/* ------------------------------ Helpers ------------------------------- */
const bytes32ToAscii = (b32) =>
  // decode & strip trailing nulls
  ethers.toUtf8String(b32).replace(/\0+$/, "");

/* --------------------------------------------------------------------- */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", {
        alias: "a",
        type: "string",
        describe: "ReputationAggregator contract address"
      })
      .strict().argv;

    const provider = ethers.provider;

    /* Resolve keeper address ------------------------------------------ */
    let keeperAddr;
    if (argv.aggregator) {
      console.log(`Looking up ReputationKeeper via Aggregator ${argv.aggregator} …`);
      const agg = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
      keeperAddr = await agg.reputationKeeper();
    } else {
      const info  = await deployments.get("ReputationKeeper");
      keeperAddr  = info.address;
      console.log("ReputationKeeper from artefacts:", keeperAddr);
    }

    /* Keeper instance -------------------------------------------------- */
    const keeperInfo = await deployments.get("ReputationKeeper");
    const keeper     = new ethers.Contract(keeperAddr, keeperInfo.abi, provider);

    console.log(`Connected to ReputationKeeper at ${keeperAddr}`);

    /* Scan the public registeredOracles array ------------------------- */
    const found = [];
    for (let i = 0; i < 100; i++) {
      try {
        const { oracle, jobId } = await keeper.registeredOracles(i);
        if (oracle !== ethers.ZeroAddress) {
          const info = await keeper.getOracleInfo(oracle, jobId);
          let recentScores = [];
          try {
            recentScores = await keeper.getRecentScores(oracle, jobId);
          } catch (err) {
            console.log(`Warning: Could not fetch score history for oracle ${oracle}: ${err.message}`);
          }
          found.push({ oracle, jobId, info, recentScores });
        }
      } catch { break; } // reached past-end
    }

    if (!found.length) {
      console.log("\nNo oracles found.\nTo register one:\n  – hold 100 wVDKA\n  – call registerOracle()");
      return;
    }

    console.log(`\nFound ${found.length} oracle(s):`);
    let n = 1;
    for (const { oracle, jobId, info, recentScores } of found) {
      console.log(`\nOracle ${n++}`);
      console.log(`Address:            ${oracle}`);
      console.log(`Active:             ${info.isActive}`);
      console.log(`Quality Score:      ${info.qualityScore}`);
      console.log(`Timeliness Score:   ${info.timelinessScore}`);
      console.log(`Call Count:         ${info.callCount}`);
      console.log(`Locked Until:       ${info.lockedUntil}`);
      console.log(`Blocked:            ${info.blocked}`);

      /* ---- job-id in both representations ---- */
      console.log(`JobID  (bytes32):   ${jobId}`);
      console.log(`JobID  (ascii) :    ${bytes32ToAscii(jobId)}`);

      /* Capability classes */
      try {
        const classes = await keeper.getOracleClassesByKey(oracle, jobId);
        console.log(`Classes:            ${classes}`);
      } catch { console.log("Classes:            n/a"); }

      console.log(`Fee:                ${info.fee}`);

      /* Oracle owner --------------------------------------------------- */
      let owner;
      try {
        owner = await new ethers.Contract(oracle, minimalOwnerABI, provider).owner();
      } catch { owner = "(couldn’t fetch)"; }
      console.log(`Owner Address:      ${owner}`);

      /* Score History -------------------------------------------------- */
      if (recentScores && recentScores.length > 0) {
        console.log(`\nScore History (${recentScores.length} records):`);
        console.log(`${'Index'.padEnd(8)} ${'Quality'.padEnd(12)} ${'Timeliness'.padEnd(12)}`);
        console.log(`${'-----'.padEnd(8)} ${'-------'.padEnd(12)} ${'----------'.padEnd(12)}`);
        
        recentScores.forEach((scoreRecord, index) => {
          const quality = scoreRecord.qualityScore.toString();
          const timeliness = scoreRecord.timelinessScore.toString();
          console.log(`${(index + 1).toString().padEnd(8)} ${quality.padEnd(12)} ${timeliness.padEnd(12)}`);
        });
      } else {
        console.log(`\nScore History:      No historical scores available`);
      }
    }
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

