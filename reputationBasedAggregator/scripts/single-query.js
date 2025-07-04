#!/usr/bin/env node
require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

/* ─── config ─────────────────────────────────────────────────────────── */
const AGG   = '0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02';
const CID   = 'QmZ2BgPsmnn4T4ShbdryoTWXFM4nHt7tM674fU4CLVHthH';      // <-- edit
const JOB   = 128;
const ALPHA = 500;
const FEE   = ethers.parseUnits('0.01', 18);
const BASE  = ethers.parseUnits('0.000001', 18);
const SCALE = 5;
const GAS   = 3_000_000n;
const DELAY = 20_000;   // poll every 20 s
/* ────────────────────────────────────────────────────────────────────── */

(async () => {
  const [signer] = await ethers.getSigners();
  const abi = (await hre.artifacts.readArtifact('ReputationAggregator')).abi;
  const agg = new ethers.Contract(AGG, abi, signer);

  /* send request */
  const tx = await agg.requestAIEvaluationWithApproval(
    [CID], '', ALPHA, FEE, BASE, SCALE, JOB, { gasLimit: GAS }
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

