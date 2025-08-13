#!/usr/bin/env node

/*
HARDHAT_NETWORK=base_sepolia \
node scripts/reveal-forensics.js \
  --aggregator 0x6a26f45D5BbFC3AEEd8De9bd2B8285b96554bC47 \
  --operator   0x00A08b75178de0e0d7FF13Fdd4ef925AC3572503 \
  --aggid      0x064e3289be2ffdda5257a7df59aab4b7e417bdb4f047d8ba0b3050091fd20857 \
  --fromaddrs  0xF02E746A8f40EAAf7dCB0a3a9B31B0ba23e0387c,0x21ADE4d3baE4dF7df710b3B37F319C02f6775060
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const operatorAbi = [
  // v0.8 Operator events
  "event OracleRequest(bytes32 indexed specId, address indexed requester, bytes32 indexed requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
  // If your Operator ABI/event name differs, add alternatives here:
  "event OracleResponse(bytes32 indexed requestId)"
];

(async () => {
  const argv = yargs(hideBin(process.argv))
    .option("aggregator", { type: "string", demandOption: true })
    .option("operator",   { type: "string", demandOption: true })
    .option("aggid",      { type: "string", demandOption: true })
    .option("fromaddrs",  { type: "string", default: "" }) // comma-separated EOAs to scan
    .option("lookahead",  { type: "number", default: 1200 }) // ~few mins of blocks
    .strict().argv;

  const provider = ethers.provider;

  const aggAbi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const agg = new ethers.Contract(argv.aggregator, aggAbi, provider);
  const op  = new ethers.Contract(argv.operator,   operatorAbi, provider);

  const aggId = argv.aggid.toLowerCase();
  const scanEOAs = argv.fromaddrs
      ? argv.fromaddrs.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];

  // 1) Find reveal dispatch + recorded responses to get slots and a block window
  const dispEv = agg.interface.getEvent("RevealRequestDispatched");
  const recEv  = agg.interface.getEvent("NewOracleResponseRecorded");

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 50_000); // adjust if needed

  const dispLogs = await provider.getLogs({
    address: agg.address,
    topics: [dispEv.topicHash, aggId],
    fromBlock, toBlock: "latest"
  });
  const recLogs = await provider.getLogs({
    address: agg.address,
    topics: [recEv.topicHash],
    fromBlock, toBlock: "latest"
  });

  // Parse only those NewOracleResponseRecorded that belong to this aggId
  const ourRecorded = [];
  for (const l of recLogs) {
    try {
      const parsed = agg.interface.parseLog(l);
      const parentAggId = await agg.requestIdToAggregatorId(parsed.args.requestId);
      if (parentAggId.toLowerCase() === aggId) ourRecorded.push(parsed);
    } catch {}
  }

  const dispatched = dispLogs.map(l => agg.interface.parseLog(l));
  if (dispatched.length === 0) {
    console.log("No RevealRequestDispatched found for this aggId in recent blocks.");
    process.exit(0);
  }

  const firstDispBlock = Math.min(...dispatched.map(d => d.blockNumber));
  const lastDispBlock  = Math.max(...dispatched.map(d => d.blockNumber));

  // Slots that were asked to reveal:
  const dispatchedSlots = new Set(dispatched.map(d => Number(d.args.pollIndex)));
  // Slots that actually recorded a reveal:
  const recordedSlots   = new Set(ourRecorded.map(d => Number(d.args.pollIndex)));

  const missingSlots = [...dispatchedSlots].filter(s => !recordedSlots.has(s));
  console.log("Dispatched slots:", [...dispatchedSlots].sort());
  console.log("Recorded slots  :", [...recordedSlots].sort());
  console.log("Missing slots   :", missingSlots);

  // 2) Find the requestIds for *all* requests issued by this aggId near the dispatch blocks
  //    by scanning Operator. We'll then map requestId -> pollIndex using aggregator mappings.
  const opReqEv = op.interface.getEvent("OracleRequest");
  const opResEv = op.interface.getEvent("OracleResponse");

  const opReqLogs = await provider.getLogs({
    address: op.address,
    topics: [opReqEv.topicHash, null, null, null], // we'll filter requester below
    fromBlock: Math.max(0, firstDispBlock - 600),
    toBlock: lastDispBlock + argv.lookahead
  });

  const revealReqPerSlot = new Map(); // slot -> requestId
  const allReqIdsForAgg  = [];

  for (const l of opReqLogs) {
    const parsed = op.interface.parseLog(l);
    const requester = parsed.args.requester.toLowerCase();
    if (requester !== argv.aggregator.toLowerCase()) continue;

    const reqId = parsed.args.requestId;
    // Filter only requests that belong to our aggId
    const parentAggId = (await agg.requestIdToAggregatorId(reqId)).toLowerCase();
    if (parentAggId !== aggId) continue;

    const slot = Number(await agg.requestIdToPollIndex(reqId));
    revealReqPerSlot.set(slot, reqId);
    allReqIdsForAgg.push(reqId);
  }

  console.log("RequestIds discovered (slot -> requestId):");
  [...revealReqPerSlot.entries()]
    .sort((a,b)=>a[0]-b[0])
    .forEach(([slot, id]) => console.log(`  ${slot}: ${id}`));

  // 3) For each missing slot, verify no successful Operator response
  const opResLogs = await provider.getLogs({
    address: op.address,
    topics: [opResEv.topicHash],
    fromBlock: Math.max(0, firstDispBlock - 600),
    toBlock: lastDispBlock + argv.lookahead
  });

  const opRespondedReqIds = new Set(
    opResLogs.map(l => op.interface.parseLog(l).args.requestId.toLowerCase())
  );

  for (const slot of missingSlots) {
    const reqId = (revealReqPerSlot.get(slot) || "0x").toLowerCase();
    if (reqId === "0x") {
      console.log(`Slot ${slot}: could not find requestId (check wider block window).`);
      continue;
    }
    const ok = opRespondedReqIds.has(reqId);
    console.log(`Slot ${slot}: requestId=${reqId}  OperatorResponse=${ok ? "YES" : "NO"}`);
  }

  // 4) Optional: try to find any *mined* tx attempts from the EOA keys to the Operator
  //    that contain the missing requestIds in calldata. If none, it likely never mined.
  const searchStart = Math.max(0, firstDispBlock - 50);
  const searchEnd   = lastDispBlock + argv.lookahead;

  async function findTxForRequestId(reqIdLower) {
    for (let b = searchStart; b <= searchEnd; b++) {
      const blk = await provider.getBlockWithTransactions(b);
      for (const tx of blk.transactions) {
        if (!tx.to) continue;
        if (tx.to.toLowerCase() !== argv.operator.toLowerCase()) continue;
        if (scanEOAs.length && !scanEOAs.includes(tx.from.toLowerCase())) continue;
        const data = (tx.data || "0x").toLowerCase();
        if (data.includes(reqIdLower.slice(2))) {
          const rcpt = await provider.getTransactionReceipt(tx.hash);
          return { hash: tx.hash, from: tx.from, blockNumber: b, status: rcpt.status, nonce: tx.nonce };
        }
      }
    }
    return null;
  }

  for (const slot of missingSlots) {
    const reqId = (revealReqPerSlot.get(slot) || "0x").toLowerCase();
    if (reqId === "0x") continue;
    const tx = await findTxForRequestId(reqId);
    if (!tx) {
      console.log(`Slot ${slot}: no mined tx to Operator containing requestId (likely never mined / replaced).`);
    } else {
      console.log(`Slot ${slot}: found tx ${tx.hash} from ${tx.from} nonce=${tx.nonce} status=${tx.status} at block ${tx.blockNumber}`);
      if (tx.status === 0) {
        // Optional: try to recover revert reason
        try {
          const t = await provider.getTransaction(tx.hash);
          const reason = await provider.call({ to: t.to, from: t.from, data: t.data }, tx.blockNumber);
          console.log(`  Revert reason (decoded call): ${reason}`);
        } catch (e) {
          console.log(`  Could not decode revert reason: ${e.message}`);
        }
      }
    }
  }
})();

