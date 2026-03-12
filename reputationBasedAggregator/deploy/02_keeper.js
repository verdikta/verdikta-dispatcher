// deploy/02_keeper.js
// -----------------------------------------------------------------------------
// Deploys ReputationKeeper, then connects it to the ReputationAggregator that
// was deployed in 01_aggregator.js (which currently holds a dummy keeper
// address). 
// -----------------------------------------------------------------------------
//   • Requires WRAPPED_VERDIKTA_TOKEN in .env.
//   • Skips entirely when SKIP_MIGRATIONS env var is set.
// -----------------------------------------------------------------------------

require("dotenv").config();
const { verifyContract } = require("./helpers");

module.exports = async ({ deployments, getNamedAccounts, ethers, network }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/02_keeper] SKIP_MIGRATIONS set → skipping deploy");
    return;
  }

  const { deploy, execute } = deployments;
  const { deployer } = await getNamedAccounts();
  const CONFIRMATIONS =
    (network.name === "base_sepolia" || network.name === "base") ? 2 : 1;


  /* ----------------------------------------------------------------------- */
  /* Resolve token address                                                   */
  /* ----------------------------------------------------------------------- */
  let TOKEN_ADDR;
  if (network.name === "base") {
    TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN_BASE;
  } else if (network.name === "base_sepolia") {
    TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA;
  } else {
    TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN;
  }

  if (!ethers.isAddress(TOKEN_ADDR)) {
    throw new Error("WRAPPED_VERDIKTA_TOKEN not set or invalid in .env");
  }
  console.log("Using WrappedVerdiktaToken:", TOKEN_ADDR);

  /* ----------------------------------------------------------------------- */
  /* Deploy ReputationKeeper                                                 */
  /* ----------------------------------------------------------------------- */
  const cNonce = await ethers.provider.getTransactionCount(deployer, "latest");
  const pNonce = await ethers.provider.getTransactionCount(deployer, "pending");
  const sNonce = Math.max(cNonce, pNonce);
  console.log(`For Keeper deployment, probably using nonce ${sNonce} (current: ${cNonce}, pending: ${pNonce})`);

  const keeperRes = await deploy("ReputationKeeper", {
    from: deployer,
    args: [TOKEN_ADDR],
    log: true,
    waitConfirmations: CONFIRMATIONS
  });

  const keeperAddr = keeperRes.address;
  console.log("ReputationKeeper deployment completed:", keeperAddr);

  if (keeperRes.newlyDeployed) {
    await verifyContract(
      keeperAddr,
      [TOKEN_ADDR],
      "contracts/ReputationKeeper.sol:ReputationKeeper"
    );
  }

  /* ----------------------------------------------------------------------- */
  /* Wire keeper ↔ aggregator                                                */
  /* ----------------------------------------------------------------------- */
  // fetch addresses that hardhat-deploy wrote
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

  console.log("Approving aggregator in keeper…");
  if (!aggInfo?.address || aggInfo.address === ethers.ZeroAddress) {
    throw new Error("Aggregator address undefined – previous deploy not finished?");
  }

  // Check if aggregator is already approved in keeper
  const isApproved = await keeper.isContractApproved(aggInfo.address);
  console.log("Aggregator already approved in Keeper:", isApproved);
if (!isApproved) {
  try {
    console.log("Approving aggregator using hardhat-deploy...");
    const txApp = await execute(
      "ReputationKeeper",           // Contract name
      { 
        from: deployer, 
        log: true,
	waitConfirmations: CONFIRMATIONS
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
    const txSet = await execute(
      "ReputationAggregator",       // Contract name
      { 
        from: deployer, 
        log: true,
	waitConfirmations: CONFIRMATIONS
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
  console.log("Keeper wired to aggregator.");
};

module.exports.tags = ["keeper"];
// module.exports.dependencies = ["aggregator"];

