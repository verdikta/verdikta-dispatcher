// scripts/runSixQueries.js
require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = require("ethers");

/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   EDIT ONLY THESE CONSTANTS
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
const AGGREGATOR = "0xa9EFf546841c039fF9f5C923c520EEB2f468847d";
const LINK_TOKEN = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";

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
    const allowance = hre.ethers.utils.parseUnits(process.env.LINK_ALLOWANCE, 18);
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
  } else {
    console.log(`[${idx}] RequestAIEvaluation event not found`);
  }
  
  return rcpt;
}

  /* ---- fire six queries in parallel ---- */
  // await Promise.all(Array.from({ length: 6 }, (_, i) => sendQuery(i + 1)));
  const startNonce = await signer.getNonce();
  console.log(`Starting nonce: ${startNonce}`);

  const promises = Array.from({ length: 6 }, (_, i) => 
    sendQuery(i + 1, startNonce + i)
  );

}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

