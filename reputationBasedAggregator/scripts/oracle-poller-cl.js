#!/usr/bin/env node
/*
  scripts/oracle-poller-cl.js  – Hardhat version

  Polls all oracle identities registered in a ReputationKeeper, where the
  keeper address is discovered via the supplied ReputationAggregator address.

  Usage:

HARDHAT_NETWORK=base_sepolia node scripts/oracle-poller-cl.js \
  --aggregator 0x262f48f06DEf1FE49e0568dB4234a3478A191cFd

HARDHAT_NETWORK=base node scripts/oracle-poller-cl.js \
  --aggregator 0x2f7a02298D4478213057edA5e5bEB07F20c4c054

  Required flag:
    -a, --aggregator    ReputationAggregator contract address
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
      .strict()
      .argv;

    const provider = ethers.provider;

    console.log(`Looking up ReputationKeeper from Aggregator at: ${argv.aggregator}`);
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
    const keeperAddress = await aggregator.reputationKeeper();
    console.log(`Found ReputationKeeper at: ${keeperAddress}`);

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
          foundOracles.push({ oracle, jobId, info });
        }
      } catch (_) {
        break; // out‑of‑bounds revert -> stop scanning
      }
    }

    if (!foundOracles.length) {
      console.log("\nNo oracles found.\n" +
        "To register an oracle, ensure that:\n" +
        "1. You have the required VDKA tokens (100 VDKA).\n" +
        "2. You call registerOracle() with the oracle address, jobId, and fee.");
      process.exit(0);
    }

    console.log(`\nFound ${foundOracles.length} oracle(s):`);
    let idx = 1;
    for (const oracle of foundOracles) {
      const { oracle: addr, jobId, info } = oracle;
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

      /* Capability classes */
      try {
        const classes = await keeper.getOracleClassesByKey(addr, jobId);
        console.log(`Capability Classes:${classes}`);
      } catch (_) {
        console.log("Capability Classes: not available");
      }

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

