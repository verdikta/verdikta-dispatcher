// scripts/deploy_just_aggregator.js
// ------------------------------------------------------------
// Helper: deploy a NEW ReputationAggregator but keep the
// existing ReputationKeeper.
//
// Usage:
//   npx hardhat run scripts/deploy_just_aggregator.js \
//        --network base_sepolia
//
// Environment:
//   WRAPPED_VERDIKTA_TOKEN must already be set (same as before).
// ------------------------------------------------------------
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

  /* -------------------------------------------------------- */
  /* 1. Locate existing keeper                                */
  /* -------------------------------------------------------- */
  const keeperInfo = await deployments.get("ReputationKeeper")
        .catch(() => { throw new Error("❌  ReputationKeeper not found in deployments"); });
  const keeperAddr = keeperInfo.address;
  console.log("✓ Existing ReputationKeeper:", keeperAddr);

  /* -------------------------------------------------------- */
  /* 2. Deploy new aggregator wired to keeper                 */
  /* -------------------------------------------------------- */
  const linkAddr = LINK_TOKEN_ADDRESS[network.name];
  if (!linkAddr) throw new Error(`No LINK token for network ${network.name}`);

  const aggRes = await deploy("ReputationAggregator", {
    from: deployer,
    args: [linkAddr, keeperAddr],      // <-- keeper wired here
    log:  true,
  });
  const aggAddr = aggRes.address;
  console.log("✓ New ReputationAggregator deployed:", aggAddr);

  /* -------------------------------------------------------- */
  /* 3. Approve aggregator inside keeper (if not yet)         */
  /* -------------------------------------------------------- */
  const keeper = await ethers.getContractAt("ReputationKeeper", keeperAddr, signer);
  const already = await keeper.approvedContracts(aggAddr);
  if (!already) {
    console.log("Approving aggregator in keeper…");
    await (await keeper.approveContract(aggAddr)).wait();
  } else {
    console.log("Aggregator already approved in keeper.");
  }

  /* -------------------------------------------------------- */
  /* 4. Basic config just like 03_config.js                   */
  /* -------------------------------------------------------- */
  const aggregator = await ethers.getContractAt("ReputationAggregator", aggAddr, signer);
  console.log("Configuring aggregator parameters (4-3-2, 300 s, 0.08 LINK) …");
  await (await aggregator.setConfig(4, 3, 2, 300)).wait();
  await (await aggregator.setMaxOracleFee(ethers.parseEther("0.08"))).wait();

  console.log("🎉 All done!  New aggregator is live and wired to keeper.");
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });

