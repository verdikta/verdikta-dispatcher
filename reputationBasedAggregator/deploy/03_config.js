// deploy/03_config.js
// -----------------------------------------------------------------------------
// Post‑deployment wiring & parameters
//   • Set Verdikta token address inside ReputationKeeper (defensive)           
//   • Configure ReputationAggregator (cluster, responses, fee, timeout)       
//   • Set max oracle fee (0.08 LINK)                                          
//                                                                             
// Tags:    config                                                              
// Depends: aggregator, keeper                                                  
// -----------------------------------------------------------------------------

require("dotenv").config();

module.exports = async ({ ethers, getNamedAccounts, deployments }) => {
  if (process.env.SKIP_MIGRATIONS) {
    console.log("[deploy/03_config] SKIP_MIGRATIONS set → skipping");
    return;
  }

  const { deployer } = await getNamedAccounts();

  /* ----------------------------------------------------------------------- */
  /* Contracts                                                                */
  /* ----------------------------------------------------------------------- */

const aggInfo  = await deployments.get("ReputationAggregator");
const keepInfo = await deployments.get("ReputationKeeper");
const signer   = await ethers.getSigner(deployer);

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

  const TOKEN_ADDR = process.env.WRAPPED_VERDIKTA_TOKEN;
  if (!ethers.isAddress(TOKEN_ADDR)) {
    throw new Error("WRAPPED_VERDIKTA_TOKEN env var missing or invalid");
  }

  /* ----------------------------------------------------------------------- */
  /* 1. Ensure keeper points at the correct token (redundant but safe)       */
  /* ----------------------------------------------------------------------- */
  const currentToken = await keeper.verdiktaToken();
  if (currentToken.toLowerCase() !== TOKEN_ADDR.toLowerCase()) {
    console.log("Updating Verdikta token address in keeper…");
    await (await keeper.setVerdiktaToken(TOKEN_ADDR)).wait();
  }

  /* ----------------------------------------------------------------------- */
  /* 2. Configure aggregator                                                 */
  /* ----------------------------------------------------------------------- */
  console.log("Configuring aggregator parameters…");
  await (await aggregator.setConfig(4, 3, 2, 300)).wait();

  const maxFee = ethers.parseEther("0.08"); // 0.08 LINK
  await (await aggregator.setMaxOracleFee(maxFee)).wait();

  console.log("Aggregator configured ✓");
};

module.exports.tags = ["config"];
module.exports.dependencies = ["aggregator", "keeper"];
 
