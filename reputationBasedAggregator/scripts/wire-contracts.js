const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  
  console.log("=== Wiring Existing Contracts ===");
  console.log("Deployer address:", signer.address);
  console.log("Network:", hre.network.name);
  
  // Check balance
  const balance = await signer.provider.getBalance(signer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");
  
  // Your deployed contract addresses
  const AGGREGATOR_ADDRESS = "0xd5c04EACe8639bF0c503e410666B6d00cD1307F0";
  const KEEPER_ADDRESS = "0xc52215e21a899EAFdDDa74222f0b49e7E16261B8";
  
  console.log("Aggregator:", AGGREGATOR_ADDRESS);
  console.log("Keeper:", KEEPER_ADDRESS);
  
  // Verify contracts exist
  const aggCode = await signer.provider.getCode(AGGREGATOR_ADDRESS);
  const keeperCode = await signer.provider.getCode(KEEPER_ADDRESS);
  
  if (aggCode === "0x") {
    throw new Error("Aggregator contract not found at address");
  }
  if (keeperCode === "0x") {
    throw new Error("Keeper contract not found at address");
  }
  
  console.log("✓ Both contracts verified on chain");
  
  // Connect to contracts
  const aggregator = await hre.ethers.getContractAt(
    "ReputationAggregator", 
    AGGREGATOR_ADDRESS, 
    signer
  );
  
  const keeper = await hre.ethers.getContractAt(
    "ReputationKeeper", 
    KEEPER_ADDRESS, 
    signer
  );
  
  // Low gas price for cheap transactions
  const gasOptions = {
    gasPrice: 2000000000 // 2 gwei
  };
  
  try {
    console.log("\n1. Approving aggregator in keeper...");
    const tx1 = await keeper.approveContract(AGGREGATOR_ADDRESS, gasOptions);
    console.log("Transaction hash:", tx1.hash);
    await tx1.wait();
    console.log("Aggregator approved in keeper");
    
    console.log("\n2. Setting keeper address in aggregator...");
    const tx2 = await aggregator.setReputationKeeper(KEEPER_ADDRESS, gasOptions);
    console.log("Transaction hash:", tx2.hash);
    await tx2.wait();
    console.log("Keeper set in aggregator");
    
    console.log("\nContracts successfully wired together!");
    console.log("ReputationAggregator:", AGGREGATOR_ADDRESS);
    console.log("ReputationKeeper:", KEEPER_ADDRESS);
    
  } catch (error) {
    console.error("Error during wiring:", error.message);

    if (error.code === "INSUFFICIENT_FUNDS") {
      console.log("\nNeed more Base Sepolia ETH from faucet");
    } else {
      // Try custom error decoding first, then fall back to string reason
      let decoded = false;
      if (error.data) {
        for (const c of [keeper, aggregator]) {
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
      }
    }
  }
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});

