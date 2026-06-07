#!/usr/bin/env node
require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

/* ─── config ─────────────────────────────────────────────────────────── */
// ETH-funded ReputationAggregator, per network (override with AGG env var).
const AGG   = process.env.AGG || (hre.network.name === 'base'
  ? '0x8d0627CCd3E1747EFaC3b7fc600e4697747be447'      // Base mainnet
  : '0x01C0149854DA080d5fBD3c57FA40DDE5f2e10c64');    // Base Sepolia
// Must resolve to a REAL Verdikta query archive (zip with manifest.json + primary file,
// "query" >= 10 chars), else the arbiter's AI backend returns HTTP 500 and the round never
// commits. Default below is a known-good test query ("The sky is blue." -> True/False).
const CID   = process.env.CID || 'Qma8vc6pEHEgFQkjS6qZbK4Ue8S7SkdhQ6eqLV2hcrDD53';
const JOB   = 128;
const ALPHA = 500;
// ETH-denominated (wei). Request ceiling must be >= the arbiters' fee (0.0001 ETH)
// and <= the aggregator's maxOracleFee (0.0004 ETH); base cost must be < the ceiling.
const FEE   = 150_000_000_000_000n;   // 1.5e14 wei = 0.00015 ETH requested ceiling
const BASE  = 8_000_000_000n;         // 8e9 wei estimated base cost
const SCALE = 5;
const GAS   = 3_000_000n;
const DELAY = 20_000;   // poll every 20 s
/* ────────────────────────────────────────────────────────────────────── */

(async () => {
  const [signer] = await ethers.getSigners();
  const abi = (await hre.artifacts.readArtifact('ReputationAggregator')).abi;
  const agg = new ethers.Contract(AGG, abi, signer);

  /* Worst-case ETH to attach. The aggregator refunds any unspent remainder as an
     ethOwed credit (claim with withdrawEth(), or it auto-funds your next request).
     A caller with existing credit could send less; this script just prepays in full. */
  const required = await agg.maxTotalFee(FEE);
  console.log('attaching value (wei):', required.toString());

  /* send request — native ETH rides along as msg.value; no LINK approval needed */
  const tx = await agg.requestAIEvaluationWithApproval(
    [CID], '', ALPHA, FEE, BASE, SCALE, JOB, { value: required, gasLimit: GAS }
  );
  console.log('tx:', tx.hash);
  const rcpt   = await tx.wait();
  const aggId  = rcpt.logs
    .map(l => { try { return agg.interface.parseLog(l); } catch {} })
    .find(l => l?.name === 'RequestAIEvaluation').args.aggRequestId;
  console.log('aggId:', aggId);

  /* poll until done */
  while (true) {
    const [scores, justif, has] = await agg.getEvaluation(aggId);
    if (has && scores.length) {
      console.log('scores:', scores.map(s => s.toString()).join(', '));
      console.log('justifications CID:', justif);
      break;
    }
    if (await agg.isFailed(aggId)) {
      console.log('request failed');
      break;
    }
    await new Promise(r => setTimeout(r, DELAY));
  }
})();

