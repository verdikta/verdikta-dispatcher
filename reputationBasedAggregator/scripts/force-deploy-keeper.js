const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  
  console.log("=== Conservative Deploy Keeper ===");
  console.log("Network:", hre.network.name);
  console.log("Deployer:", signer.address);
  
  // Check balance
  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");
  
  // Check current nonce (use latest, not pending)
  const currentNonce = await hre.ethers.provider.getTransactionCount(signer.address, "latest");
  console.log("Current nonce:", currentNonce);
  
  // Use next sequential nonce (conservative approach)
  const nextNonce = currentNonce;
  console.log("Using nonce:", nextNonce);
  
  // Set reasonable gas price
  const gasPrice = hre.ethers.parseUnits("4", "gwei"); // Fixed 4 gwei
  console.log("Using gas price: 4.0 gwei");
  
  // Token address
  const TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN || "0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3";
  console.log("Token address:", TOKEN_ADDR);
  
  try {
    // Deploy ReputationKeeper
    const ReputationKeeper = await hre.ethers.getContractFactory("ReputationKeeper");
    
    console.log("\nDeploying ReputationKeeper...");
    
    // Create deployment transaction
    const deployTx = await ReputationKeeper.getDeployTransaction(TOKEN_ADDR);
    
    // Send transaction with explicit parameters
    const txResponse = await signer.sendTransaction({
      ...deployTx,
      nonce: nextNonce,
      gasPrice: gasPrice,
      gasLimit: 5000000
    });
    
    console.log("Transaction hash:", txResponse.hash);
    console.log("Waiting for confirmation...");
    
    // Wait with timeout
    const receipt = await Promise.race([
      txResponse.wait(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout after 60 seconds")), 60000)
      )
    ]);
    
    console.log("Transaction confirmed in block:", receipt.blockNumber);
    
    // Get the deployed contract address
    const keeperAddress = receipt.contractAddress;
    console.log("✅ ReputationKeeper deployed:", keeperAddress);
    
    // Create contract instance
    const keeper = await hre.ethers.getContractAt("ReputationKeeper", keeperAddress, signer);
    
    // Wire with the latest aggregator
    const AGGREGATOR_ADDRESS = "0x9676023dF53B6832548fB3D9AA1A42b39B5F3881";
    console.log("\nWiring with aggregator:", AGGREGATOR_ADDRESS);
    
    const aggregator = await hre.ethers.getContractAt(
      "ReputationAggregator", 
      AGGREGATOR_ADDRESS, 
      signer
    );
    
    // Get updated nonce for next transactions
    let currentNonce = await hre.ethers.provider.getTransactionCount(signer.address, "latest");
    
    // Wire contracts
    console.log("1. Approving aggregator in keeper...");
    const tx1 = await keeper.approveContract(AGGREGATOR_ADDRESS, {
      gasPrice: gasPrice,
      nonce: currentNonce
    });
    console.log("Transaction hash:", tx1.hash);
    await tx1.wait();
    console.log("✓ Approved");
    
    // Get fresh nonce after first transaction
    currentNonce = await hre.ethers.provider.getTransactionCount(signer.address, "latest");
    
    console.log("2. Setting keeper in aggregator...");
    const tx2 = await aggregator.setReputationKeeper(keeperAddress, {
      gasPrice: gasPrice,
      nonce: currentNonce
    });
    console.log("Transaction hash:", tx2.hash);
    await tx2.wait();
    console.log("✓ Set");
    
    console.log("\n🎉 COMPLETE DEPLOYMENT SUCCESSFUL!");
    console.log("ReputationAggregator:", AGGREGATOR_ADDRESS);
    console.log("ReputationKeeper:", keeperAddress);
    console.log("\nYour contracts are fully deployed and wired!");
    
    // Clean exit
    process.exit(0);
    
  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);

    if (error.message.includes("Timeout")) {
      console.log("💡 Transaction might still be pending. Check your nonce and try again.");
    } else if (error.code === "INSUFFICIENT_FUNDS") {
      console.log("💡 Need more Base Sepolia ETH from faucet");
    } else {
      // Try custom error decoding from available contract interfaces
      let decoded = false;
      if (error.data) {
        const contracts = [];
        try { contracts.push(keeper); } catch {}
        try { contracts.push(aggregator); } catch {}
        for (const c of contracts) {
          try {
            const parsed = c.interface.parseError(error.data);
            if (parsed) {
              const args = parsed.args.length ? `(${parsed.args.join(", ")})` : "";
              console.log("Revert:", parsed.name + args);
              decoded = true;
              break;
            }
          } catch {}
        }
      }
      if (!decoded && error.reason) {
        console.log("Revert reason:", error.reason);
      } else if (!decoded) {
        console.log("Error details:", error);
      }
    }
  }
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});

