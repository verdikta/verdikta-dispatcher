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

/* ---------- helpers ---------- */
function normalizeAggId(s) {
  s = (s || "").trim();
  const m = s.match(/0x[0-9a-fA-F]{64}/) || s.match(/[0-9a-fA-F]{64}/);
  if (!m) throw new Error(`--aggid must be 0x + 64 hex; got: ${s}`);
  const hex = m[0].startsWith("0x") ? m[0] : "0x" + m[0];
  return hex.toLowerCase();
}

function lc(x) { return (x || "").toLowerCase(); }

(async () => {
  const argv = yargs(hideBin(process.argv))
    .option("aggregator", { type: "string", demandOption: true })
    .option("operator",   { type: "string", demandOption: true })
    .option("aggid",      { type: "string", demandOption: true })
    .option("fromaddrs",  { type: "string", default: "" }) // comma sep EOAs (optional)
    .option("lookahead",  { type: "number", default: 1200 }) // blocks
    .strict().argv;

  const provider = ethers.provider;
  const aggAbi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const agg = new ethers.Contract(argv.aggregator, aggAbi, provider);

  // Minimal Operator ABI (adjust if you run a custom Operator)
  const operatorAbi = [
    "event OracleRequest(bytes32 indexed specId, address indexed requester, bytes32 indexed requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
    "event OracleResponse(bytes32 indexed requestId)"
  ];
  const op = new ethers.Contract(argv.operator, operatorAbi, provider);

  const aggId = normalizeAggId(argv.aggid);
  const scanEOAs = argv.fromaddrs
    ? argv.fromaddrs.split(",").map(s => lc(s.trim())).filter(Boolean)
    : [];

  /* -------- 1) reveal dispatch & recorded responses -------- */
  const evRevealReq = agg.interface.getEvent("RevealRequestDispatched");
  const evRecorded  = agg.interface.getEvent("NewOracleResponseRecorded");
  const evCLF       = agg.interface.getEvent?.("ChainlinkFulfilled"); // may exist via ChainlinkClient

  // Use a reasonable backward window (tweak as needed)
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 50_000);
  const toBlock = "latest";

  // Raw logs retain blockNumber
  const dispLogsRaw = await provider.getLogs({
    address: agg.address,
    topics: [evRevealReq.topicHash, aggId],
    fromBlock, toBlock
  });
  const recLogsRaw  = await provider.getLogs({
    address: agg.address,
    topics: [evRecorded.topicHash],
    fromBlock, toBlock
  });

  // Parse “recorded” but filter to our aggId
  const ourRecorded = [];
  for (const l of recLogsRaw) {
    try {
      const parsed = agg.interface.parseLog(l);
      const parentAggId = (await agg.requestIdToAggregatorId(parsed.args.requestId)).toLowerCase();
      if (parentAggId === aggId) {
        ourRecorded.push({ parsed, blockNumber: l.blockNumber, txHash: l.transactionHash });
      }
    } catch {}
  }

  if (dispLogsRaw.length === 0) {
    console.log("No RevealRequestDispatched found for this aggId in recent blocks.");
    process.exit(0);
  }

  const dispatched = dispLogsRaw.map(l => ({
    parsed: agg.interface.parseLog(l),
    blockNumber: l.blockNumber,
    txHash: l.transactionHash
  }));

  const dispatchedSlots = new Set(dispatched.map(d => Number(d.parsed.args.pollIndex)));
  const recordedSlots   = new Set(ourRecorded.map(d => Number(d.parsed.args.pollIndex)));
  const missingSlots    = [...dispatchedSlots].filter(s => !recordedSlots.has(s));

  console.log("Dispatched slots:", [...dispatchedSlots].sort());
  console.log("Recorded slots  :", [...recordedSlots].sort());
  console.log("Missing slots   :", missingSlots);

  const firstDispBlock = Math.min(...dispatched.map(d => d.blockNumber));
  const lastDispBlock  = Math.max(...dispatched.map(d => d.blockNumber));

  /* -------- 2) map slots -> requestIds via Operator OracleRequest -------- */
  const opReqEv = op.interface.getEvent("OracleRequest");
  const opReqLogs = await provider.getLogs({
    address: op.address,
    topics: [opReqEv.topicHash, null, null, null],
    fromBlock: Math.max(0, firstDispBlock - 600),
    toBlock: lastDispBlock + argv.lookahead
  });

  const slotToReqId = new Map();
  for (const l of opReqLogs) {
    let parsed;
    try { parsed = op.interface.parseLog(l); } catch { continue; }
    const requester = lc(parsed.args.requester);
    if (requester !== lc(argv.aggregator)) continue;
    const reqId = parsed.args.requestId;
    const parentAggId = lc(await agg.requestIdToAggregatorId(reqId));
    if (parentAggId !== aggId) continue; // belongs to another aggregation
    const slot = Number(await agg.requestIdToPollIndex(reqId));
    slotToReqId.set(slot, reqId);
  }

  console.log("RequestIds (slot -> requestId):");
  [...slotToReqId.entries()].sort((a,b)=>a[0]-b[0]).forEach(([slot, r]) =>
    console.log(`  ${slot}: ${r}`)
  );

  /* -------- 3) check OperatorResponse or ChainlinkFulfilled -------- */
  let opResReqIds = new Set();
  try {
    const opResEv = op.interface.getEvent("OracleResponse");
    const opResLogs = await provider.getLogs({
      address: op.address,
      topics: [opResEv.topicHash],
      fromBlock: Math.max(0, firstDispBlock - 600),
      toBlock: lastDispBlock + argv.lookahead
    });
    opResReqIds = new Set(opResLogs.map(l => op.interface.parseLog(l).args.requestId.toLowerCase()));
  } catch {
    // OperatorResponse event not present; fall back to ChainlinkFulfilled on aggregator
    if (evCLF) {
      const clfLogs = await provider.getLogs({
        address: agg.address,
        topics: [evCLF.topicHash],
        fromBlock: Math.max(0, firstDispBlock - 600),
        toBlock: lastDispBlock + argv.lookahead
      });
      // We can’t get requestId from agg easily without parsing; skip—it’s only a fallback.
    }
  }

  for (const slot of missingSlots) {
    const reqId = lc(slotToReqId.get(slot) || "0x");
    if (reqId === "0x") {
      console.log(`Slot ${slot}: could not find requestId (try increasing --lookahead).`);
      continue;
    }
    const opResp = opResReqIds.has(reqId);
    console.log(`Slot ${slot}: requestId=${reqId}  OperatorResponse=${opResp ? "YES" : "NO"}`);
  }

  /* -------- 4) OPTIONAL: look for any mined txs to Operator carrying requestId -------- */
  const searchStart = Math.max(0, firstDispBlock - 50);
  const searchEnd   = lastDispBlock + argv.lookahead;

  async function findTxForRequestId(reqIdLower) {
    // Warning: block-by-block scan; keep window tight
    for (let b = searchStart; b <= searchEnd; b++) {
      const blk = await provider.getBlockWithTransactions(b);
      for (const tx of blk.transactions) {
        if (!tx.to) continue;
        if (lc(tx.to) !== lc(argv.operator)) continue;
        if (scanEOAs.length && !scanEOAs.includes(lc(tx.from))) continue;
        const data = lc(tx.data || "0x");
        if (data.includes(reqIdLower.slice(2))) {
          const rcpt = await provider.getTransactionReceipt(tx.hash);
          return { hash: tx.hash, from: tx.from, blockNumber: b, status: rcpt.status, nonce: tx.nonce };
        }
      }
    }
    return null;
  }

  for (const slot of missingSlots) {
    const reqId = lc(slotToReqId.get(slot) || "0x");
    if (reqId === "0x") continue;
    const tx = await findTxForRequestId(reqId);
    if (!tx) {
      console.log(`Slot ${slot}: no mined tx to Operator containing requestId (likely never mined / replaced).`);
    } else {
      console.log(`Slot ${slot}: found tx ${tx.hash} from ${tx.from} nonce=${tx.nonce} status=${tx.status} at block ${tx.blockNumber}`);
    }
  }
})();

