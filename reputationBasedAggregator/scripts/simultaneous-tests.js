#!/usr/bin/env node
// scripts/simultaneous-tests.js  — original output preserved
require("dotenv").config();
const hre    = require("hardhat");
const { ethers } = hre;
const pause  = ms => new Promise(r => setTimeout(r, ms));
const IS_BASE = hre.network.name === "base";

/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   EDIT ONLY THESE CONSTANTS
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
const AGGREGATOR = IS_BASE
  ? "0xb10f6D7fD908311BfEa947881a835Df828f7bBE1"
  : "0x6a26f45D5BbFC3AEEd8De9bd2B8285b96554bC47";

const LINK_TOKEN = IS_BASE
  ? "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196"
  : "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";

const NUM_QUERIES         = 2;
const BETWEEN_QUERY_DELAY = 200;         // ms between tx submissions
const NUM_INCREMENTS      = 12;
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
  let hashMismatch  = 0;       // how many mismatches
  let badFormat     = 0;       // how many bad formats
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

  console.log("\n┌─ Diagnostic for aggId", aggId, "────────");
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

  /* --- QUICK SANITY CHECKS ------------------------------------------------- */
  const me = await signer.getAddress();

  // Introspect the LINK token you configured
  let tName = "?", tSymbol = "?", tDec = "?";
  try {
    const dec = link.decimals ? await link.decimals() : 18;
    [tName, tSymbol, tDec] = await Promise.all([link.name(), link.symbol(), Promise.resolve(dec)]);
  } catch (e) {
    console.error("LINK introspection failed (is LINK_TOKEN correct for this network?)", e.message);
  }
  console.log("LINK token:", LINK_TOKEN, `(${tName} / ${tSymbol} / ${tDec} decimals)`);

  // Compare Aggregator’s configured LINK address (if exposed) with LINK_TOKEN
  let aggLinkAddr = null;
  try {
    const cfg = await agg.getContractConfig?.();
    aggLinkAddr = cfg?.linkAddr ?? null;
  } catch {}
  try {
    if (!aggLinkAddr && agg.linkToken) aggLinkAddr = await agg.linkToken();
  } catch {}
  if (aggLinkAddr) {
    console.log("Aggregator.linkAddr:", aggLinkAddr);
    if (aggLinkAddr.toLowerCase() !== LINK_TOKEN.toLowerCase()) {
      console.error(
        "\nMISMATCH: Aggregator is wired to a DIFFERENT LINK token.\n" +
        `  - LINK_TOKEN you passed:  ${LINK_TOKEN}\n` +
        `  - Aggregator.linkAddr:    ${aggLinkAddr}\n` +
        "Approve/fund the correct token or update the Aggregator config.\n"
      );
      process.exit(1);
    }
  } else {
    console.warn("Could not read Aggregator.linkAddr (no getter found) – skipping LINK match check.");
  }

  // Balance + allowance
  const [linkBal, allowance] = await Promise.all([
    link.balanceOf(me),
    link.allowance(me, AGGREGATOR),
  ]);
  console.log(`LINK balance:   ${ethers.formatEther(linkBal)} LINK`);
  console.log(`LINK allowance: ${ethers.formatEther(allowance)} LINK`);

  // Aggregator parameter guards commonly checked in requestAIEvaluationWithApproval
  try {
    const maxFee = await agg.maxOracleFee?.();
    if (maxFee) {
      console.log("Aggregator.maxOracleFee:", ethers.formatEther(maxFee), "LINK");
      if (MAX_ORACLE_FEE > maxFee) {
        console.error(
          `\nMAX_ORACLE_FEE (${ethers.formatEther(MAX_ORACLE_FEE)}) exceeds Aggregator.maxOracleFee (${ethers.formatEther(maxFee)}).`
        );
        process.exit(1);
      }
    }
  } catch {}

  // Keeper approval check
  try {
    const keeperAddr = await agg.reputationKeeper?.();
    if (keeperAddr) {
      const keeperAbi  = (await hre.artifacts.readArtifact("ReputationKeeper")).abi;
      const keeper     = new ethers.Contract(keeperAddr, keeperAbi, signer);
      const approved   = await keeper.isContractApproved(AGGREGATOR);
      console.log("Keeper approves aggregator:", approved);
      if (!approved) {
        console.error("\nAggregator is NOT approved in Keeper. Run your keeper approval wiring step.\n");
        process.exit(1);
      }
    }
  } catch {}

  // Optional: job class gate
  try {
    const allowed = await agg.isJobClassEnabled?.(JOB_CLASS);
    if (typeof allowed === "boolean") {
      console.log(`Job class ${JOB_CLASS} enabled:`, allowed);
      if (!allowed) {
        console.error(`\nJob class ${JOB_CLASS} is not enabled on Aggregator.\n`);
        process.exit(1);
      }
    }
  } catch {}

  /* ––––– optional LINK allowance ––––– */
  if (process.env.LINK_ALLOWANCE) {
    const allowanceAmt = ethers.parseUnits(process.env.LINK_ALLOWANCE, 18);
    const tx = await link.approve(AGGREGATOR, allowanceAmt);
    console.log("approve() →", tx.hash);
    await tx.wait(1);
  }

  /* helper to submit a single query (unchanged output) */
  async function sendQuery(idx, nonce, delayMs) {
    if (delayMs) await pause(delayMs);

    // Dry-run to surface logic reverts early
    try {
      await agg.getFunction("requestAIEvaluationWithApproval").staticCall(
        CIDS, ADDENDUM, ALPHA,
        MAX_ORACLE_FEE, ESTIMATE_BASE_FEE, MAX_FEE_SCALING, JOB_CLASS
      );
    } catch (e) {
      console.error(`[${idx}] dry-run revert → ${e.shortMessage || e.message || e}`);
      // Try to decode custom error (ethers v6)
      try {
        const data =
          e.data ??
          e.error?.data ??
          e.value?.data ??
          (typeof e === "object" ? e : null);
        if (data) {
          const decoded = agg.interface.parseError(data);
          console.error(`[${idx}] decoded error: ${decoded.name}`, decoded.args);
        }
      } catch {}
      return null;
    }

    // Gas estimate (+20% buffer), fallback to configured GAS_LIMIT
    let gasLimit;
    try {
      const est = await agg.getFunction("requestAIEvaluationWithApproval").estimateGas(
        CIDS, ADDENDUM, ALPHA,
        MAX_ORACLE_FEE, ESTIMATE_BASE_FEE, MAX_FEE_SCALING, JOB_CLASS
      );
      gasLimit = (est * 120n) / 100n;
    } catch {
      gasLimit = BigInt(typeof GAS_LIMIT === "number" ? GAS_LIMIT : 3_000_000);
    }

    // Fee overrides (prefer EIP-1559 from provider; else legacy)
    let overrides = {};
    try {
      const fee = await hre.ethers.provider.getFeeData();
      if (fee?.maxFeePerGas && fee?.maxPriorityFeePerGas) {
        overrides = {
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
        };
      } else if (fee?.gasPrice) {
        overrides = { gasPrice: fee.gasPrice };
      }
    } catch {
      // ignore and send without explicit fee overrides
    }

    // Send transaction
    const tx = await agg.requestAIEvaluationWithApproval(
      CIDS, ADDENDUM, ALPHA,
      MAX_ORACLE_FEE, ESTIMATE_BASE_FEE, MAX_FEE_SCALING, JOB_CLASS,
      { nonce, gasLimit, ...overrides }
    );
    console.log(`[${idx}] tx sent →`, tx.hash);
    const rcpt = await tx.wait(1);

    // Extract RequestAIEvaluation event
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

