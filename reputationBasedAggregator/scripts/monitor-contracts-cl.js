#!/usr/bin/env node
/*
  scripts/monitor-contracts-cl.js  – Hardhat version

  Monitors the on‑chain state of WrappedVerdiktaToken, ReputationAggregator,
  and the ReputationKeeper that the aggregator points to.  All addresses are
  supplied interactively via CLI flags – identical UX to the original Truffle
  script, but now powered by Hardhat + Ethers.

  Usage example:
    npx hardhat run scripts/monitor-contracts-cl.js \
      --network base_sepolia \
      --wrappedverdikta 0x6bF578606493b03026473F838bCD3e3b5bBa5515 \
      --aggregator     0x59067815e006e245449E1A24a1091dF176b3CF09

  Required flags:
    -w, --wrappedverdikta   WrappedVerdiktaToken address
    -a, --aggregator        ReputationAggregator address
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------------- */
/* Minimal ABIs                                                              */
/* ------------------------------------------------------------------------- */
const WrappedVerdiktaTokenABI = [
  {
    constant: true,
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
];

const ReputationKeeperABI = [
  {
    constant: true,
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
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
    anonymous: false,
    inputs: [
      { indexed: true, name: "oracle", type: "address" },
      { indexed: false, name: "jobId", type: "bytes32" },
      { indexed: false, name: "fee", type: "uint256" },
    ],
    name: "OracleRegistered",
    type: "event",
  },
];

const ReputationAggregatorABI = [
  {
    constant: true,
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
    type: "function",
  },
  { constant: true, inputs: [], name: "oraclesToPoll", outputs: [{ name: "", type: "uint256" }], type: "function" },
  { constant: true, inputs: [], name: "requiredResponses", outputs: [{ name: "", type: "uint256" }], type: "function" },
  { constant: true, inputs: [], name: "clusterSize", outputs: [{ name: "", type: "uint256" }], type: "function" },
  { constant: true, inputs: [], name: "responseTimeoutSeconds", outputs: [{ name: "", type: "uint256" }], type: "function" },
  { constant: true, inputs: [], name: "maxOracleFee", outputs: [{ name: "", type: "uint256" }], type: "function" },
  {
    constant: true,
    inputs: [],
    name: "getContractConfig",
    outputs: [
      { name: "oracleAddr", type: "address" },
      { name: "linkAddr", type: "address" },
      { name: "jobId", type: "bytes32" },
      { name: "fee", type: "uint256" },
    ],
    type: "function",
  },
  { constant: true, inputs: [], name: "reputationKeeper", outputs: [{ name: "", type: "address" }], type: "function" },
  { anonymous: false, inputs: [ { indexed: true, name: "requestId", type: "bytes32" }, { indexed: false, name: "cids", type: "string[]" } ], name: "RequestAIEvaluation", type: "event" },
  { anonymous: false, inputs: [ { indexed: true, name: "requestId", type: "bytes32" }, { indexed: false, name: "aggregatedLikelihoods", type: "uint256[]" }, { indexed: false, name: "combinedJustificationCIDs", type: "string" } ], name: "FulfillAIEvaluation", type: "event" },
];

/* ------------------------------------------------------------------------- */
/* Main script                                                               */
/* ------------------------------------------------------------------------- */
(async () => {
  try {
    console.log("Starting contract monitoring…\n");

    /* ---- Parse CLI flags ------------------------------------------------ */
    const argv = yargs(hideBin(process.argv))
      .option("wrappedverdikta", { alias: "w", type: "string", describe: "WrappedVerdiktaToken contract address" })
      .option("aggregator", { alias: "a", type: "string", describe: "ReputationAggregator contract address" })
      .demandOption(["wrappedverdikta", "aggregator"], "Please provide both --wrappedverdikta and --aggregator addresses")
      .strict()
      .argv;

    const provider = ethers.provider;

    /* ---- Instantiate contracts ----------------------------------------- */
    const token = new ethers.Contract(argv.wrappedverdikta, WrappedVerdiktaTokenABI, provider);
    const aggregator = new ethers.Contract(argv.aggregator, ReputationAggregatorABI, provider);

    const keeperAddress = await aggregator.reputationKeeper();
    console.log(`Derived ReputationKeeper address: ${keeperAddress}`);
    const keeper = new ethers.Contract(keeperAddress, ReputationKeeperABI, provider);

    /* ---- Network info --------------------------------------------------- */
    const net = await provider.getNetwork();
    console.log("\n=== Deployment Information ===");
    console.log(`Network: ${net.name ?? "unknown"} (ID: ${net.chainId})`);

    /* ---- Token info ----------------------------------------------------- */
    console.log("\n=== WrappedVerdiktaToken Information ===");
    const [tokenName, tokenSymbol, totalSupply] = await Promise.all([
      token.name(),
      token.symbol(),
      token.totalSupply(),
    ]);
    console.log(`Address: ${argv.wrappedverdikta}`);
    console.log(`Name:    ${tokenName}`);
    console.log(`Symbol:  ${tokenSymbol}`);
    console.log(`Supply:  ${ethers.formatEther(totalSupply)} tokens`);

    /* ---- Keeper info ---------------------------------------------------- */
    console.log("\n=== ReputationKeeper Information ===");
    const [keeperBalance, keeperOwner] = await Promise.all([
      provider.getBalance(keeperAddress),
      keeper.owner(),
    ]);
    console.log(`Address:  ${keeperAddress}`);
    console.log(`Owner:    ${keeperOwner}`);
    console.log(`Balance:  ${ethers.formatEther(keeperBalance)} ETH`);

    /* ---- Registered oracles ------------------------------------------- */
    console.log("\n=== Registered Oracles Information ===");
    const oracleRegisteredFilter = keeper.filters.OracleRegistered();
    const registeredEvents = await keeper.queryFilter(oracleRegisteredFilter, 0, "latest");

    const uniqueOracles = new Map();
    for (const evt of registeredEvents) {
      const { oracle, jobId, fee } = evt.args;
      const key = `${oracle}-${jobId}`;
      if (!uniqueOracles.has(key)) uniqueOracles.set(key, { oracle, jobId, fee });
    }

    if (uniqueOracles.size === 0) {
      console.log("No registered oracles found");
    } else {
      console.log("Active registered oracles:");
      let activeCount = 0;
      for (const { oracle, jobId, fee } of uniqueOracles.values()) {
        const info = await keeper.getOracleInfo(oracle, jobId);
        if (info.isActive) {
          console.log(`\nOracle Address:      ${oracle}`);
          console.log(`Job ID (bytes32):    ${jobId}`);
          console.log(`Quality Score:       ${info.qualityScore}`);
          console.log(`Timeliness Score:    ${info.timelinessScore}`);
          console.log(`Call Count:          ${info.callCount}`);
          console.log(`Fee:                ${info.fee}`);
          try {
            const classes = await keeper.getOracleClassesByKey(oracle, jobId);
            console.log(`Classes:             ${classes}`);
          } catch (_) {
            console.log("Classes:             Not available");
          }
          activeCount++;
        }
      }
      if (activeCount === 0) console.log("None of the registered oracles are active.");
    }

    /* ---- Aggregator info ---------------------------------------------- */
    console.log("\n=== ReputationAggregator Information ===");
    const [aggBalance, aggOwner, oraclesToPoll, requiredResponses, clusterSize, responseTimeout, maxOracleFee] = await Promise.all([
      provider.getBalance(argv.aggregator),
      aggregator.owner(),
      aggregator.oraclesToPoll(),
      aggregator.requiredResponses(),
      aggregator.clusterSize(),
      aggregator.responseTimeoutSeconds(),
      aggregator.maxOracleFee(),
    ]);

    let linkAddr = "(none)";
    try {
      const cfg = await aggregator.getContractConfig();
      linkAddr = cfg.linkAddr;
    } catch (_) {
      /* method may revert if not configured */
    }

    console.log("\nAggregator Configuration:");
    console.log(`Address:             ${argv.aggregator}`);
    console.log(`Owner:               ${aggOwner}`);
    console.log(`Oracles to Poll:     ${oraclesToPoll}`);
    console.log(`Required Responses:  ${requiredResponses}`);
    console.log(`Cluster Size:        ${clusterSize}`);
    console.log(`Response Timeout:    ${responseTimeout} seconds`);
    console.log(`Max Oracle Fee:      ${ethers.formatEther(maxOracleFee)} LINK`);
    console.log(`LINK Token (if any): ${linkAddr}`);
    console.log(`Aggregator Balance:  ${ethers.formatEther(aggBalance)} ETH`);

    /* ---- Recent Aggregator events (last 1,000 blocks) ------------------ */
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 1000);
    const recentEvents = await aggregator.queryFilter({}, fromBlock, "latest");

    console.log("\nRecent Aggregator Events:");
    if (recentEvents.length === 0) {
      console.log("(none in last 1,000 blocks)");
    } else {
      for (const evt of recentEvents) {
        console.log(`\nEvent:        ${evt.event ?? "(anonymous)"}`);
        console.log("Parameters:", evt.args);
        console.log(`Block:        ${evt.blockNumber}`);
        console.log(`Transaction:  ${evt.transactionHash}`);
      }
    }

    /* ---- Gas price ----------------------------------------------------- */
    const gasPrice = await provider.getGasPrice();
    console.log(`\nCurrent Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

    console.log("\nMonitoring completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during monitoring:", err);
    process.exit(1);
  }
})();

