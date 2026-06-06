// scripts/deploy_just_aggregator.js
// -----------------------------------------------------------------------------
// Deploy a *new* ETH-funded ReputationAggregator (+ a fresh AggregatorLib) and
// wire it to the EXISTING ReputationKeeper. This is the "reuse the live keeper"
// path (docs/advanced/eth-payment-migration.md section 5): operators already
// trust that keeper, so no operator rkList change is needed.
//
// The existing keeper address is taken from the KEEPER_ADDRESS env var if set,
// otherwise from the local hardhat-deploy artifact (deployments/<net>/).
//
// PRECONDITION: the deployer must be the keeper's owner() (approveContract is
// onlyOwner). It must also hold gas ETH on the target network.
//
// Usage:
//   KEEPER_ADDRESS=0x... npx hardhat run scripts/deploy_just_aggregator.js --network base_sepolia
//   KEEPER_ADDRESS=0x... npx hardhat run scripts/deploy_just_aggregator.js --network base
// -----------------------------------------------------------------------------
require("dotenv").config();
const hre = require("hardhat");
const { verifyContract } = require("../deploy/helpers");

// LINK token per network. The ETH aggregator still needs LINK for the 0-juel
// transferAndCall request rail, so this must match the LINK the operators/nodes use.
const LINK_TOKEN_ADDRESS = {
  base:         "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196", // Base mainnet LINK
  base_goerli:  "0xd886e2286fd1073df82462ea1822119600af80b6",
  base_sepolia: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
  development:  "0x0000000000000000000000000000000000000000",
  hardhat:      "0x0000000000000000000000000000000000000000",
  localhost:    "0x0000000000000000000000000000000000000000",
};

// Existing live ReputationKeeper per network (the one we reuse). Override with the
// KEEPER_ADDRESS env var if needed.
const KEEPER_ADDRESS_BY_NET = {
  base:         "0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0", // Base mainnet keeper
  base_sepolia: "0xE09821277D9af702F7910a57e85EaC6D83e4d794", // Base Sepolia keeper
};

async function main () {
  const { deployments, getNamedAccounts, ethers, network } = hre;
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();
  const signer       = await ethers.getSigner(deployer);

  /* ------------------------------------------------------------------ */
  /* 1. Locate the existing ReputationKeeper                            */
  /*    Precedence: KEEPER_ADDRESS env > per-network map > local artifact*/
  /* ------------------------------------------------------------------ */
  let keeperAddr = process.env.KEEPER_ADDRESS || KEEPER_ADDRESS_BY_NET[network.name];
  if (keeperAddr) {
    if (!ethers.isAddress(keeperAddr)) throw new Error(`Keeper address is not valid: ${keeperAddr}`);
  } else {
    const keeperInfo = await deployments.get("ReputationKeeper")
          .catch(() => { throw new Error("ReputationKeeper not found: set KEEPER_ADDRESS env or add it to KEEPER_ADDRESS_BY_NET"); });
    keeperAddr = keeperInfo.address;
  }
  const keeperCode = await ethers.provider.getCode(keeperAddr);
  if (keeperCode === "0x") throw new Error(`No contract code at keeper address ${keeperAddr} on ${network.name}`);
  console.log("Existing ReputationKeeper:", keeperAddr);

  /* ------------------------------------------------------------------ */
  /* 2. Deploy a new ReputationAggregator                               */
  /* ------------------------------------------------------------------ */
  const linkAddr = LINK_TOKEN_ADDRESS[network.name];
  if (!linkAddr) throw new Error(`No LINK token address for network ${network.name}`);

  // AggregatorLib holds the pure clustering/cid/hex helpers; link against it.
  const libRes = await deploy("AggregatorLib", {
    from: deployer,
    log:  true,
    skipIfAlreadyDeployed: false,
    deterministicDeployment: false
  });

  const aggRes = await deploy("ReputationAggregator", {
    from: deployer,
    args: [linkAddr, keeperAddr],   // LINK token and keeper addresses
    libraries: { AggregatorLib: libRes.address },
    log:  true,
    skipIfAlreadyDeployed: false,
    deterministicDeployment: false
  });
  const aggAddr = aggRes.address;
  console.log("New ReputationAggregator deployed:", aggAddr);

  // Auto-verify the library and the (library-linked) aggregator.
  if (libRes.newlyDeployed) {
    await verifyContract(
      libRes.address,
      [],
      "contracts/AggregatorLib.sol:AggregatorLib"
    );
  }
  if (aggRes.newlyDeployed) {
    await verifyContract(
      aggAddr,
      [linkAddr, keeperAddr],
      "contracts/ReputationAggregator.sol:ReputationAggregator",
      { "contracts/AggregatorLib.sol:AggregatorLib": libRes.address }
    );
  }

  /* ------------------------------------------------------------------ */
  /* 3. Approve the aggregator inside the keeper (if not yet approved)  */
  /* ------------------------------------------------------------------ */
  const keeper = await ethers.getContractAt("ReputationKeeper", keeperAddr, signer);
  const ownerOnKeeper = await keeper.owner();
  if (ownerOnKeeper.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${signer.address} is not the keeper owner ${ownerOnKeeper}; approveContract is onlyOwner.`
    );
  }
  const approved = await keeper.isContractApproved(aggAddr);
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

  //   6-4-3-2 commit-reveal layout:
  //   K = 6  total oracles polled in commit phase
  //   M = 4  first 4 commits advance to reveal
  //   N = 3  first 3 reveals are accepted for clustering
  //   P = 2  cluster size rewarded
  //
  console.log("Setting config (K,M,N,P,timeout) = (6,4,3,2,300)…");
  await (await aggregator.setConfig(6, 4, 3, 2, 300)).wait();

  // ETH ceiling: 0.0004 ETH (4e14 wei), the /125-scaled 0.05 LINK ceiling (docs section 4.6).
  // Must sit below any LINK-scale arbiter fee; enforced in selection via the clamp.
  console.log("Setting max oracle fee to 0.0004 ETH…");
  await (await aggregator.setMaxOracleFee(ethers.parseEther("0.0004"))).wait();

  console.log("Deployment and configuration complete!");
  console.log("ReputationAggregator:", aggAddr);
  console.log("Wired to ReputationKeeper:", keeperAddr);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });

