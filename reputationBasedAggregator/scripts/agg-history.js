#!/usr/bin/env node
/*  scripts/agg-history.js
Usage:
HARDHAT_NETWORK=base_sepolia \
node scripts/agg-history.js \
  --aggregator 0x2bF73a372CA04C30e9a689BAc4BfC976DfBEb504 \
  --aggid      0xe4bdcfa7195c2f67163f9d27c0728263e38b5b38d8f4b20a11047a243347b40c
    --------------------------------------------------
    Enhanced timeline with require() failure detection
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
  const maxLikelihoodLength = Number(await agg.maxLikelihoodLength());

  console.log(`Contract parameters: K=${K}, M=${M}, maxLikelihoodLength=${maxLikelihoodLength}`);

  /* event names we care about - ENHANCED with new failure events */
  const sigs = {
    CommitReceived:            "CommitReceived",
    RevealRequestDispatched:   "RevealRequestDispatched", 
    NewOracleResponseRecorded: "NewOracleResponseRecorded",
    RevealHashMismatch:        "RevealHashMismatch",
    InvalidRevealFormat:       "InvalidRevealFormat",
    RevealTooManyScores:       "RevealTooManyScores",       // NEW
    RevealWrongScoreCount:     "RevealWrongScoreCount",     // NEW  
    RevealTooFewScores:        "RevealTooFewScores",        // NEW
    EvaluationFailed:          "EvaluationFailed",
    FulfillAIEvaluation:       "FulfillAIEvaluation",
    OracleSelected:            "OracleSelected"
  };

  // Create topics object mapping event names to topic hashes
  const topics = {};
  for (const [alias, eventName] of Object.entries(sigs)) {
    const ev = agg.interface.getEvent(eventName);
    if (!ev) {
      console.log(`Warning: Event not found in ABI: ${eventName} - skipping`);
      continue;
    }
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
    console.log("No RequestAIEvaluation event found for this aggId in recent blocks");
    return; // Exit early
  }

  console.log(`Found RequestAIEvaluation event at block ${requestLogs[0].blockNumber}`);

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

  // Get all failure events - ENHANCED with new events
  const failureEventTopics = [];
  for (const eventKey of ['CommitReceived', 'RevealRequestDispatched', 'InvalidRevealFormat', 
                          'RevealHashMismatch', 'RevealTooManyScores', 'RevealWrongScoreCount', 
                          'RevealTooFewScores', 'EvaluationFailed', 'FulfillAIEvaluation']) {
    if (topics[eventKey]) {
      failureEventTopics.push(topics[eventKey]);
    }
  }

  const eventsFilter = {
    address: agg.target,
    topics: [
      failureEventTopics,
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

  /* build slot-wise tables - ENHANCED */
  const commits         = new Map();
  const revealReq       = new Map();
  const reveals         = new Map();
  const mismatches      = new Map();
  const badFormats      = new Map();
  const tooManyScores   = new Map(); // NEW
  const wrongScoreCount = new Map(); // NEW  
  const tooFewScores    = new Map(); // NEW

  const collect = log => {
    const idx = String(log.args.pollIndex);
    switch (log.name) {
      case "CommitReceived":           commits.set(idx, log);         break;
      case "RevealRequestDispatched":  revealReq.set(idx, log);       break;
      case "NewOracleResponseRecorded":reveals.set(idx, log);         break;
      case "RevealHashMismatch":       mismatches.set(idx, log);      break;
      case "InvalidRevealFormat":      badFormats.set(idx, log);      break;
      case "RevealTooManyScores":      tooManyScores.set(idx, log);   break; // NEW
      case "RevealWrongScoreCount":    wrongScoreCount.set(idx, log); break; // NEW
      case "RevealTooFewScores":       tooFewScores.set(idx, log);    break; // NEW
    }
  };
  indexedLogs.forEach(collect);
  ourResponseLogs.forEach(collect);

  /* header - ENHANCED */
  console.log("\n======================================================================");
  console.log("Aggregator :", argv.aggregator);
  console.log("aggId      :", aggId);
  console.log(`Poll for Commit = ${K}   Poll for Reveal = ${M}   maxScores = ${maxLikelihoodLength}`);
  console.log("------------------------------------------------------------------------------------------------------------------------------------------------------------");
  console.log(
    pad("slot",4), pad("oracle",42), pad("jobId",20),
    pad("commit",8), pad("revealReq",11), pad("revealOK",10), 
    pad("hashMis",8), pad("badFmt",7),
    pad("tooMany",8), pad("wrongCnt",9), pad("tooFew",7)  // NEW COLUMNS
  );

  /* per-slot lines - ENHANCED */
  for (let slot = 0; slot < K; ++slot) {
    const oracleInfo = oracles[slot];
    const oracle = oracleInfo ? oracleInfo.oracle : "not assigned";
    const jobId = oracleInfo ? oracleInfo.jobId : "unknown";
    const idx = String(slot);
    
    console.log(
      pad(slot,4),
      pad(oracle,42),
      pad(jobId,20),
      pad(commits.has(idx)         ? "yes" : "no",8),
      pad(revealReq.has(idx)       ? "yes" : "no",11),
      pad(reveals.has(idx)         ? "yes" : "no",10),
      pad(mismatches.has(idx)      ? "yes" : "no",8),
      pad(badFormats.has(idx)      ? "yes" : "no",7),
      pad(tooManyScores.has(idx)   ? "yes" : "no",8),  // NEW
      pad(wrongScoreCount.has(idx) ? "yes" : "no",9),  // NEW
      pad(tooFewScores.has(idx)    ? "yes" : "no",7)   // NEW
    );
  }

  /* outcome */
  const failed  = indexedLogs.find(l => l.name === "EvaluationFailed");
  const success = indexedLogs.find(l => l.name === "FulfillAIEvaluation");

  console.log("------------------------------------------------------------------------------------------------------------------------------------------------------------");
  if (success)  console.log("Outcome : COMPLETED");
  else if (failed) console.log(`Outcome : FAILED in ${failed.args.phase} phase`);
  else            console.log("Outcome : still running or timed-out");

  // Enhanced analysis section
  console.log("\nDetailed Analysis:");
  const commitCount = commits.size;
  const revealCount = reveals.size;
  console.log(`• ${commitCount}/${K} oracles committed, ${revealCount}/${K} revealed`);

  if (commitCount < M) {
    console.log(`• Waiting for ${M - commitCount} more commits to start reveal phase`);
  }

  // Show specific failure types
  if (tooManyScores.size > 0) {
    console.log(`• ${tooManyScores.size} reveals failed: TOO MANY SCORES (>${maxLikelihoodLength})`);
    tooManyScores.forEach((log, slot) => {
      const parsed = log;
      console.log(`  - Slot ${slot}: sent ${parsed.args?.responseLength || 'unknown'} scores, max allowed ${parsed.args?.maxAllowed || maxLikelihoodLength}`);
    });
  }

  if (wrongScoreCount.size > 0) {
    console.log(`• ${wrongScoreCount.size} reveals failed: WRONG SCORE COUNT`);
    wrongScoreCount.forEach((log, slot) => {
      const parsed = log;
      console.log(`  - Slot ${slot}: sent ${parsed.args?.responseLength || 'unknown'} scores, expected ${parsed.args?.expectedLength || 'unknown'}`);
    });
  }

  if (tooFewScores.size > 0) {
    console.log(`• ${tooFewScores.size} reveals failed: TOO FEW SCORES (<2)`);
    tooFewScores.forEach((log, slot) => {
      const parsed = log;
      console.log(`  - Slot ${slot}: sent ${parsed.args?.responseLength || 'unknown'} scores`);
    });
  }

  if (mismatches.size > 0) {
    console.log(`• ${mismatches.size} reveals failed: HASH MISMATCH`);
  }

  if (badFormats.size > 0) {
    console.log(`• ${badFormats.size} reveals failed: BAD CID FORMAT`);
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

