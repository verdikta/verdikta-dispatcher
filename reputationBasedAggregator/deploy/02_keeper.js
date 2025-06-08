// deploy/02_keeper.js
// -----------------------------------------------------------------------------
// Deploys ReputationKeeper, then connects it to the ReputationAggregator that
// was deployed in 001_aggregator.js (which currently holds a dummy keeper
// address). This mirrors your old Truffle migration #5.
// -----------------------------------------------------------------------------
//   • Requires WRAPPED_VERDIKTA_TOKEN in .env (token is no longer deployed).
//   • Skips entirely when SKIP_MIGRATIONS env‑var is set.
// -----------------------------------------------------------------------------

require("dotenv").config();
const { execute } = deployments;

module.exports = async ({ deployments, getNamedAccounts, ethers, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/02_keeper] SKIP_MIGRATIONS set → skipping deploy");
    return;
  }

  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  /* ----------------------------------------------------------------------- */
  /* Resolve token address                                                   */
  /* ----------------------------------------------------------------------- */
  const TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN;
  if (!ethers.isAddress(TOKEN_ADDR)) {
    throw new Error("WRAPPED_VERDIKTA_TOKEN not set or invalid in .env");
  }
  console.log("Using WrappedVerdiktaToken:", TOKEN_ADDR);

  /* ----------------------------------------------------------------------- */
  /* Deploy ReputationKeeper                                                 */
  /* ----------------------------------------------------------------------- */
  // Wait for aggregator deployment to settle
  // await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
  const currentNonce = await ethers.provider.getTransactionCount(deployer, "latest");
  const pendingNonce = await ethers.provider.getTransactionCount(deployer, "pending");
  const safeNonce = Math.max(currentNonce, pendingNonce);

  console.log(`Using nonce ${safeNonce} (current: ${currentNonce}, pending: ${pendingNonce})`);

  const keeperRes = await deploy("ReputationKeeper", {
    from: deployer,
    args: [TOKEN_ADDR],
    log: true,
    // gasLimit: 5_000_000,
    nonce: safeNonce
  });
  const keeperAddr = keeperRes.address;
  console.log("ReputationKeeper deployed:", keeperAddr);

  /* ----------------------------------------------------------------------- */
  /* Wire keeper ↔ aggregator                                                */
  /* ----------------------------------------------------------------------- */
  // fetch addresses that hardhat‑deploy wrote
  let aggInfo  = await deployments.getOrNull("ReputationAggregator");
  if (!aggInfo || !ethers.isAddress(aggInfo.address)) {
    throw new Error("Aggregator address not recorded yet; re-run the deploy.");
  }
  const keepInfo = await deployments.get("ReputationKeeper");

  // get the signer for the deployer address
  const signer = await ethers.getSigner(deployer);

  // attach contracts with that signer
  const aggregator = await ethers.getContractAt(
    "ReputationAggregator",
    aggInfo.address,
    signer
  );

  const keeper = await ethers.getContractAt(
    "ReputationKeeper",
    keepInfo.address,
    signer
  );

 // const currentNonce1 = await ethers.provider.getTransactionCount(deployer, "latest");
 // const pendingNonce1 = await ethers.provider.getTransactionCount(deployer, "pending");
 // const baseNonce = Math.max(currentNonce1, pendingNonce1, safeNonce+1);
 // console.log(`Contract interaction nonce: ${baseNonce} (current: ${currentNonce1}, pending: ${pendingNonce1})`);

  console.log("Approving aggregator in keeper…");
  if (!aggInfo?.address || aggInfo.address === ethers.ZeroAddress) {
    throw new Error("Aggregator address undefined – previous deploy not finished?");
  }
  console.log("DEBUG aggInfo.address =", aggInfo.address);
  // await (await keeper.approveContract(aggInfo.address, { nonce: baseNonce })).wait();
  // await (await keeper["approveContract(address)"]( aggInfo.address, { nonce: baseNonce } )).wait();

  // Check if aggregator is already approved in keeper
  const isApproved = await keeper.isContractApproved(aggInfo.address);
  console.log("Aggregator already approved in Keeper:", isApproved);
if (!isApproved) {
  try {
    console.log("Approving aggregator using hardhat-deploy...");
    await execute(
      "ReputationKeeper",           // Contract name
      { 
        from: deployer, 
        log: true,
        // gasLimit: 800000,           // Keep your working gas settings
        gasPrice: ethers.parseUnits("10", "gwei")
      },
      "approveContract",            // Function name  
      aggInfo.address              // Function argument
    );
    console.log("Approval successful!");
  } catch (error) {
    console.log("Approval failed:", error.message);
    throw error;
  }

  } else {
    console.log("Aggregator already approved, skipping...");
  }

console.log("Setting Keeper address inside Aggregator…");
const currentKeeper = await aggregator.reputationKeeper();
console.log("Current keeper in aggregator:", currentKeeper);
console.log("Expected keeper:", keepInfo.address);

if (currentKeeper.toLowerCase() !== keepInfo.address.toLowerCase()) {
  try {
    console.log("Setting keeper using hardhat-deploy...");
    await execute(
      "ReputationAggregator",       // Contract name
      { 
        from: deployer, 
        log: true,
        // gasLimit: 300000,           // Adjust gas as needed
        gasPrice: ethers.parseUnits("10", "gwei")
      },
      "setReputationKeeper",        // Function name
      keepInfo.address             // Function argument
    );
    console.log("Keeper address set successfully!");
  } catch (error) {
    console.log("Set keeper failed:", error.message);
    throw error;
  }
} else {
  console.log("Keeper already set correctly, skipping...");
}
  console.log("Keeper wired to aggregator ✓");
};

module.exports.tags = ["keeper"];
module.exports.dependencies = ["aggregator"];

