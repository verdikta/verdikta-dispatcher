#!/usr/bin/env node
/*
  scripts/oracle-poller-cl.js  – Hardhat version

  Polls all oracle identities registered in a ReputationKeeper, where the
  keeper address is discovered via the supplied ReputationAggregator address.

  Usage:

HARDHAT_NETWORK=base_sepolia node scripts/oracle-poller-cl.js \
  --aggregator 0x262f48f06DEf1FE49e0568dB4234a3478A191cFd

HARDHAT_NETWORK=base node scripts/oracle-poller-cl.js \
  --aggregator 0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089

# Filter to oracles supporting class 128:
HARDHAT_NETWORK=base_sepolia node scripts/oracle-poller-cl.js \
  --aggregator 0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089 --class 128

  Required flag:
    -a, --aggregator    ReputationAggregator contract address

  Optional flag:
    -c, --class         Filter to oracles supporting this capability class
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
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

const ReputationKeeperABI = [
  {
    constant: true,
    inputs: [{ name: "", type: "uint256" }],
    name: "registeredOracles",
    outputs: [
      { name: "oracle", type: "address" },
      { name: "jobId", type: "bytes32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "_oracle", type: "address" },
      { name: "_jobId", type: "bytes32" },
    ],
    name: "getOracleInfo",
    outputs: [
      { name: "isActive", type: "bool" },
      { name: "qualityScore", type: "int256" },
      { name: "timelinessScore", type: "int256" },
      { name: "callCount", type: "uint256" },
      { name: "jobId", type: "bytes32" },
      { name: "fee", type: "uint256" },
      { name: "stakeAmount", type: "uint256" },
      { name: "lockedUntil", type: "uint256" },
      { name: "blocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "_oracle", type: "address" },
      { name: "_jobId", type: "bytes32" },
    ],
    name: "getOracleClassesByKey",
    outputs: [{ name: "", type: "uint64[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
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
        describe: "ReputationAggregator contract address",
        demandOption: true,
      })
      .option("class", {
        alias: "c",
        type: "number",
        describe: "Filter to oracles supporting this capability class",
      })
      .strict()
      .argv;

    const provider = ethers.provider;

    console.log(`Looking up ReputationKeeper from Aggregator at: ${argv.aggregator}`);
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
    const keeperAddress = await aggregator.reputationKeeper();
    console.log(`Found ReputationKeeper at: ${keeperAddress}`);

    if (argv.class !== undefined) {
      console.log(`Filtering to oracles with capability class: ${argv.class}`);
    }

    const keeper = new ethers.Contract(keeperAddress, ReputationKeeperABI, provider);

    /* ------------------------------------------------------------------- */
    /* Scan registeredOracles array                                        */
    /* ------------------------------------------------------------------- */
    console.log("\nAttempting to get oracles directly from registeredOracles array…");
    const foundOracles = [];
    for (let i = 0; i < 100; i++) {
      try {
        const { oracle, jobId } = await keeper.registeredOracles(i);
        if (oracle !== ethers.ZeroAddress) {
          const info = await keeper.getOracleInfo(oracle, jobId);

          // Fetch classes for filtering (and cache for later display)
          let classes = [];
          try {
            classes = await keeper.getOracleClassesByKey(oracle, jobId);
          } catch (_) { }

          // Skip if class filter specified and not matched
          if (argv.class !== undefined) {
            const hasClass = classes.some(c => Number(c) === argv.class);
            if (!hasClass) continue;
          }

          foundOracles.push({ oracle, jobId, info, classes });
        }
      } catch (_) {
        break; // out‑of‑bounds revert -> stop scanning
      }
    }

    if (!foundOracles.length) {
      const msg = argv.class !== undefined
        ? `\nNo oracles found matching class ${argv.class}.`
        : "\nNo oracles found.";
      console.log(msg + "\n" +
        "To register an oracle, ensure that:\n" +
        "1. You have the required VDKA tokens (100 VDKA).\n" +
        "2. You call registerOracle() with the oracle address, jobId, and fee.");
      process.exit(0);
    }

    console.log(`\nFound ${foundOracles.length} oracle(s):`);
    let idx = 1;
    for (const entry of foundOracles) {
      const { oracle: addr, jobId, info, classes } = entry;
      console.log(`\nOracle ${idx++}:`);
      console.log(`Address:           ${addr}`);
      console.log(`Active:            ${info.isActive}`);
      console.log(`Quality Score:     ${info.qualityScore}`);
      console.log(`Timeliness Score:  ${info.timelinessScore}`);
      console.log(`Call Count:        ${info.callCount}`);
      console.log(`Locked Until:      ${info.lockedUntil}`);
      console.log(`Blocked:           ${info.blocked}`);

      /* Job ID as text if possible */
      let printableJobId;
      try {
        printableJobId = ethers.decodeBytes32String(jobId);
      } catch (_) {
        printableJobId = jobId;
      }
      console.log(`Job ID:            ${printableJobId}`);

      /* Capability classes (already fetched) */
      console.log(`Capability Classes: ${classes.length ? classes.join(", ") : "none"}`);

      console.log(`Fee:               ${info.fee}`);

      /* oracle contract owner */
      let ownerAddr;
      try {
        const ownerContract = new ethers.Contract(addr, minimalOwnerABI, provider);
        ownerAddr = await ownerContract.owner();
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

