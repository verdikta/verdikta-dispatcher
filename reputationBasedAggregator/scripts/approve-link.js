#!/usr/bin/env node
// Usage: node scripts/approve-link.js 0.5
// Reads HARDHAT_NETWORK + LINK token address from .env

const path = require("path");
// Load .env from project root (one level up from /scripts)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Default the network if not set in .env
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "base_sepolia";

const hre = require("hardhat");
const { ethers, deployments, network } = hre;

(async () => {
  try {
    const net = network.name; // "base" or "base_sepolia"

    // ---- Resolve LINK token from .env (per-network, with optional generic fallback)
    const LINK =
      process.env.LINK_TOKEN ||
      (net === "base"
        ? process.env.LINK_TOKEN_BASE
        : net === "base_sepolia"
        ? process.env.LINK_TOKEN_BASE_SEPOLIA
        : undefined);

    if (!LINK) {
      throw new Error(
        `Missing LINK token address for ${net}. Set LINK_TOKEN or LINK_TOKEN_BASE(_SEPOLIA) in .env`
      );
    }

    // Amount from CLI in LINK (18 decimals)
    const amountStr = process.argv[2] || "0";
    const AMOUNT = ethers.parseUnits(amountStr, 18);

    // ---- Resolve Aggregator from hardhat-deploy artifacts (fallback to env)
    let AGGREGATOR;
    try {
      const agg = await deployments.get("ReputationAggregator");
      AGGREGATOR = agg.address;
    } catch {
      AGGREGATOR =
        process.env.AGGREGATOR ||
        (net === "base" ? process.env.AGGREGATOR_BASE : process.env.AGGREGATOR_BASE_SEPOLIA);
      if (!AGGREGATOR) {
        throw new Error(
          "ReputationAggregator not found in deployments; set AGGREGATOR(_BASE|_BASE_SEPOLIA) in .env"
        );
      }
    }

    const [signer] = await ethers.getSigners();
    const abi = (await hre.artifacts.readArtifact("LinkTokenInterface")).abi;
    const link = new ethers.Contract(LINK, abi, signer);

    console.log(`Network    : ${net}`);
    console.log(`LINK       : ${LINK}`);
    console.log(`Aggregator : ${AGGREGATOR}`);
    console.log(`Approving  : ${amountStr} LINK`);

    const tx = await link.approve(AGGREGATOR, AMOUNT);
    console.log("approve tx :", tx.hash);

    const CONFIRMATIONS = net === "base" || net === "base_sepolia" ? 2 : 1;
    await tx.wait(CONFIRMATIONS);

    console.log("Approved successfully.");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

