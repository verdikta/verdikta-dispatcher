// scripts/deploy_just_aggregator.js
// -----------------------------------------------------------------------------
// Deploy a *new* ReputationAggregator and wire it to the existing
// ReputationKeeper.  Updated for the commit-reveal version (no setConfig).
//
// Usage:
//   npx hardhat run scripts/deploy_just_aggregator.js --network base_sepolia
// -----------------------------------------------------------------------------
require("dotenv").config();
const hre = require("hardhat");

const LINK_TOKEN_ADDRESS = {
  base:         "0xd886e2286fd1073df82462ea1822119600af80b6",
  base_goerli:  "0xd886e2286fd1073df82462ea1822119600af80b6",
  base_sepolia: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
  development:  "0x0000000000000000000000000000000000000000",
  hardhat:      "0x0000000000000000000000000000000000000000",
  localhost:    "0x0000000000000000000000000000000000000000",
};

async function main () {
  const { deployments, getNamedAccounts, ethers, network } = hre;
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();
  const signer       = await ethers.getSigner(deployer);

  /* ------------------------------------------------------------------ */
  /* 1. Locate the existing ReputationKeeper                            */
  /* ------------------------------------------------------------------ */
  const keeperInfo = await deployments.get("ReputationKeeper")
        .catch(() => { throw new Error("❌  ReputationKeeper not found in deployments"); });
  const keeperAddr = keeperInfo.address;
  console.log("✓ Existing ReputationKeeper:", keeperAddr);

  /* ------------------------------------------------------------------ */
  /* 2. Deploy a new ReputationAggregator                               */
  /* ------------------------------------------------------------------ */
  const linkAddr = LINK_TOKEN_ADDRESS[network.name];
  if (!linkAddr) throw new Error(`No LINK token address for network ${network.name}`);

  const aggRes = await deploy("ReputationAggregator", {
    from: deployer,
    args: [linkAddr, keeperAddr],   // LINK token and keeper addresses
    log:  true,
    skipIfAlreadyDeployed: false,
    deterministicDeployment: false
  });
  const aggAddr = aggRes.address;
  console.log("✓ New ReputationAggregator deployed:", aggAddr);

  /* ------------------------------------------------------------------ */
  /* 3. Approve the aggregator inside the keeper (if not yet approved)  */
  /* ------------------------------------------------------------------ */
  const keeper = await ethers.getContractAt("ReputationKeeper", keeperAddr, signer);
  const approved = await keeper.approvedContracts(aggAddr);
  if (!approved) {
    console.log("Approving aggregator in keeper…");
    await (await keeper.approveContract(aggAddr)).wait();
  } else {
    console.log("Aggregator already approved in keeper.");
  }

  /* ------------------------------------------------------------------ */
  /* 4. Configure the aggregator                                        */
  /* ------------------------------------------------------------------ */
  const aggregator = await ethers.getContractAt("ReputationAggregator", aggAddr, signer);

  // 4-3-2 commit-reveal layout:
  //   K = 4  total oracles polled in commit phase
  //   M = 3  first 3 commits advance to reveal
  //   N = 3  first 3 reveals are accepted for clustering
  //   P = 2  cluster size rewarded
  //
  console.log("Setting phase counts to (K,M,N,P) = (4,3,3,2)…");
  await (await aggregator.setPhaseCounts(4, 3, 3, 2)).wait();

  console.log("Setting response timeout to 300 seconds…");
  await (await aggregator.setResponseTimeout(300)).wait();

  console.log("Setting max oracle fee to 0.08 LINK…");
  await (await aggregator.setMaxOracleFee(ethers.parseEther("0.08"))).wait();

  console.log("🎉 Deployment and configuration complete!");
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });

