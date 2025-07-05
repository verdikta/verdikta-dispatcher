#!/usr/bin/env node
// scripts/query-demo.js
// Usage: node scripts/query-demo.js <DemoClient address>

const hre = require("hardhat");
const { ethers } = hre;

const DEMO = process.argv[2];
if (!DEMO) { console.error("provide DemoClient address"); process.exit(1); }

const POLL_MS = 20_000;
const GAS_REQ = 3_000_000n;
const GAS_PUB =   500_000n;

/* inline ABI fragment for aggregator (only what we use) */
const AGG_ABI = [
  "function getEvaluation(bytes32)(uint64[],string,bool)",
  "function isFailed(bytes32)(bool)"
];

(async () => {
  const [signer] = await ethers.getSigners();

  /* DemoClient instance (we have this artifact) */
  const demoAbi = (await hre.artifacts.readArtifact("DemoClient")).abi;
  const demo    = new ethers.Contract(DEMO, demoAbi, signer);

  /* 1. fire request() --------------------------------------------------- */
  const tx = await demo.request({ gasLimit: GAS_REQ });
  console.log("request tx:", tx.hash);
  await tx.wait(1);

  /* 2. read aggId directly from storage -------------------------------- */
  const aggId = await demo.currentAggId();
  console.log("aggId:", aggId);

  /* 3. wrap aggregator address ----------------------------------------- */
  const aggAddr = await demo.agg();                 // getter is in your code
  const agg     = new ethers.Contract(aggAddr, AGG_ABI, signer);

  /* 4. poll until ready or failed -------------------------------------- */
  while (true) {
    const [scores, , has] = await agg.getEvaluation(aggId);
    if (has && scores.length > 0) {
      console.log("scores:", scores.map(s => s.toString()).join(", "));
      break;
    }
    if (await agg.isFailed(aggId)) {
      console.log("request failed");
      return;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  /* 5. publish() so Result event is emitted ---------------------------- */
  const txPub = await demo.publish({ gasLimit: GAS_PUB });
  console.log("publish tx:", txPub.hash);
})();

