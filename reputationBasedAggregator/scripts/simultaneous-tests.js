// scripts/runSixQueries.js
require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = require("ethers");
/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   EDIT ONLY THESE CONSTANTS
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
const AGGREGATOR = "0x3637DD9C5aF249D713645209A30FFbC56D3Cd0a1";
const LINK_TOKEN = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
const NUM_QUERIES          = 6;
const JOB_CLASS            = 128;
const MAX_ORACLE_FEE       = ethers.parseUnits("0.06", 18);
const ESTIMATED_BASE_FEE   = ethers.parseUnits("0.000001", 18);
const MAX_FEE_SCALING      = 10;
const ALPHA                = 500;
const CIDS      = [
  "QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS"
];
const ADDENDUM  = "";                     // optional
/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
async function getSigner() {
  // 1) try the accounts from hardhat.config.js
  const cfgSigners = await hre.ethers.getSigners();  // Use hre.ethers instead of ethers
  if (cfgSigners.length) return cfgSigners[0];
  // 2) fall back to PRIVATE_KEY + network provider
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("No signer: add accounts to hardhat.config.js or set PRIVATE_KEY");
  return new hre.ethers.Wallet(pk, hre.ethers.provider);  // Use hre.ethers here too
}
async function main () {
  const signer = await getSigner();
  console.log("Using signer:", await signer.getAddress());
  console.log("RPC endpoint:", hre.network.config.url || "in-process Hardhat node");
  const aggAbi  = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const linkAbi = (await hre.artifacts.readArtifact("LinkTokenInterface")).abi;
  const agg  = new hre.ethers.Contract(AGGREGATOR, aggAbi, signer);
  const link = new hre.ethers.Contract(LINK_TOKEN, linkAbi,  signer);
  /* ---- optional LINK approval (set allowance in .env) ---- */
  if (process.env.LINK_ALLOWANCE) {
    const allowance = ethers.parseUnits(process.env.LINK_ALLOWANCE, 18);
    const tx = await link.approve(AGGREGATOR, allowance);
    console.log("approve() →", tx.hash);
    await tx.wait(1);
  }
  /* ---- helper to send one query ---- */
async function sendQuery(idx, nonce) {
  const tx = await agg.requestAIEvaluationWithApproval(
    CIDS,
    ADDENDUM,
    ALPHA,
    MAX_ORACLE_FEE,
    ESTIMATED_BASE_FEE,
    MAX_FEE_SCALING,
    JOB_CLASS,
    {
      nonce: nonce,
    }
  );
  console.log(`[${idx}] tx sent →`, tx.hash);
  const rcpt = await tx.wait(1);
  // Parse logs to find the event (ethers v6 way)
  const parsedLogs = rcpt.logs.map(log => {
    try {
      return agg.interface.parseLog(log);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const ev = parsedLogs.find(log => log.name === "RequestAIEvaluation");
  if (ev) {
    console.log(`[${idx}] aggId = ${ev.args.aggRequestId}`);
    return { receipt: rcpt, aggId: ev.args.aggRequestId };
  } else {
    console.log(`[${idx}] RequestAIEvaluation event not found`);
    return { receipt: rcpt, aggId: null };
  }
}
  /* ---- fire queries in parallel ---- */
  const startNonce = await signer.getNonce();
  console.log(`Starting nonce: ${startNonce}`);
  const results = await Promise.all(Array.from({ length: NUM_QUERIES }, (_, i) =>
    sendQuery(i + 1, startNonce + i)
  ));

  // Extract aggIds from the results
  const aggIds = results
    .filter(result => result.aggId)
    .map(result => result.aggId);

  console.log(`\nCollected ${aggIds.length} aggIds:`);
  aggIds.forEach((id, i) => console.log(`[${i+1}] ${id}`));

  // Simple polling to check results
  console.log("\nChecking for results every 30 seconds...");
  const completedEvaluations = new Set();
  const failedEvaluations = new Set();
  const errorEvaluations = new Set();

  for (let check = 0; check < 10; check++) { // Check for 5 minutes
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log(`\nStatus check ${check + 1}:`);

    for (const aggId of aggIds) {
      if (!completedEvaluations.has(aggId) && !failedEvaluations.has(aggId) && !errorEvaluations.has(aggId)) {
        try {
          console.log(`  Checking ${aggId}...`);
          const [likelihoods, justifications, hasResponses] = await agg.getEvaluation(aggId);
          console.log(`    hasResponses: ${hasResponses}, likelihoods.length: ${likelihoods.length}`);

          if (hasResponses && likelihoods.length > 0) {
            // Check for error conditions: all zeros or empty CIDs
            const allZeros = likelihoods.every(score => score.toString() === '0');
            const emptyCIDs = !justifications || justifications.trim() === '';
            
            if (allZeros || emptyCIDs) {
              console.log(`ERROR: ${aggId} - Invalid data (all zeros: ${allZeros}, empty CIDs: ${emptyCIDs})`);
              console.log(`Scores: [${likelihoods.map(x => x.toString()).join(', ')}]`);
              console.log(`CIDs: "${justifications}"`);
              errorEvaluations.add(aggId);
            } else {
              console.log(`SUCCESS: ${aggId}`);
              console.log(`Scores: [${likelihoods.map(x => x.toString()).join(', ')}]`);
              console.log(`CIDs: ${justifications}`);
              completedEvaluations.add(aggId);
            }
          } else {
            // Check if failed
            const failed = await agg.isFailed(aggId);
            console.log(`    failed: ${failed}`);
            if (failed) {
              console.log(`FAILED: ${aggId}`);
              failedEvaluations.add(aggId);
            } else {
              console.log(`    Still pending: ${aggId}`);
            }
          }
        } catch (error) {
          console.log(`    Error checking ${aggId}: ${error.message}`);
        }
      }
    }

    console.log(`Completed: ${completedEvaluations.size}, Failed: ${failedEvaluations.size}, Error: ${errorEvaluations.size}, Pending: ${aggIds.length - completedEvaluations.size - failedEvaluations.size - errorEvaluations.size}`);

    // Stop if all are done
    if (completedEvaluations.size + failedEvaluations.size + errorEvaluations.size >= aggIds.length) {
      console.log("All evaluations processed!");
      break;
    }
  }

  console.log(`\nFinal Results:`);
  console.log(`Completed: ${completedEvaluations.size}`);
  console.log(`Failed: ${failedEvaluations.size}`);
  console.log(`Error: ${errorEvaluations.size}`);
  console.log(`Timed out: ${aggIds.length - completedEvaluations.size - failedEvaluations.size - errorEvaluations.size}`);

  console.log(`\nDetailed Breakdown:`);
  aggIds.forEach((aggId, i) => {
    if (completedEvaluations.has(aggId)) {
      console.log(`[${i+1}] SUCCESS: ${aggId}`);
    } else if (failedEvaluations.has(aggId)) {
      console.log(`[${i+1}] FAILED: ${aggId}`);
    } else if (errorEvaluations.has(aggId)) {
      console.log(`[${i+1}] ERROR: ${aggId}`);
    } else {
      console.log(`[${i+1}] TIMEOUT: ${aggId}`);
    }
  });
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

