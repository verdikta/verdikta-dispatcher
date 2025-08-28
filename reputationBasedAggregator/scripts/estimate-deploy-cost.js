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

async function estimate(factoryName, constructorArgs = []) {
  const [deployer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory(factoryName, deployer);

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

  const tokenAddr = process.env.WRAPPED_VERDIKTA_TOKEN_BASE && net === "base"
    ? process.env.WRAPPED_VERDIKTA_TOKEN_BASE
    : process.env.WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA;

  if (!tokenAddr) throw new Error(`Missing WRAPPED_VERDIKTA_TOKEN for ${net}`);

  // 1. Aggregator (LINK + placeholder keeper)
  const agg = await estimate("ReputationAggregator", [linkAddr, ethers.ZeroAddress]);

  // 2. Keeper (wrapped Verdikta token)
  const kep = await estimate("ReputationKeeper", [tokenAddr]);

  const sum = (a, b) => (parseFloat(a) + parseFloat(b)).toFixed(6);

  console.log("Aggregator:", agg);
  console.log("Keeper    :", kep);
  console.log("TOTAL     :", {
    totalEthBoth: sum(agg.totalEth, kep.totalEth),
    l1EthBoth:    sum(agg.l1FeeEth, kep.l1FeeEth),
    l2EthBoth:    sum(agg.l2FeeEth, kep.l2FeeEth),
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

