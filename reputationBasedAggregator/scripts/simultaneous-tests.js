#!/usr/bin/env node
// scripts/simultaneous-tests.js  — original output preserved
require("dotenv").config();
const hre    = require("hardhat");
const { ethers } = hre;
const pause  = ms => new Promise(r => setTimeout(r, ms));

/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   EDIT ONLY THESE CONSTANTS
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
const AGGREGATOR          = "0x2bF73a372CA04C30e9a689BAc4BfC976DfBEb504";
const LINK_TOKEN          = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";

const NUM_QUERIES         = 5;
const BETWEEN_QUERY_DELAY = 200;         // ms between tx submissions
const NUM_INCREMENTS      = 11;
const INCREMENT_DURATION  = 30_000;      // ms between polling rounds

const JOB_CLASS           = 128;
const MAX_ORACLE_FEE      = ethers.parseUnits("0.01", 18);
const ESTIMATE_BASE_FEE   = ethers.parseUnits("0.000001", 18);
const MAX_FEE_SCALING     = 5;
const ALPHA               = 500;

const CIDS     = ["QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH"];
const ADDENDUM = "";
const GAS_LIMIT = 3_000_000;
/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */

async function getSigner () {
  const [cfg] = await hre.ethers.getSigners();
  if (cfg) return cfg;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("No signer available");
  return new hre.ethers.Wallet(pk, hre.ethers.provider);
}

