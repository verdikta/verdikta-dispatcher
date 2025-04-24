#!/usr/bin/env node
//
// -------------------------------------------------------------
// Spin up a Hardhat node that *forks Base Sepolia* using Infura.
//
// Prerequisite (.env):
//   INFURA_API_KEY=your_key_here
//
// Usage (no args):
//   ./scripts/fork-base-sepolia.js
//
// The node listens on the default Hardhat port (8545) and uses
// Base Sepolia’s chain ID (84532). Stop it with Ctrl‑C.
// -------------------------------------------------------------

require("dotenv").config();
const { spawn } = require("child_process");

// ---------- 0. ENV checks ----------
const INFURA_API_KEY = process.env.INFURA_API_KEY;
if (!INFURA_API_KEY) {
  console.error("❌  INFURA_API_KEY is missing in .env");
  process.exit(1);
}

// ---------- 1. Build fork URL ----------
const FORK_URL = `https://base-sepolia.infura.io/v3/${INFURA_API_KEY}`;

// ---------- 2. Hardhat‑node CLI args ----------
const hhArgs = [
  "hardhat",
  "node",
  "--fork",
  FORK_URL,
  "--chain-id",
  "84532", // Base Sepolia
  // Optional: uncomment to silence Hardhat's banner
  // "--quiet"
];

// ---------- 3. Spawn node ----------
console.log("Starting Hardhat node fork for Base Sepolia…");
console.log(`Forking from: ${FORK_URL}\n`);

const hhNode = spawn("npx", hhArgs, { stdio: "inherit" });

// ---------- 4. Handle exit ----------
hhNode.on("close", (code) => {
  console.log(`Hardhat node exited with code ${code}`);
});

