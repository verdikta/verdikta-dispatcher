#!/usr/bin/env node
require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

/* ─── config ─────────────────────────────────────────────────────────── */
// AGG must point at the ETH-funded ReputationAggregator.
const AGG   = '0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02';          // <-- set to ETH aggregator
const CID   = 'QmZ2BgPsmnn4T4ShbdryoTWXFM4nHt7tM674fU4CLVHthH';      // <-- edit
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

