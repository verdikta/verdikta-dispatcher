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
  
  // Check current state first
  const currentAggId = await demo.currentAggId();
  console.log("Current aggId before request:", currentAggId);
  
  if (currentAggId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.error("Already have a pending request. Call publish() first or wait for completion.");
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
    
    // Debug: show all logs
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
      console.error("This suggests the transaction succeeded but the event wasn't emitted");
      console.error("Check if the require() statement failed or if there's an issue with the contract");
      process.exit(1);
    }
    
    const aggId = requestedEvent.args.id;
    console.log("aggId:", aggId);
    
    // Rest of your code...
    
  } catch (error) {
    console.error("Error calling request():", error.message);
    if (error.reason) {
      console.error("Revert reason:", error.reason);
    }
    process.exit(1);
  }
})();

