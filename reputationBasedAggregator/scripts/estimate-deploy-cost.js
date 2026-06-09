// scripts/estimate-deploy-cost.js
// run this way: npx hardhat run scripts/estimate-deploy-cost.js
//
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const hre = require("hardhat");
const { ethers } = hre;

// OP Stack GasPriceOracle (for L1 fee estimation)
const ORACLE_ABI = [
  "function getL1Fee(bytes) view returns (uint256)",
  "function getL1FeeUpperBound(bytes) view returns (uint256)"
];
const ORACLE_ADDR = "0x420000000000000000000000000000000000000F";

async function estimate(factoryName, constructorArgs = [], libraries = undefined) {
  const [deployer] = await ethers.getSigners();
  const Factory = libraries
    ? await ethers.getContractFactory(factoryName, { signer: deployer, libraries })
    : await ethers.getContractFactory(factoryName, deployer);

  // Prepare the deploy tx
  const unsigned = await Factory.getDeployTransaction(...constructorArgs);
  const data = unsigned.data;

  // L2 execution cost
  const gasLimit = await ethers.provider.estimateGas({ ...unsigned, from: deployer.address });
  const feeData  = await ethers.provider.getFeeData();
  const l2FeeWei = gasLimit * (feeData.maxFeePerGas ?? feeData.gasPrice);

  // L1 data cost
  const oracle = new ethers.Contract(ORACLE_ADDR, ORACLE_ABI, ethers.provider);
  let l1FeeWei;
  try {
    l1FeeWei = await oracle.getL1Fee(data);
  } catch {
    l1FeeWei = oracle.getL1FeeUpperBound ? await oracle.getL1FeeUpperBound(data) : 0n;
  }

  const totalWei = l2FeeWei + l1FeeWei;
  return {
    gasLimit: gasLimit.toString(),
    l2FeeEth: ethers.formatEther(l2FeeWei),
    l1FeeEth: ethers.formatEther(l1FeeWei),
    totalEth: ethers.formatEther(totalWei),
  };
}

async function main() {
  const net = hre.network.name;
  console.log("=== Estimating deploy costs on:", net, "===");

  // Get constructor args based on network (matches your deploy scripts)
  const LINK_MAP = {
    base:         "0xd886e2286fd1073df82462ea1822119600af80b6",
    base_sepolia: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
  };
  const linkAddr = LINK_MAP[net];
  if (!linkAddr) throw new Error(`No LINK token address for ${net}`);

  const tokenAddr = (net === "base"
    ? process.env.WRAPPED_VERDIKTA_TOKEN_BASE
    : process.env.WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA) || null;

  // 0. AggregatorLib (no constructor args) — the aggregator links against it.
  const lib = await estimate("AggregatorLib", []);

  // 1. Aggregator (LINK + placeholder keeper), linked to a placeholder library address.
  //    The constructor never calls the library, so the linked address does not affect
  //    deploy gas — any valid 20-byte address works for the estimate.
  const LIB_PLACEHOLDER = "0x" + "11".repeat(20);
  const agg = await estimate("ReputationAggregator", [linkAddr, ethers.ZeroAddress], {
    "contracts/AggregatorLib.sol:AggregatorLib": LIB_PLACEHOLDER,
  });

  // 2. Keeper (wrapped Verdikta token) — OPT-IN only. The reuse-keeper deploy
  //    (deploy_just_aggregator.js) does NOT redeploy the keeper, so by default we estimate
  //    just the lib + aggregator. Set ESTIMATE_KEEPER=1 to also estimate a fresh keeper.
  const estimateKeeper = !!process.env.ESTIMATE_KEEPER;
  if (estimateKeeper && !tokenAddr) {
    throw new Error(`ESTIMATE_KEEPER set but no WRAPPED_VERDIKTA_TOKEN for ${net}`);
  }
  const kep = estimateKeeper ? await estimate("ReputationKeeper", [tokenAddr]) : null;

  const sum = (...xs) => xs.reduce((a, b) => a + parseFloat(b), 0).toFixed(6);

  console.log("AggregatorLib:", lib);
  console.log("Aggregator   :", agg);
  console.log("TOTAL (this deploy: lib + aggregator):", {
    totalEth: sum(lib.totalEth, agg.totalEth),
    l1Eth:    sum(lib.l1FeeEth, agg.l1FeeEth),
    l2Eth:    sum(lib.l2FeeEth, agg.l2FeeEth),
  });

  if (kep) {
    console.log("Keeper       :", kep);
    console.log("TOTAL (full: lib + aggregator + keeper):", {
      totalEth: sum(lib.totalEth, agg.totalEth, kep.totalEth),
      l1Eth:    sum(lib.l1FeeEth, agg.l1FeeEth, kep.l1FeeEth),
      l2Eth:    sum(lib.l2FeeEth, agg.l2FeeEth, kep.l2FeeEth),
    });
  } else {
    console.log("Keeper       : skipped (reuse-keeper deploy doesn't redeploy it; set ESTIMATE_KEEPER=1 to include)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