/* ------------------------------------------------------------------ */
/* Diagnostic helper – called only *after* the main loop for failures */
/* ------------------------------------------------------------------ */
async function diagnoseTimeout(agg, aggId) {
  const filter = {
    address: agg.target,
    topics: [
      [
        agg.interface.getEvent("CommitReceived").topicHash,
        agg.interface.getEvent("RevealRequestDispatched").topicHash,
        agg.interface.getEvent("NewOracleResponseRecorded").topicHash,
        agg.interface.getEvent("EvaluationFailed").topicHash
      ],
      aggId
    ],
    fromBlock: 0, toBlock: "latest"
  };
  const raw  = await hre.ethers.provider.getLogs(filter);
  const logs = raw.map(l => agg.interface.parseLog(l));

  const commits = new Map();   // slot -> operator
  const reveals = new Map();   // slot -> operator
  let revealReqCnt  = 0;       // how many RevealRequestDispatched
  let   hashMismatch  = 0;     // how many mismatches
  let   badFormat     = 0;     // how many bad formats
  const totalSlots = Number(await agg.commitOraclesToPoll());  // K
  const requiredRev = Number(await agg.oraclesToPoll());       // M
  const slots = new Map();     // tracks every pollIndex we see

  logs.forEach(l => {
    if (l.name === "CommitReceived") {
      commits.set(l.args.pollIndex.toString(), l.args.operator);
      slots.set (l.args.pollIndex.toString(), l.args.operator);
    }
    if (l.name === "NewOracleResponseRecorded") {
      reveals.set(l.args.pollIndex.toString(), l.args.operator);
      slots.set (l.args.pollIndex.toString(), l.args.operator);
    }
    if (l.name === "RevealRequestDispatched") revealReqCnt += 1;
    if (l.name === "RevealHashMismatch")      hashMismatch += 1;
    if (l.name === "InvalidRevealFormat")     badFormat    += 1;
  });

  const evFail = logs.find(l => l.name === "EvaluationFailed");
  const phase  = evFail ? evFail.args.phase : "timeout";

  const missingCommit = [];
  const missingReveal = [];
  for (const [slot, op] of slots) {
    if (!commits.has(slot))       missingCommit.push(op);
    else if (!reveals.has(slot) && !missingReveal.includes(op))
                                 missingReveal.push(op);
  }

  console.log("\n┌─ Diagnostic for", aggId, "──────────────");
  console.log(`│ Outcome: ${phase === "commit" ? "commit-phase timeout"
                : phase === "reveal" ? "reveal-phase timeout"
                : "timeout (undetermined)"}` );
  console.log(`│ Commits:  ${commits.size} / ${totalSlots}` );
  console.log(`│ Reveals requested: ${revealReqCnt}` );
  console.log(`│ Reveal hash mismatches: ${hashMismatch}` );
  console.log(`│ Invalid reveal formats: ${badFormat}`);
  console.log(`│ Reveals:  ${reveals.size} / ${requiredRev}` );
  if (missingCommit.length)
    console.log(`│ Missing commits from: ${missingCommit.join(" ")}`.padEnd(58) );
  if (missingReveal.length)
    console.log(`│ Missing reveals from: ${missingReveal.join(" ")}`.padEnd(58) );
  console.log("└" + "─".repeat(98) );
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */
(async () => {
  const signer = await getSigner();
  console.log("Using signer:", await signer.getAddress());
  console.log("RPC endpoint:", hre.network.config.url || "in-process Hardhat node");

  const aggAbi  = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const linkAbi = (await hre.artifacts.readArtifact("LinkTokenInterface")).abi;

  const agg  = new hre.ethers.Contract(AGGREGATOR, aggAbi, signer);
  const link = new hre.ethers.Contract(LINK_TOKEN,  linkAbi, signer);

  /* ––––– optional LINK allowance ––––– */
  if (process.env.LINK_ALLOWANCE) {
    const allowance = ethers.parseUnits(process.env.LINK_ALLOWANCE, 18);
    const tx = await link.approve(AGGREGATOR, allowance);
    console.log("approve() →", tx.hash);
    await tx.wait(1);
  }

  /* helper to submit a single query (unchanged output) */
  async function sendQuery(idx, nonce, delayMs) {
    if (delayMs) await pause(delayMs);

    /* dry-run */
    try {
      await agg.getFunction("requestAIEvaluationWithApproval").staticCall(
        CIDS, ADDENDUM, ALPHA,
        MAX_ORACLE_FEE, ESTIMATE_BASE_FEE, MAX_FEE_SCALING, JOB_CLASS
      );
    } catch (e) {
      console.error(`[${idx}] dry-run revert → ${e.shortMessage || e}`);
      return null;
    }

    /* on-chain tx */
    const tx = await agg.requestAIEvaluationWithApproval(
      CIDS, ADDENDUM, ALPHA,
      MAX_ORACLE_FEE, ESTIMATE_BASE_FEE, MAX_FEE_SCALING, JOB_CLASS,
      { nonce, gasLimit: GAS_LIMIT }
    );
    console.log(`[${idx}] tx sent →`, tx.hash);
    const rcpt = await tx.wait(1);

    const ev = rcpt.logs
      .map(l => { try { return agg.interface.parseLog(l); } catch { return null; } })
      .find(l => l && l.name === "RequestAIEvaluation");

    if (!ev) {
      console.log(`[${idx}] RequestAIEvaluation event not found`);
      return { aggId: null };
    }
    console.log(`[${idx}] aggId = ${ev.args.aggRequestId}`);
    return { aggId: ev.args.aggRequestId };
  }

  /* fire queries */
  const startNonce = await signer.getNonce();
  const aggIds     = [];
  for (let i = 0; i < NUM_QUERIES; i++) {
    const res = await sendQuery(i + 1, startNonce + i, i ? BETWEEN_QUERY_DELAY : 0);
    if (res && res.aggId) aggIds.push(res.aggId);
  }

  /* polling loop */
  const completed = new Set();
  const failed    = new Set();
  const errored   = new Set();

  console.log(`\nChecking for results every ${INCREMENT_DURATION/1000} seconds...`);
  for (let round = 0; round < NUM_INCREMENTS; round++) {
    await pause(INCREMENT_DURATION);
    console.log(`\nStatus check ${round + 1}:`);

    for (const id of aggIds) {
      if (completed.has(id) || failed.has(id) || errored.has(id)) continue;

      try {
        console.log(`  Checking ${id}...`);
        const [scores, cids, has] = await agg.getEvaluation(id);
        console.log(`    hasResponses: ${has}, likelihoods.length: ${scores.length}`);
        console.log(`    likelihoods: [${scores.map(x => x.toString()).join(", ")}]`);
        console.log(`    justifications: "${cids}"`);

        if (has && scores.length) {
          const allZero = scores.every(x => x === 0n);
          const empty   = !cids.trim();
          if (allZero || empty) {
            console.log(`ERROR: ${id} - Invalid data`);
            errored.add(id);
          } else {
            console.log(`SUCCESS: ${id}`);
            completed.add(id);
          }
        } else {
          const isFail = await agg.isFailed(id);
          console.log(`    failed: ${isFail}`);
          if (isFail) {
            console.log(`FAILED: ${id}`);
            failed.add(id);                          // diagnostics later
          } else {
            console.log(`    Still pending: ${id}`);
          }
        }
      } catch (e) {
        console.log(`    Error checking ${id}: ${e.message}`);
        errored.add(id);
      }
    }

    console.log(`Completed: ${completed.size}, Failed: ${failed.size}, Error: ${errored.size}, Pending: ${aggIds.length - completed.size - failed.size - errored.size}`);

    if (completed.size + failed.size + errored.size === aggIds.length) break;
  }

  /* final summary (identical format) */
  console.log(`\nFinal Results:`);
  console.log(`Completed: ${completed.size}`);
  console.log(`Failed: ${failed.size}`);
  console.log(`Error: ${errored.size}`);
  console.log(`Timed out: ${aggIds.length - completed.size - failed.size - errored.size}`);

  console.log(`\nDetailed Breakdown:`);
  aggIds.forEach((id, i) => {
    if (completed.has(id))      console.log(`[${i+1}] SUCCESS: ${id}`);
    else if (failed.has(id))    console.log(`[${i+1}] FAILED: ${id}`);
    else if (errored.has(id))   console.log(`[${i+1}] ERROR: ${id}`);
    else                        console.log(`[${i+1}] TIMEOUT: ${id}`);
  });

  /* NEW: diagnostics printed only for failed or timed-out runs */
  for (const id of aggIds) {
    if (failed.has(id) || (!completed.has(id) && !errored.has(id)))
      await diagnoseTimeout(agg, id);
  }

  agg.removeAllListeners();
})().catch(err => { console.error(err); process.exitCode = 1; });

