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
  const keeperRes = await deploy("ReputationKeeper", {
    from: deployer,
    args: [TOKEN_ADDR],
    log: true,
  });
  const keeperAddr = keeperRes.address;
  console.log("ReputationKeeper deployed:", keeperAddr);

  /* ----------------------------------------------------------------------- */
  /* Wire keeper ↔ aggregator                                                */
  /* ----------------------------------------------------------------------- */
// fetch addresses that hardhat‑deploy wrote
const aggInfo  = await deployments.get("ReputationAggregator");
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
  await (await keeper.approveContract(aggregator.target)).wait();

  console.log("Setting keeper address inside aggregator…");
  await (await aggregator.setReputationKeeper(keeperAddr)).wait();

  console.log("Keeper wired to aggregator ✓");
};

module.exports.tags = ["keeper"];
module.exports.dependencies = ["aggregator"];

