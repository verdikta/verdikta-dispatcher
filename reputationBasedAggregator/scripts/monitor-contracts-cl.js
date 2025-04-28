#!/usr/bin/env node
/*
  scripts/monitor-contracts-cl.js – Hardhat + ethers (CLI version)

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/monitor-contracts-cl.js \
  --wrappedverdikta 0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3 \
  --aggregator      0x262f48f06DEf1FE49e0568dB4234a3478A191cFd

*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------- */
/* Minimal ABIs                                                        */
/* ------------------------------------------------------------------- */
const WrappedVerdiktaTokenABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)"
];

const KeeperABI = [
  "function owner() view returns (address)",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256 qualityScore,int256 timelinessScore,uint256 callCount,bytes32 jobId,uint256 fee,uint256 stake,uint256 lockedUntil,bool blocked)",
  "function getOracleClassesByKey(address,bytes32) view returns (uint64[])",
  "event OracleRegistered(address indexed oracle,bytes32 jobId,uint256 fee)"
];

const AggregatorABI = [
  "function owner() view returns (address)",
  "function oraclesToPoll() view returns (uint256)",
  "function requiredResponses() view returns (uint256)",
  "function clusterSize() view returns (uint256)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxOracleFee() view returns (uint256)",
  "function getContractConfig() view returns (address oracleAddr,address linkAddr,bytes32 jobId,uint256 fee)",
  "function reputationKeeper() view returns (address)",
  /* we don’t list events explicitly – wildcard filtering is fine in ethers v6 */
];

/* Helper: encode text job-ID to bytes32 if needed ------------------- */
const toBytes32 = (id) =>
  /^0x[0-9a-f]{64}$/i.test(id)
    ? id
    : ethers.hexlify(ethers.toUtf8Bytes(id)).padEnd(66, "0");

/* ------------------------------------------------------------------- */
/* Main                                                                */
/* ------------------------------------------------------------------- */
(async () => {
  try {
    /* ---- CLI flags -------------------------------------------------- */
    const argv = yargs(hideBin(process.argv))
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: true })
      .option("aggregator",      { alias: "a", type: "string", demandOption: true })
      .strict().argv;

    const provider = ethers.provider;

    /* ---- Instantiate contracts ------------------------------------- */
    const token       = new ethers.Contract(argv.wrappedverdikta, WrappedVerdiktaTokenABI, provider);
    const aggregator  = new ethers.Contract(argv.aggregator,      AggregatorABI,           provider);

    const keeperAddr  = await aggregator.reputationKeeper();
    console.log(`Derived ReputationKeeper: ${keeperAddr}`);
    const keeper      = new ethers.Contract(keeperAddr, KeeperABI, provider);

    /* ---- Network info ---------------------------------------------- */
    const net = await provider.getNetwork();
    console.log("\n=== Deployment Information ===");
    console.log(`Network: ${net.name ?? "unknown"} (ID: ${net.chainId})`);

    /* ---- Token info ------------------------------------------------- */
    console.log("\n=== WrappedVerdiktaToken ===");
    const [tName, tSymbol, tSupply] = await Promise.all([
      token.name(),
      token.symbol(),
      token.totalSupply()
    ]);
    console.log(`Address: ${argv.wrappedverdikta}`);
    console.log(`Name:    ${tName}`);
    console.log(`Symbol:  ${tSymbol}`);
    console.log(`Supply:  ${ethers.formatEther(tSupply)} tokens`);

    /* ---- Keeper info ------------------------------------------------ */
    console.log("\n=== ReputationKeeper ===");
    const [kBal, kOwner] = await Promise.all([
      provider.getBalance(keeperAddr),
      keeper.owner()
    ]);
    console.log(`Address: ${keeperAddr}`);
    console.log(`Owner:   ${kOwner}`);
    console.log(`Balance: ${ethers.formatEther(kBal)} ETH`);

    /* ---- Registered oracles ---------------------------------------- */
    console.log("\n=== Registered Oracles ===");
    const regEvents = await keeper.queryFilter("OracleRegistered", 0, "latest");

    const uniq = new Map();
    regEvents.forEach((e) => {
      const { oracle, jobId } = e.args;
      uniq.set(`${oracle}-${jobId}`, { oracle, jobId });
    });

    if (!uniq.size) {
      console.log("No registered oracles.");
    } else {
      let active = 0;
      for (const { oracle, jobId } of uniq.values()) {
        const info = await keeper.getOracleInfo(oracle, jobId);
        if (info.isActive) {
          console.log(`\nOracle: ${oracle}`);
          console.log(`JobID:  ${jobId}`);
          console.log(`Scores: ${info.qualityScore}/${info.timelinessScore}`);
          try {
            const classes = await keeper.getOracleClassesByKey(oracle, jobId);
            console.log(`Classes: ${classes}`);
          } catch {/* ignored */}
          active++;
        }
      }
      if (!active) console.log("None of the registered oracles are active.");
    }

    /* ---- Aggregator info ------------------------------------------- */
    console.log("\n=== ReputationAggregator ===");
    const [
      aggBal,
      aggOwner,
      poll,
      resp,
      cluster,
      timeout,
      maxFee
    ] = await Promise.all([
      provider.getBalance(argv.aggregator),
      aggregator.owner(),
      aggregator.oraclesToPoll(),
      aggregator.requiredResponses(),
      aggregator.clusterSize(),
      aggregator.responseTimeoutSeconds(),
      aggregator.maxOracleFee()
    ]);

    let linkAddr = "(n/a)";
    try { linkAddr = (await aggregator.getContractConfig()).linkAddr; } catch {/* optional */ }

    console.log(`Address:             ${argv.aggregator}`);
    console.log(`Owner:               ${aggOwner}`);
    console.log(`Oracles to Poll:     ${poll}`);
    console.log(`Required Responses:  ${resp}`);
    console.log(`Cluster Size:        ${cluster}`);
    console.log(`Response Timeout:    ${timeout} seconds`);
    console.log(`Max Oracle Fee:      ${ethers.formatEther(maxFee)} LINK`);
    console.log(`LINK Token:          ${linkAddr}`);
    console.log(`Aggregator Balance:  ${ethers.formatEther(aggBal)} ETH`);

    /* ---- Recent events (last 1 000 blocks) -------------------------- */
    const head   = await provider.getBlockNumber();
    const recent = await aggregator.queryFilter("*", Math.max(0, head - 1000), head);

    console.log("\nRecent Aggregator Events:");
    if (!recent.length) console.log("(none)");
    recent.forEach((evt) => {
      console.log(`\nEvent: ${evt.event ?? "(anonymous)"}`);
      console.log("Args:",   evt.args);
      console.log(`Block: ${evt.blockNumber}  Tx: ${evt.transactionHash}`);
    });

    /* ---- Gas price -------------------------------------------------- */
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    console.log(`\nCurrent Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

    console.log("\nMonitoring completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during monitoring:", err);
    process.exit(1);
  }
})();

