#!/usr/bin/env node
/*
  scripts/unregister-oracle-cl.js  – Hardhat version

  Deregisters one or more oracle identities (oracle address + jobID) and
  automatically reclaims the 100‑wVDKA stake for each. All contract addresses
  are supplied via CLI flags – same UX as the original Truffle script.

  Example:
    npx hardhat run scripts/unregister-oracle-cl.js --network base_sepolia \
      --aggregator     0x59067815e006e245449E1A24a1091dF176b3CF09 \
      --oracle         0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101 \
      --wrappedverdikta 0x6bF578606493b03026473F838bCD3e3b5bBa5515 \
      --jobids "38f19572c51041baa5f2dea284614590" "39515f75ac2947beb7f2eeae4d8eaf3e"
*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------------- */
/* Minimal ABIs                                                              */
/* ------------------------------------------------------------------------- */
const AggregatorABI = [
  { inputs: [], name: "reputationKeeper", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getContractConfig", outputs: [
      { name: "oracleAddr", type: "address" },
      { name: "linkAddr",   type: "address" },
      { name: "jobId",      type: "bytes32"  },
      { name: "fee",        type: "uint256"  }
    ], stateMutability: "view", type: "function" }
];

const ReputationKeeperABI = [
  { inputs: [ { name: "_oracle", type: "address" }, { name: "_jobId", type: "bytes32" } ], name: "deregisterOracle", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [ { name: "_oracle", type: "address" }, { name: "_jobId", type: "bytes32" } ], name: "getOracleInfo", outputs: [
      { name: "isActive",     type: "bool"    },
      { name: "qualityScore", type: "int256"  },
      { name: "timelinessScore",type: "int256" },
      { name: "callCount",    type: "uint256" },
      { name: "jobId",        type: "bytes32" },
      { name: "fee",          type: "uint256" },
      { name: "stakeAmount",  type: "uint256" },
      { name: "lockedUntil",  type: "uint256" },
      { name: "blocked",      type: "bool"    }
    ], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }
];

const ERC20_BALANCE_ABI = [
  { constant: true, inputs: [ { name: "", type: "address" } ], name: "balanceOf", outputs: [ { type: "uint256" } ], stateMutability: "view", type: "function" }
];

const minimalOwnerABI = [
  { constant: true, inputs: [], name: "owner", outputs: [ { type: "address" } ], stateMutability: "view", type: "function" }
];

/* Helper */
const toBytes32 = (txt) => ethers.hexlify(ethers.toUtf8Bytes(txt)).padEnd(66, "0");

/* ------------------------------------------------------------------------- */
/* Main                                                                      */
/* ------------------------------------------------------------------------- */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator",     { alias: "a", type: "string", describe: "ReputationAggregator address", demandOption: true })
      .option("oracle",         { alias: "o", type: "string", describe: "Oracle contract address",       demandOption: true })
      .option("wrappedverdikta",{ alias: "w", type: "string", describe: "WrappedVerdiktaToken address",  demandOption: true })
      .option("jobids",         { alias: "j", type: "array",  describe: "Job ID strings",               demandOption: true })
      .strict()
      .argv;

    const provider = ethers.provider;
    const [signer] = await ethers.getSigners();
    const caller = await signer.getAddress();
    console.log("Caller:", caller);

    /* ------------------------------------------------------------------- */
    /* Resolve keeper address                                              */
    /* ------------------------------------------------------------------- */
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);
    const keeper = new ethers.Contract(keeperAddr, ReputationKeeperABI, signer);

    /* ------------------------------------------------------------------- */
    /* Authorization check                                                */
    /* ------------------------------------------------------------------- */
    const [oracleOwner, keeperOwner] = await Promise.all([
      new ethers.Contract(argv.oracle, minimalOwnerABI, provider).owner(),
      keeper.owner(),
    ]);
    if (caller.toLowerCase() !== oracleOwner.toLowerCase() && caller.toLowerCase() !== keeperOwner.toLowerCase()) {
      throw new Error("Caller must be oracle owner or ReputationKeeper owner");
    }

    /* ------------------------------------------------------------------- */
    /* Check initial wVDKA balance                                         */
    /* ------------------------------------------------------------------- */
    const verdikta = new ethers.Contract(argv.wrappedverdikta, ERC20_BALANCE_ABI, provider);
    const balBefore = await verdikta.balanceOf(caller);
    console.log("Initial wVDKA balance:", ethers.formatEther(balBefore));

    /* ------------------------------------------------------------------- */
    /* Iterate job IDs                                                    */
    /* ------------------------------------------------------------------- */
    for (const jobStr of argv.jobids) {
      const jobId = toBytes32(jobStr);
      console.log(`\nJobID ${jobStr} → ${jobId}`);
      const info = await keeper.getOracleInfo(argv.oracle, jobId);
      if (!info.isActive) {
        console.log("Not registered – skipping");
        continue;
      }
      console.log("Calling deregisterOracle…");
      const tx = await keeper.deregisterOracle(argv.oracle, jobId);
      await tx.wait();
      console.log("✓ Deregistered (tx:", tx.hash, ")");
    }

    /* ------------------------------------------------------------------- */
    /* Check final balance                                                */
    /* ------------------------------------------------------------------- */
    const balAfter = await verdikta.balanceOf(caller);
    console.log("Final wVDKA balance:", ethers.formatEther(balAfter));

    console.log("\nOracle deregistration completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle deregistration:", err);
    process.exit(1);
  }
})();

