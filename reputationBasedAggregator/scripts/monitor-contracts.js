#!/usr/bin/env node
/*
  scripts/monitor-contracts.js – Hardhat + ethers
  Usage:
    npx hardhat run scripts/monitor-contracts.js --network development
    npx hardhat run scripts/monitor-contracts.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

(async () => {
  try {
    console.log("Starting contract monitoring…\n");

    /* Provider & signer ------------------------------------------------- */
    const provider = ethers.provider;
    const accts    = await ethers.getSigners();
    const signer   = accts.length ? accts[0] : provider;   // read-only fallback

    /* Load deployment artifacts ---------------------------------------- */
    const keeperInfo     = await deployments.get("ReputationKeeper");
    const aggregatorInfo = await deployments.get("ReputationAggregator");

    /* WrappedVerdiktaToken (deployment or env fallback) ---------------- */
    let verdiktaAddr, verdiktaAbi;
    try {
      const info = await deployments.get("WrappedVerdiktaToken");
      verdiktaAddr = info.address;
      verdiktaAbi  = info.abi;
    } catch {
      verdiktaAddr = process.env.WRAPPED_VERDIKTA_TOKEN;
      if (!verdiktaAddr)
        throw new Error("Token not deployed and WRAPPED_VERDIKTA_TOKEN env var missing");
      verdiktaAbi = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function totalSupply() view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
      ];
    }

    /* Contract instances ----------------------------------------------- */
    const verdikta   = new ethers.Contract(verdiktaAddr, verdiktaAbi, signer);
    const keeper     = new ethers.Contract(keeperInfo.address,     keeperInfo.abi,     signer);
    const aggregator = new ethers.Contract(aggregatorInfo.address, aggregatorInfo.abi, signer);

    /* Network info ------------------------------------------------------ */
    const net = await provider.getNetwork();
    console.log("=== Deployment Information ===");
    console.log(`Network: ${net.name ?? "unknown"} (ID: ${net.chainId})`);

    /* WrappedVerdiktaToken --------------------------------------------- */
    console.log("\n=== WrappedVerdiktaToken ===");
    const [tName, tSymbol, tSupply] = await Promise.all([
      verdikta.name(),
      verdikta.symbol(),
      verdikta.totalSupply(),
    ]);
    console.log(`Address: ${verdiktaAddr}`);
    console.log(`Name:    ${tName}`);
    console.log(`Symbol:  ${tSymbol}`);
    console.log(`Supply:  ${ethers.formatEther(tSupply)} tokens`);

    /* ReputationKeeper -------------------------------------------------- */
    console.log("\n=== ReputationKeeper ===");
    const [kBalance, kOwner] = await Promise.all([
      provider.getBalance(keeper.target),
      keeper.owner(),
    ]);
    console.log(`Address: ${keeper.target}`);
    console.log(`Owner:   ${kOwner}`);
    console.log(`Balance: ${ethers.formatEther(kBalance)} ETH`);

    /* Registered oracles ----------------------------------------------- */
    console.log("\n=== Registered Oracles ===");
    const regEvents = await keeper.queryFilter(
      keeper.filters.OracleRegistered(),
      0,
      "latest"
    );
    const unique = new Map();
    regEvents.forEach((e) => {
      const { oracle, jobId } = e.args;
      unique.set(`${oracle}-${jobId}`, { oracle, jobId });
    });

    if (!unique.size) {
      console.log("No registered oracles.");
    } else {
      let active = 0;
      for (const { oracle, jobId } of unique.values()) {
        const info = await keeper.getOracleInfo(oracle, jobId);
        if (info.isActive) {
          console.log(`\nOracle: ${oracle}`);
          console.log(`JobID:  ${jobId}`);
          console.log(`Scores: ${info.qualityScore}/${info.timelinessScore}`);
          try {
            const classes = await keeper.getOracleClassesByKey(oracle, jobId);
            console.log(`Classes: ${classes}`);
          } catch {}
          active++;
        }
      }
      if (!active) console.log("None of the registered oracles are active.");
    }

    /* ReputationAggregator --------------------------------------------- */
    console.log("\n=== ReputationAggregator ===");
    const [
      aggBal,
      aggOwner,
      poll,
      resp,
      cluster,
      timeout,
      maxFee,
    ] = await Promise.all([
      provider.getBalance(aggregator.target),
      aggregator.owner(),
      aggregator.oraclesToPoll(),
      aggregator.requiredResponses(),
      aggregator.clusterSize(),
      aggregator.responseTimeoutSeconds(),
      aggregator.maxOracleFee(),
    ]);

    let linkAddr = "(n/a)";
    try {
      linkAddr = (await aggregator.getContractConfig()).linkAddr;
    } catch {}

    console.log(`Address:             ${aggregator.target}`);
    console.log(`Owner:               ${aggOwner}`);
    console.log(`Oracles to Poll:     ${poll}`);
    console.log(`Required Responses:  ${resp}`);
    console.log(`Cluster Size:        ${cluster}`);
    console.log(`Response Timeout:    ${timeout} seconds`);
    console.log(`Max Oracle Fee:      ${ethers.formatEther(maxFee)} LINK`);
    console.log(`LINK Token:          ${linkAddr}`);
    console.log(`Aggregator Balance:  ${ethers.formatEther(aggBal)} ETH`);

    /* Recent events (last 1000 blocks) --------------------------------- */
    const head   = await provider.getBlockNumber();
    const recent = await aggregator.queryFilter("*", Math.max(0, head - 1000), head);
    console.log("\nRecent Aggregator Events:");
    if (!recent.length) console.log("(none)");
    recent.forEach((evt) => {
      console.log(`\nEvent: ${evt.event ?? "(anonymous)"}`);
      console.log("Args:", evt.args);
      console.log(`Block: ${evt.blockNumber}  Tx: ${evt.transactionHash}`);
    });

    /* Gas price --------------------------------------------------------- */
    const fee = await provider.getFeeData();          // ethers v6
    if (fee.gasPrice) {
      console.log(`\nCurrent Gas Price: ${ethers.formatUnits(fee.gasPrice, "gwei")} gwei`);
    } else {
      console.log("\nCurrent Gas Price: (not provided by RPC)");
    }

    console.log("\nMonitoring completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during monitoring:", err);
    process.exit(1);
  }
})();

