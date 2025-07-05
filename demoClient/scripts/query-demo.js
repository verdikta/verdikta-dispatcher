#!/usr/bin/env node
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const TARGET = process.argv[2];
if (!TARGET) {
  console.error("Usage: node scripts/query-demo.js <DemoClient address>");
  process.exit(1);
}

(async () => {
  const [signer] = await ethers.getSigners();
  const demoAbi = (await hre.artifacts.readArtifact("DemoClient")).abi;
  const demo = new ethers.Contract(TARGET, demoAbi, signer);
  
  const currentAggId = await demo.currentAggId();
  console.log("Current aggId before request:", currentAggId);
  
  // Handle existing pending request if present
  if (currentAggId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.log("Found pending request, checking status...");
    
    const aggAbi = (await hre.artifacts.readArtifact('IReputationAggregator')).abi;
    const aggAddress = await demo.agg();
    const agg = new ethers.Contract(aggAddress, aggAbi, ethers.provider);
    
    const [scores, justif, has] = await agg.getEvaluation(currentAggId);
    const failed = await agg.isFailed(currentAggId);
    
    if (has && scores.length > 0) {
      console.log("Previous request has results, publishing...");
      console.log("scores:", scores.map(x => x.toString()).join(", "));
      console.log("justifications:", justif);
      
      const txPub = await demo.publish({ gasLimit: 500_000n });
      console.log("publish tx:", txPub.hash);
      console.log("Previous results published");
      
    } else if (failed) {
      console.log("Previous request failed, clearing...");
      const txPub = await demo.publish({ gasLimit: 500_000n });
      console.log("publish tx:", txPub.hash);
      console.log("Failed request cleared");
      
    } else {
      console.log("Previous request still pending, waiting for completion...");
      console.log("waiting for scores ...");
      
      while (true) {
        try {
          const [scores, justif, has] = await agg.getEvaluation(currentAggId);
          console.log(`Checking results... has: ${has}, scores length: ${scores.length}`);
          
          if (has && scores.length) {
            console.log("SCORES RECEIVED:");
            console.log("scores:", scores.map(x => x.toString()).join(", "));
            console.log("justifications:", justif);
            break;
          }
          
          if (await agg.isFailed(currentAggId)) {
            console.error("evaluation marked as failed by aggregator");
            break;
          }
          
          console.log("Still waiting... checking again in 20 seconds");
          await new Promise(r => setTimeout(r, 20_000));
          
        } catch (error) {
          console.error("Error during polling:", error.message);
          console.log("Retrying in 20 seconds...");
          await new Promise(r => setTimeout(r, 20_000));
        }
      }
      
      console.log("Publishing results...");
      const txPub = await demo.publish({ gasLimit: 500_000n });
      console.log("publish tx:", txPub.hash);
      console.log("COMPLETE!");
      return;
    }
  }
  
  // Check again after handling any previous request
  const finalAggId = await demo.currentAggId();
  if (finalAggId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.error("Still have a pending request after cleanup. Manual intervention required.");
    process.exit(1);
  }
  
  try {
    const txReq = await demo.request({ gasLimit: 3_000_000n });
    console.log("request tx:", txReq.hash);
    const rcpt = await txReq.wait(1);
    
    console.log("Transaction status:", rcpt.status);
    if (rcpt.status !== 1) {
      console.error("Transaction failed!");
      process.exit(1);
    }
    
    console.log("Total logs:", rcpt.logs.length);
    
    let requestedEvent = null;
    rcpt.logs.forEach((log, i) => {
      try {
        const parsed = demo.interface.parseLog(log);
        console.log(`Log ${i} parsed:`, parsed.name, parsed.args);
        if (parsed.name === "Requested") {
          requestedEvent = parsed;
        }
      } catch (e) {
        console.log(`Log ${i} address:`, log.address, "(not from DemoClient)");
      }
    });
    
    if (!requestedEvent) {
      console.error("Requested event not found!");
      process.exit(1);
    }
    
    const aggId = requestedEvent.args.id;
    console.log("aggId:", aggId);
    
    // Use the full ReputationAggregator ABI instead of minimal interface
    console.log("Setting up aggregator polling...");
    const aggAbi = (await hre.artifacts.readArtifact('ReputationAggregator')).abi;
    const aggAddress = await demo.agg();
    const agg = new ethers.Contract(aggAddress, aggAbi, ethers.provider);
    
    console.log("waiting for scores ...");
    while (true) {
      try {
        const [scores, justif, has] = await agg.getEvaluation(aggId);
        console.log(`Checking results... has: ${has}, scores length: ${scores.length}`);
        
        if (has && scores.length) {
          console.log("SCORES RECEIVED:");
          console.log("scores:", scores.map(x => x.toString()).join(", "));
          console.log("justifications:", justif);
          break;
        }
        
        if (await agg.isFailed(aggId)) {
          console.error("evaluation marked as failed by aggregator");
          process.exit(1);
        }
        
        console.log("Still waiting... checking again in 20 seconds");
        await new Promise(r => setTimeout(r, 20_000));
        
      } catch (error) {
        console.error("Error during polling:", error.message);
        console.log("Retrying in 20 seconds...");
        await new Promise(r => setTimeout(r, 20_000));
      }
    }
    
    console.log("Publishing results...");
    const txPub = await demo.publish({ gasLimit: 500_000n });
    console.log("publish tx:", txPub.hash);
    console.log("COMPLETE!");
    
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
})();

