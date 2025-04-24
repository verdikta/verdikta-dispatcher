#!/usr/bin/env node
/*
  scripts/oracle-poller.js  – Hardhat version

  Same behaviour as the original Truffle script:
    • If you supply --aggregator ( -a ) the keeper address is read from that
      aggregator contract.
    • Otherwise the ReputationKeeper address is loaded from hardhat‑deploy
      artifacts (mimics .deployed()).

  Usage examples:
    # Use explicit aggregator address
    npx hardhat run scripts/oracle-poller.js --network base_sepolia \
      --aggregator 0xbabE69DdF8CBbe63fEDB6f49904efB35522667Af

    # Use keeper from artifacts (no flags)
    npx hardhat run scripts/oracle-poller.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------------- */
/* Minimal ABIs                                                              */
/* ------------------------------------------------------------------------- */
const AggregatorABI = [
  {
    inputs: [],
    name: "reputationKeeper",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

const minimalOwnerABI = [
  {
    constant: true,
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

/* ------------------------------------------------------------------------- */
/* Main                                                                      */
/* ------------------------------------------------------------------------- */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", {
        alias: "a",
        type: "string",
        describe: "Aggregator contract address",
      })
      .strict()
      .argv;

    const provider = ethers.provider;

    /* -------------------------------------------------------------- */
    /* Determine keeper address                                       */
    /* -------------------------------------------------------------- */
    let keeperAddr;
    if (argv.aggregator) {
      console.log(`Looking up ReputationKeeper from Aggregator at: ${argv.aggregator}`);
      const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
      keeperAddr = await aggregator.reputationKeeper();
      console.log(`Found ReputationKeeper at: ${keeperAddr}`);
    } else {
      // load from deployments (mimics .deployed())
      const keeperInfo = await deployments.get("ReputationKeeper");
      keeperAddr = keeperInfo.address;
      console.log(`Using ReputationKeeper from artifacts: ${keeperAddr}`);
    }

    /* -------------------------------------------------------------- */
    /* Load keeper ABI from artifacts                                 */
    /* -------------------------------------------------------------- */
    const keeperInfo = await deployments.get("ReputationKeeper");
    const keeperAbi = keeperInfo.abi;
    const keeper = new ethers.Contract(keeperAddr, keeperAbi, provider);

    console.log(`Connected to ReputationKeeper at: ${keeperAddr}`);

    /* -------------------------------------------------------------- */
    /* Scan registeredOracles array                                   */
    /* -------------------------------------------------------------- */
    console.log("\nAttempting to get oracles directly...");

    const foundOracles = [];
    for (let i = 0; i < 100; i++) {
      try {
        const { oracle, jobId } = await keeper.registeredOracles(i);
        if (oracle !== ethers.ZeroAddress) {
          const info = await keeper.getOracleInfo(oracle, jobId);
          foundOracles.push({ oracle, jobId, info });
        }
      } catch (_) {
        break; // reached end of array
      }
    }

    if (!foundOracles.length) {
      console.log("\nNo oracles found.\nTo register an oracle you need:\n  1. 100 VDKA tokens\n  2. registerOracle(oracle, jobId, fee)");
      process.exit(0);
    }

    console.log(`\nFound ${foundOracles.length} oracle(s):`);
    let idx = 1;
    for (const { oracle, jobId, info } of foundOracles) {
      console.log(`\nOracle ${idx++}:`);
      console.log(`Address:           ${oracle}`);
      console.log(`Active:            ${info.isActive}`);
      console.log(`Quality Score:     ${info.qualityScore}`);
      console.log(`Timeliness Score:  ${info.timelinessScore}`);
      console.log(`Call Count:        ${info.callCount}`);
      console.log(`Locked Until:      ${info.lockedUntil}`);
      console.log(`Blocked:           ${info.blocked}`);
      // printable job ID
      let printableJobId;
      try {
        printableJobId = ethers.decodeBytes32String(jobId);
      } catch (_) {
        printableJobId = jobId;
      }
      console.log(`Job ID:            ${printableJobId}`);
      // capability classes
      try {
        const classes = await keeper.getOracleClassesByKey(oracle, jobId);
        console.log(`Capability Classes:${classes}`);
      } catch (_) {
        console.log("Capability Classes: not available");
      }
      console.log(`Fee:               ${info.fee}`);

      /* owner() of oracle contract */
      let ownerAddr;
      try {
        const ownerC = new ethers.Contract(oracle, minimalOwnerABI, provider);
        ownerAddr = await ownerC.owner();
      } catch (_) {
        ownerAddr = "(error retrieving owner)";
      }
      console.log(`Owner Address:     ${ownerAddr}`);
    }

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

