#!/usr/bin/env node
/*
  scripts/monitor-contracts.js  – Hardhat version

  Reads the **deployed addresses** of WrappedVerdiktaToken, ReputationKeeper and
  ReputationAggregator from *hardhat‑deploy* artifacts and prints their on‑chain
  status. No CLI flags needed – it mirrors the original Truffle `.deployed()`
  behaviour.

  Usage:
    npx hardhat run scripts/monitor-contracts.js --network base_sepolia

  Prerequisite: your deployment was performed with hardhat‑deploy, which writes
  JSON files under `deployments/<network>/`. Those JSON files supply the
  address + ABI for each contract.
*/

require("dotenv").config();
import("hardhat").then(async (hre) => {
  const { ethers, deployments, network } = hre;

  try {
    console.log("Starting contract monitoring…\n");

    /* ------------------------------------------------------------------- */
    /* Attach to deployed contracts via hardhat‑deploy                      */
    /* ------------------------------------------------------------------- */
    const verdiktaInfo  = await deployments.get("WrappedVerdiktaToken");
    const keeperInfo    = await deployments.get("ReputationKeeper");
    const aggregatorInfo= await deployments.get("ReputationAggregator");

    const provider   = ethers.provider;
    const verdikta   = new ethers.Contract(verdiktaInfo.address, verdiktaInfo.abi, provider);
    const keeper     = new ethers.Contract(keeperInfo.address,   keeperInfo.abi,   provider);
    const aggregator = new ethers.Contract(aggregatorInfo.address, aggregatorInfo.abi, provider);

    /* ------------------------------------------------------------------- */
    /* Network info                                                        */
    /* ------------------------------------------------------------------- */
    console.log("\n=== Deployment Information ===");
    const net = await provider.getNetwork();
    console.log(`Network: ${net.name ?? "unknown"} (ID: ${net.chainId})`);

    /* ------------------------------------------------------------------- */
    /* WrappedVerdiktaToken                                                */
    /* ------------------------------------------------------------------- */
    console.log("\n=== WrappedVerdiktaToken Information ===");
    const [tokenName, tokenSymbol, totalSupply] = await Promise.all([
      verdikta.name(),
      verdikta.symbol(),
      verdikta.totalSupply(),
    ]);
    console.log(`Address: ${verdikta.target}`);
    console.log(`Name:    ${tokenName}`);
    console.log(`Symbol:  ${tokenSymbol}`);
    console.log(`Supply:  ${ethers.formatEther(totalSupply)} tokens`);

    /* ------------------------------------------------------------------- */
    /* ReputationKeeper                                                    */
    /* ------------------------------------------------------------------- */
    console.log("\n=== ReputationKeeper Information ===");
    const [keeperBalance, keeperOwner] = await Promise.all([
      provider.getBalance(keeper.target),
      keeper.owner(),
    ]);
    console.log(`Address:  ${keeper.target}`);
    console.log(`Owner:    ${keeperOwner}`);
    console.log(`Balance:  ${ethers.formatEther(keeperBalance)} ETH`);

    /* ------------------------------------------------------------------- */
    /* Registered oracles                                                  */
    /* ------------------------------------------------------------------- */
    console.log("\n=== Registered Oracles Information ===");
    const events = await keeper.queryFilter(keeper.filters.OracleRegistered(), 0, "latest");
    const seen = new Map();
    for (const evt of events) {
      const { oracle, jobId, fee } = evt.args;
      const key = `${oracle}-${jobId}`;
      if (!seen.has(key)) seen.set(key, { oracle, jobId, fee });
    }
    if (seen.size === 0) {
      console.log("No registered oracles found");
    } else {
      let active = 0;
      for (const { oracle, jobId } of seen.values()) {
        const info = await keeper.getOracleInfo(oracle, jobId);
        if (info.isActive) {
          console.log(`\nOracle: ${oracle}`);
          console.log(`Job ID: ${jobId}`);
          console.log(`Quality/Timeliness: ${info.qualityScore}/${info.timelinessScore}`);
          try {
            const classes = await keeper.getOracleClassesByKey(oracle, jobId);
            console.log(`Classes: ${classes}`);
          } catch (_) {
            console.log("Classes: n/a");
          }
          active++;
        }
      }
      if (active === 0) console.log("None of the registered oracles are active.");
    }

    /* ------------------------------------------------------------------- */
    /* ReputationAggregator                                                */
    /* ------------------------------------------------------------------- */
    console.log("\n=== ReputationAggregator Information ===");
    const [aggBalance, aggOwner, oraclesToPoll, requiredResponses, clusterSize, responseTimeout, maxOracleFee] = await Promise.all([
      provider.getBalance(aggregator.target),
      aggregator.owner(),
      aggregator.oraclesToPoll(),
      aggregator.requiredResponses(),
      aggregator.clusterSize(),
      aggregator.responseTimeoutSeconds(),
      aggregator.maxOracleFee(),
    ]);
    let linkAddr = "(none)";
    try {
      linkAddr = (await aggregator.getContractConfig()).linkAddr;
    } catch (_) {/* may revert */}

    console.log(`Address:             ${aggregator.target}`);
    console.log(`Owner:               ${aggOwner}`);
    console.log(`Oracles to Poll:     ${oraclesToPoll}`);
    console.log(`Required Responses:  ${requiredResponses}`);
    console.log(`Cluster Size:        ${clusterSize}`);
    console.log(`Response Timeout:    ${responseTimeout} seconds`);
    console.log(`Max Oracle Fee:      ${ethers.formatEther(maxOracleFee)} LINK`);
    console.log(`LINK Token (if any): ${linkAddr}`);
    console.log(`Aggregator Balance:  ${ethers.formatEther(aggBalance)} ETH`);

    /* recent events */
    const head = await provider.getBlockNumber();
    const recent = await aggregator.queryFilter({}, Math.max(0, head - 1000), head);
    console.log("\nRecent Aggregator Events:");
    if (!recent.length) {
      console.log("(none in last 1,000 blocks)");
    } else {
      recent.forEach((evt) => {
        console.log(`\nEvent: ${evt.event ?? "(anonymous)"}`);
        console.log("Args:", evt.args);
        console.log(`Block: ${evt.blockNumber}  Tx: ${evt.transactionHash}`);
      });
    }

    const gasPrice = await provider.getGasPrice();
    console.log(`\nCurrent Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

    console.log("\nMonitoring completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during monitoring:", err);
    process.exit(1);
  }
});

