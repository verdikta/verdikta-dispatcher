#!/usr/bin/env node
/*
  scripts/monitor-contracts.js – Hardhat + ethers
  Show status of WrappedVerdiktaToken, ReputationKeeper and ReputationAggregator.

  Run, e.g.
    npx hardhat run scripts/monitor-contracts.js --network base_sepolia
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

/* --------------------------------------------------------- */
/* Helpers                                                   */
/* --------------------------------------------------------- */
function bytes32ToAscii(b32) {
  const hex = b32.startsWith("0x") ? b32.slice(2) : b32;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;            // stop at first padding 0x00
    out += String.fromCharCode(byte);
  }
  return out;
}

/* --------------------------------------------------------- */
/* Main                                                      */
/* --------------------------------------------------------- */
(async () => {
  try {
    console.log("Starting contract monitoring…\n");

    /* Provider & signer ------------------------------------ */
    const provider = ethers.provider;
    const [signer] = await ethers.getSigners();

    /* Deployment artifacts --------------------------------- */
    const keeperInfo     = await deployments.get("ReputationKeeper");
    const aggregatorInfo = await deployments.get("ReputationAggregator");

    /* WrappedVerdiktaToken deployment (or env) ------------- */
    let verdiktaAddr, verdiktaAbi;
    try {
      const t = await deployments.get("WrappedVerdiktaToken");
      verdiktaAddr = t.address;
      verdiktaAbi  = t.abi;
    } catch {
      verdiktaAddr = process.env.WRAPPED_VERDIKTA_TOKEN;
      if (!verdiktaAddr)
        throw new Error("Token not deployed and WRAPPED_VERDIKTA_TOKEN is missing");
      verdiktaAbi = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function totalSupply() view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
      ];
    }

    /* Contract instances ----------------------------------- */
    const verdikta   = new ethers.Contract(verdiktaAddr, verdiktaAbi, provider);
    const keeper     = new ethers.Contract(keeperInfo.address,     keeperInfo.abi,     provider);
    const aggregator = new ethers.Contract(aggregatorInfo.address, aggregatorInfo.abi, provider);

    /* Network ---------------------------------------------- */
    const net = await provider.getNetwork();
    console.log("=== Deployment Information ===");
    console.log(`Network: ${net.name ?? "unknown"} (ID: ${net.chainId})`);

    /* Token ------------------------------------------------- */
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

    /* Keeper ------------------------------------------------ */
    console.log("\n=== ReputationKeeper ===");
    const [kBal, kOwner] = await Promise.all([
      provider.getBalance(keeper.target ?? keeper.address),
      keeper.owner(),
    ]);
    console.log(`Address: ${keeper.target ?? keeper.address}`);
    console.log(`Owner:   ${kOwner}`);
    console.log(`Balance: ${ethers.formatEther(kBal)} ETH`);

    /* Registered oracles ----------------------------------- */
    console.log("\n=== Registered Oracles ===");
    const events = await keeper.queryFilter(
      keeper.filters.OracleRegistered(),
      0,
      "latest"
    );

    const seen = new Map();
    events.forEach((e) => {
      const { oracle, jobId } = e.args;
      seen.set(`${oracle}-${jobId}`, { oracle, jobId });
    });

    if (seen.size === 0) {
      console.log("No registered oracles.");
    } else {
      let active = 0;
      for (const { oracle, jobId } of seen.values()) {
        const info = await keeper.getOracleInfo(oracle, jobId);
        if (info.isActive) {
          console.log(`\nOracle: ${oracle}`);

          const asciiId = bytes32ToAscii(jobId);
          console.log(`JobID  (bytes32): ${jobId}`);
          console.log(`JobID  (ascii) : ${asciiId}`);

          console.log(`Scores:          ${info.qualityScore}/${info.timelinessScore}`);
          try {
            const classes = await keeper.getOracleClassesByKey(oracle, jobId);
            console.log(`Classes:         ${classes}`);
          } catch {}
          active++;
        }
      }
      if (active === 0) console.log("None of the registered oracles are active.");
    }

    /* Aggregator ------------------------------------------- */
    console.log("\n=== ReputationAggregator ===");
    const [
      aggBal,
      aggOwner,
      pollCommit,
      pollReveal,
      resp,
      cluster,
      timeout,
      maxFee,
    ] = await Promise.all([
      provider.getBalance(aggregator.target ?? aggregator.address),
      aggregator.owner(),
      aggregator.commitOraclesToPoll(),
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

    console.log(`Address:                  ${aggregator.target ?? aggregator.address}`);
    console.log(`Owner:                    ${aggOwner}`);
    console.log(`Oracles to Poll (commit): ${pollCommit}`);
    console.log(`Oracles to Poll (reveal): ${pollReveal}`);
    console.log(`Required Responses:       ${resp}`);
    console.log(`Cluster Size:             ${cluster}`);
    console.log(`Response Timeout:         ${timeout} seconds`);
    console.log(`Max Oracle Fee:           ${ethers.formatEther(maxFee)} LINK`);
    console.log(`LINK Token:               ${linkAddr}`);

    /* Recent events (last 1000 blocks) --------------------- */
    const head = await provider.getBlockNumber();
    const recent = await aggregator.queryFilter("*", Math.max(0, head - 1000), head);
    console.log("\nRecent Aggregator Events:");
    if (!recent.length) console.log("(none)");
    recent.forEach((evt) => {
      console.log(`\nEvent: ${evt.event ?? "(anonymous)"}`);
      console.log("Args:", evt.args);
      console.log(`Block: ${evt.blockNumber}  Tx: ${evt.transactionHash}`);
    });

    /* Gas price -------------------------------------------- */
    const fee = await provider.getFeeData();
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

