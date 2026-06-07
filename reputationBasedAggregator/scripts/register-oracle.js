#!/usr/bin/env node
/*
  scripts/register-oracle.js – Hardhat + ethers

  Registers an arbiter (oracle) on the live ReputationKeeper, staking wVDKA.
  ETH-funded edition: the per-oracle `fee` is denominated in ETH wei and must sit
  at or below the ETH aggregator's maxOracleFee (0.0004 ETH) to be selectable.

  Run:
    npx hardhat run scripts/register-oracle.js --network base_sepolia
    npx hardhat run scripts/register-oracle.js --network base

  Overridable via env: ORACLE_ADDR, FEE (ether units), KEEPER_ADDRESS, VDKA_ADDRESS.
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers, deployments } = hre;

/* ~~~~~~~~~~~~~~~~~~~~~~~~~~~ EDIT THESE ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ */
const ORACLE_ADDR = process.env.ORACLE_ADDR || "0xcD98fbbeEF2234e6AaA7E0eA0895f14BeB06b4aD";
const JOB_IDS = [
  "0857f1e5efb14a96a2bb26b7c8995d80",
  "effe38857bec4ece8d5d970547250458"
];
// ETH-scale per-oracle fee (must be <= aggregator maxOracleFee = 0.0004 ETH).
const FEE        = process.env.FEE ? ethers.parseEther(process.env.FEE) : ethers.parseEther("0.0001"); // 0.0001 ETH
const VDKA_STAKE = ethers.parseUnits("100", 18);   // 100 wVDKA per job
/* --------------------------------------------------------------------- */

// Live contracts per network (override with env if needed).
const KEEPER_BY_NET = {
  base:         "0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0",
  base_sepolia: "0xE09821277D9af702F7910a57e85EaC6D83e4d794",
};
const VDKA_BY_NET = {
  base:         "0x1EA68D018a11236E07D5647175DAA8ca1C3D0280",
  base_sepolia: "0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1",
};

async function resolveKeeper() {
  const fromEnvOrMap = process.env.KEEPER_ADDRESS || KEEPER_BY_NET[hre.network.name];
  if (fromEnvOrMap) {
    if (!ethers.isAddress(fromEnvOrMap)) throw new Error(`Bad keeper address: ${fromEnvOrMap}`);
    return fromEnvOrMap;
  }
  return (await deployments.get("ReputationKeeper")).address;
}

async function resolveVdkta() {
  const fromEnvOrMap =
    process.env.VDKA_ADDRESS ||
    process.env[hre.network.name === "base" ? "WRAPPED_VERDIKTA_TOKEN_BASE" : "WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA"] ||
    VDKA_BY_NET[hre.network.name];
  if (fromEnvOrMap && ethers.isAddress(fromEnvOrMap)) return fromEnvOrMap;
  return (await deployments.get("WrappedVerdiktaToken")).address;
}

(async () => {
  try {
    console.log(`Registering arbiter on ${hre.network.name}…\n`);
    const [signer] = await ethers.getSigners();
    if (!signer) throw new Error("No signer — set PRIVATE_KEY");
    const owner = await signer.getAddress();
    console.log("Owner (registrant):", owner);
    console.log("Oracle:", ORACLE_ADDR);
    console.log("Fee (wei / ETH):", FEE.toString(), "/", ethers.formatEther(FEE));

    const keeperAddr = await resolveKeeper();
    const vdkaAddr   = await resolveVdkta();
    console.log("Keeper:", keeperAddr, "\nwVDKA :", vdkaAddr, "\n");

    const keeperAbi = (await hre.artifacts.readArtifact("ReputationKeeper")).abi;
    const keeper = new ethers.Contract(keeperAddr, keeperAbi, signer);
    const verdikta = new ethers.Contract(vdkaAddr, [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], signer);

    /* Approve total stake once */
    const totalStake = VDKA_STAKE * BigInt(JOB_IDS.length);
    if ((await verdikta.balanceOf(owner)) < totalStake) throw new Error("Insufficient wVDKA balance");
    if ((await verdikta.allowance(owner, keeperAddr)) < totalStake) {
      console.log(`Approving ${ethers.formatEther(totalStake)} wVDKA for keeper…`);
      await (await verdikta.approve(keeperAddr, totalStake)).wait();
    }

    /* Register each job ID */
    let idx = 0;
    for (const jobStr of JOB_IDS) {
      idx++;
      const jobId = ethers.hexlify(ethers.toUtf8Bytes(jobStr)).padEnd(66, "0");
      console.log(`\nJob ${idx}: ${jobStr} → ${jobId}`);

      const info = await keeper.getOracleInfo(ORACLE_ADDR, jobId);
      if (info.isActive) { console.log("Already registered – skipping"); continue; }

      const classes = [128, 717, 717 + idx];   // example classes
      console.log("Calling registerOracle…", classes);
      await (await keeper.registerOracle(ORACLE_ADDR, jobId, FEE, classes)).wait();
      console.log("✓ Registered");
    }

    console.log("\nRegistration completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle registration:", err.shortMessage || err.message || err);
    process.exit(1);
  }
})();
