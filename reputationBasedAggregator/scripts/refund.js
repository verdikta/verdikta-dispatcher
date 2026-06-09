#!/usr/bin/env node
/*
  scripts/refund.js — reclaim ETH from the ETH-funded ReputationAggregator.

  Two steps (the second always runs, the first only if AGG_ID is given):
    1. If AGG_ID is set and that round has timed out but isn't settled, call
       finalizeEvaluationTimeout(aggId) — this releases the round's reserved ETH
       into the requester's ethOwed credit. (Base already paid to polled oracles
       stays with them — pay-all design.)
    2. withdrawEth() — pull the caller's entire ethOwed balance to the caller's wallet.

  Usage:
    # just withdraw whatever credit you have:
    npx hardhat run scripts/refund.js --network base_sepolia
    # finalize a specific stuck round first, then withdraw:
    AGG_ID=0x... npx hardhat run scripts/refund.js --network base_sepolia

  Aggregator is resolved per-network (override with the AGG env var).
*/
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const AGG_BY_NET = {
  base:         "0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a",
  base_sepolia: "0xe8a385E473EA710c5a88Cc72681a16a26fe380e4",
};

(async () => {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — set PRIVATE_KEY");
  const me = await signer.getAddress();

  const aggAddr = process.env.AGG || AGG_BY_NET[hre.network.name];
  if (!aggAddr || !ethers.isAddress(aggAddr)) throw new Error(`No aggregator for ${hre.network.name}; set AGG env`);

  const abi = (await hre.artifacts.readArtifact("ReputationAggregator")).abi;
  const agg = new ethers.Contract(aggAddr, abi, signer);
  console.log(`Network: ${hre.network.name}  aggregator: ${aggAddr}  caller: ${me}`);

  /* 1) Optional: finalize a timed-out round to release its reserve into ethOwed. */
  let finalized = false;
  const aggId = process.env.AGG_ID;
  if (aggId) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(aggId)) throw new Error(`AGG_ID must be a bytes32 hex string: ${aggId}`);
    const s = await agg.getAggregationStatus(aggId);
    if (s.isComplete) {
      console.log(`Round ${aggId} already settled (failed=${s.failed}); nothing to finalize.`);
    } else {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const deadline = Number(s.startTimestamp) + Number(await agg.responseTimeoutSeconds());
      if (now < deadline) {
        console.log(`Round not timed out yet (${deadline - now}s remaining); skipping finalize.`);
      } else {
        if (s.requester.toLowerCase() !== me.toLowerCase()) {
          console.log(`Note: round requester is ${s.requester} — its refund credits THAT address, not you.`);
        }
        console.log("Finalizing timed-out round…");
        const r = await (await agg.finalizeEvaluationTimeout(aggId)).wait();
        console.log("finalizeEvaluationTimeout tx:", r.hash);
        finalized = true;
      }
    }
  }

  /* 2) Withdraw the caller's entire ethOwed credit. */
  let owed = await agg.ethOwed(me);
  // A finalize in step 1 credits ethOwed in the just-mined block; a load-balanced RPC
  // can briefly return the stale (pre-finalize) value, so retry before giving up.
  for (let i = 0; finalized && owed === 0n && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    owed = await agg.ethOwed(me);
  }
  console.log("ethOwed credit:", ethers.formatEther(owed), "ETH");
  if (owed === 0n) { console.log("Nothing to withdraw."); return; }

  const before = await ethers.provider.getBalance(me);
  const r = await (await agg.withdrawEth()).wait();
  const after = await ethers.provider.getBalance(me);
  console.log("withdrawEth tx:", r.hash);
  console.log(`Wallet: ${ethers.formatEther(before)} → ${ethers.formatEther(after)} ETH`);
  console.log("Done.");
})().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
