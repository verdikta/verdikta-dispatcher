#!/usr/bin/env node
/*  scripts/agg-history.js
Usage:
HARDHAT_NETWORK=base_sepolia \
node scripts/agg-history.js \
  --aggregator 0x2bF73a372CA04C30e9a689BAc4BfC976DfBEb504 \
  --aggid      0xe4bdcfa7195c2f67163f9d27c0728263e38b5b38d8f4b20a11047a243347b40c
    --------------------------------------------------
    Full timeline for ONE ReputationAggregator request
    -------------------------------------------------- */
require("dotenv").config();
const hre        = require("hardhat");
const { ethers } = hre;
const yargs      = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ────── helper ──────────────────────────────────── */
const pad = (v, n) => String(v).padEnd(n);

(async () => {
  /* command-line args */
  const argv = yargs(hideBin(process.argv))
      .option("aggregator", { alias:"a", type:"string", demandOption:true,
                              desc:"Aggregator contract address" })
      .option("aggid",      { alias:"i", type:"string", demandOption:true,
                              desc:"Aggregator-level request ID (bytes32)" })
      .strict().argv;

  const provider = ethers.provider;
  const aggAbi   = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const agg      = new ethers.Contract(argv.aggregator, aggAbi, provider);

  const aggId = argv.aggid.toLowerCase();

  console.log("Searching for aggId:", aggId);

  /* basic parameters */
  const K = Number(await agg.commitOraclesToPoll());
  const M = Number(await agg.oraclesToPoll());

  console.log(`Contract parameters: K=${K}, M=${M}`);

  /* event names we care about */
  const sigs = {
    CommitReceived:            "CommitReceived",
    RevealRequestDispatched:   "RevealRequestDispatched",
    NewOracleResponseRecorded: "NewOracleResponseRecorded",
    RevealHashMismatch:        "RevealHashMismatch",
    InvalidRevealFormat:       "InvalidRevealFormat",
    EvaluationFailed:          "EvaluationFailed",
    FulfillAIEvaluation:       "FulfillAIEvaluation",
    OracleSelected:            "OracleSelected"
  };

  // Create a proper topics object mapping event names to topic hashes
  const topics = {};
  for (const [alias, eventName] of Object.entries(sigs)) {
    const ev = agg.interface.getEvent(eventName);
    if (!ev) throw new Error(`Event not found in ABI: ${eventName}`);
    topics[alias] = ev.topicHash;
  }

  /* fetch polled oracles from events - use recent blocks only to avoid timeout */
  const oracles = new Array(K).fill(null); // Pre-allocate array with K slots

  // Get current block and search recent history (last 10000 blocks)
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 10000);

  console.log(`Searching blocks ${fromBlock} to ${currentBlock} for aggId: ${aggId}`);

  // First, look for the specific RequestAIEvaluation event for our aggId
  const requestFilter = {
    address: agg.target,
    topics: [
      agg.interface.getEvent("RequestAIEvaluation").topicHash,
      aggId  // indexed parameter
    ],
    fromBlock: fromBlock,
    toBlock: "latest"
  };

  console.log("Looking for RequestAIEvaluation event...");
  const requestLogs = await provider.getLogs(requestFilter);

  if (requestLogs.length === 0) {
    console.log("❌ No RequestAIEvaluation event found for this aggId in recent blocks");
    console.log("This could mean:");
    console.log("  1. The aggId is incorrect");
    console.log("  2. The request is older than 10000 blocks");
    console.log("  3. The request hasn't been made yet");

    // Try to find recent requests to help debug
    const anyRequestFilter = {
      address: agg.target,
      topics: [agg.interface.getEvent("RequestAIEvaluation").topicHash],
      fromBlock: fromBlock,
      toBlock: "latest"
    };

    const anyRequests = await provider.getLogs(anyRequestFilter);
    console.log(`\nFound ${anyRequests.length} RequestAIEvaluation events in recent blocks:`);

    for (let i = Math.max(0, anyRequests.length - 5); i < anyRequests.length; i++) {
      const parsed = agg.interface.parseLog(anyRequests[i]);
      console.log(`  Block ${anyRequests[i].blockNumber}: ${parsed.args.aggRequestId}`);
    }

    return; // Exit early
  }

  console.log(`✅ Found RequestAIEvaluation event at block ${requestLogs[0].blockNumber}`);

  // Check aggregation status
  try {
    const aggData = await agg.aggregatedEvaluations(aggId);
    console.log("Aggregation status:", {
      isComplete: aggData.isComplete,
      failed: aggData.failed,
      commitPhaseComplete: aggData.commitPhaseComplete,
      commitExpected: Number(aggData.commitExpected),
      commitReceived: Number(aggData.commitReceived),
      responseCount: Number(aggData.responseCount)
    });
  } catch (e) {
    console.log("Error checking aggregation:", e.message);
  }

  // Get oracle assignments from OracleSelected events
  console.log("Fetching oracle assignments from OracleSelected events...");
  
  const oracleSelectedFilter = {
    address: agg.target,
    topics: [
      topics.OracleSelected,
      aggId  // indexed aggRequestId
    ],
    fromBlock: fromBlock,
    toBlock: "latest"
  };
  
  const oracleSelectedLogs = await provider.getLogs(oracleSelectedFilter);
  console.log(`Found ${oracleSelectedLogs.length} OracleSelected events`);
  
  // Parse OracleSelected events to get all oracle assignments
  for (const log of oracleSelectedLogs) {
    try {
      const parsed = agg.interface.parseLog(log);
      const slot = Number(parsed.args.pollIndex);
      const oracle = parsed.args.oracle;
      const jobId = parsed.args.jobId;
      
      console.log(`OracleSelected slot=${slot} oracle=${oracle} jobId=${jobId.toString().slice(0,10)}...`);
      
      if (slot < K) {
        oracles[slot] = { 
          oracle, 
          jobId: jobId.toString().length > 20 ? jobId.toString().slice(0,20) + "..." : jobId.toString()
        };
      }
    } catch (e) {
      console.log("Failed to parse OracleSelected event:", e.message);
    }
  }

  // Now get all events related to this aggregation
  const eventsFilter = {
    address: agg.target,
    topics: [
      [
        topics.CommitReceived,
        topics.RevealRequestDispatched,
        topics.InvalidRevealFormat,
        topics.RevealHashMismatch,
        topics.EvaluationFailed,
        topics.FulfillAIEvaluation
      ],
      aggId  // indexed parameter where applicable
    ],
    fromBlock: fromBlock,
    toBlock: "latest"
  };

  console.log("Fetching related events...");
  const eventLogs = await provider.getLogs(eventsFilter);

  // Parse events and extract oracle info
  let matchingLogs = 0;
  for (const log of eventLogs) {
    try {
      const parsed = agg.interface.parseLog(log);
      matchingLogs++;

      if (parsed.args.pollIndex !== undefined && parsed.args.operator) {
        const slot = Number(parsed.args.pollIndex);
        const operator = parsed.args.operator;

        console.log(`Found event: ${parsed.name} slot=${slot} operator=${operator}`);

        // Only update oracle address if we don't have it from OracleSelected (backup)
        if (slot < K && !oracles[slot]) {
          oracles[slot] = { oracle: operator, jobId: "unknown" };
        }
      }
    } catch (e) {
      console.log("Failed to parse log:", e.message);
    }
  }

  // Also fetch NewOracleResponseRecorded events separately (different indexing)
  const responseFilter = {
    address: agg.target,
    topics: [topics.NewOracleResponseRecorded],
    fromBlock: fromBlock,
    toBlock: "latest"
  };

  const allResponseLogs = await provider.getLogs(responseFilter);
  console.log(`Found ${allResponseLogs.length} NewOracleResponseRecorded events`);

  // Filter for our aggId
  const ourResponseLogs = [];
  for (const log of allResponseLogs) {
    try {
      const parsed = agg.interface.parseLog(log);
      const parentAggId = await agg.requestIdToAggregatorId(parsed.args.requestId);
      if (parentAggId.toLowerCase() === aggId) {
        ourResponseLogs.push(parsed);
        matchingLogs++;

        const slot = Number(parsed.args.pollIndex);
        const operator = parsed.args.operator;
        console.log(`Found response: slot=${slot} operator=${operator}`);

        // Don't overwrite oracle assignments from OracleSelected events
        if (slot < K && !oracles[slot]) {
          oracles[slot] = { oracle: operator, jobId: "unknown" };
        }
      }
    } catch (e) {
      continue;
    }
  }

  console.log(`Total matching events for aggId: ${matchingLogs}`);

  // Summary of oracles found
  const foundOracles = oracles.filter(o => o !== null).length;
  console.log(`Found oracle info for ${foundOracles}/${K} slots`);

  /* ▸ logs that already index aggId */
  const indexedLogs = eventLogs.map(l => agg.interface.parseLog(l));

  /* build slot-wise tables */
  const commits    = new Map();
  const revealReq  = new Map();
  const reveals    = new Map();
  const mismatches = new Map();
  const badFormats = new Map();

  const collect = log => {
    const idx = String(log.args.pollIndex);
    switch (log.name) {
      case "CommitReceived":           commits.set(idx, log);    break;
      case "RevealRequestDispatched":  revealReq.set(idx, log);  break;
      case "NewOracleResponseRecorded":reveals.set(idx, log);    break;
      case "RevealHashMismatch":       mismatches.set(idx, log); break;
      case "InvalidRevealFormat":      badFormats.set(idx, log); break;
    }
  };
  indexedLogs.forEach(collect);
  ourResponseLogs.forEach(collect);

  /* header */
  console.log("\n======================================================================");
  console.log("Aggregator :", argv.aggregator);
  console.log("aggId      :", aggId);
  console.log(`K = ${K}   M = ${M}`);
  console.log("----------------------------------------------------------------------");
  console.log(
    pad("slot",4), pad("oracle",42), pad("jobId",66),
    pad("commit",8), pad("revealReq",11),
    pad("revealOK",10), pad("hashMis",8), pad("badFmt",7)
  );

  /* per-slot lines */
  for (let slot = 0; slot < K; ++slot) {
    const oracleInfo = oracles[slot];
    const oracle = oracleInfo ? oracleInfo.oracle : "not assigned";
    const jobId = oracleInfo ? oracleInfo.jobId : "unknown";
    const idx = String(slot);
    console.log(
      pad(slot,4),
      pad(oracle,42),
      pad(jobId,66),
      pad(commits.has(idx)    ? "yes" : "no",8),
      pad(revealReq.has(idx)  ? "yes" : "no",11),
      pad(reveals.has(idx)    ? "yes" : "no",10),
      pad(mismatches.has(idx) ? "yes" : "no",8),
      pad(badFormats.has(idx) ? "yes" : "no",7)
    );
  }

  /* outcome */
  const failed  = indexedLogs.find(l => l.name === "EvaluationFailed");
  const success = indexedLogs.find(l => l.name === "FulfillAIEvaluation");

  console.log("----------------------------------------------------------------------");
  if (success)  console.log("Outcome : COMPLETED");
  else if (failed) console.log(`Outcome : FAILED in ${failed.args.phase} phase`);
  else            console.log("Outcome : still running or timed-out");
  
  // Add analysis section
  console.log("\n🔍 Analysis:");
  const commitCount = commits.size;
  const revealCount = reveals.size;
  console.log(`• ${commitCount}/${K} oracles committed, ${revealCount}/${K} revealed`);
  
  if (commitCount < M) {
    console.log(`• Waiting for ${M - commitCount} more commits to start reveal phase`);
  }
  
  // Show responding vs non-responding slots
  const respondingSlots = Array.from({length: K}, (_, i) => i).filter(i => commits.has(String(i)));
  const nonRespondingSlots = Array.from({length: K}, (_, i) => i).filter(i => !commits.has(String(i)));
  
  console.log(`• Responding slots (committed): [${respondingSlots.join(', ')}]`);
  if (nonRespondingSlots.length > 0) {
    console.log(`• Non-responding slots: [${nonRespondingSlots.join(', ')}]`);
  }
  
  // Show unique responding oracles
  const uniqueOracles = new Set(oracles.filter(o => o !== null).map(o => o.oracle));
  console.log(`• Unique oracle addresses assigned: ${uniqueOracles.size}`);
  uniqueOracles.forEach(addr => console.log(`  - ${addr}`));
  
  console.log("======================================================================\n");
})();

