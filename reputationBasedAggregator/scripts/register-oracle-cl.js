#!/usr/bin/env node
/*
  scripts/register-oracle-cl.js  – Hardhat version

  Registers one or more job IDs for a given oracle address. All contract
  addresses are supplied via CLI flags (same UX as the original Truffle
  script).  Uses minimal ABIs and Hardhat's ethers provider.

  Example – two job IDs, two capability classes:
    npx hardhat run scripts/register-oracle-cl.js --network base_sepolia \
      --aggregator     0x59067815e006e245449E1A24a1091dF176b3CF09 \
      --link           0xE4aB69C077896252FAFBD49EFD26B5D171A32410 \
      --oracle         0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101 \
      --wrappedverdikta 0x6bF578606493b03026473F838bCD3e3b5bBa5515 \
      --jobids "38f19572c51041baa5f2dea284614590" "39515f75ac2947beb7f2eeae4d8eaf3e" \
      --classes 128 129
*/

require("dotenv").config();
const hre   = require("hardhat");
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
  { inputs: [
      { name: "_oracle",   type: "address"  },
      { name: "_jobId",    type: "bytes32"  },
      { name: "fee",       type: "uint256"  },
      { name: "_classes",  type: "uint64[]" }
    ], name: "registerOracle", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [ { name: "_oracle", type: "address" }, { name: "_jobId", type: "bytes32" } ],
    name: "getOracleInfo", outputs: [
      { name: "isActive",        type: "bool"    },
      { name: "qualityScore",    type: "int256"  },
      { name: "timelinessScore", type: "int256"  },
      { name: "callCount",       type: "uint256" },
      { name: "jobId",           type: "bytes32" },
      { name: "fee",             type: "uint256" },
      { name: "stakeAmount",     type: "uint256" },
      { name: "lockedUntil",     type: "uint256" },
      { name: "blocked",         type: "bool"    }
    ], stateMutability: "view", type: "function" }
];

const ERC20ABI = [
  { constant: true,  inputs: [ { name: "", type: "address" } ], name: "balanceOf", outputs: [ { type: "uint256" } ], stateMutability: "view", type: "function" },
  { constant: true,  inputs: [ { name: "", type: "address" }, { name: "", type: "address" } ], name: "allowance", outputs: [ { type: "uint256" } ], stateMutability: "view", type: "function" },
  { constant: false, inputs: [ { name: "spender", type: "address" }, { name: "amount", type: "uint256" } ], name: "approve", outputs: [ { type: "bool" } ], stateMutability: "nonpayable", type: "function" }
];

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */
const toBytes32 = (txt) => {
  const bytes = ethers.toUtf8Bytes(txt);
  if (bytes.length > 32) throw new Error(`Job ID string too long: ${txt}`);
  return ethers.hexlify(bytes).padEnd(66, "0"); // 0x + 64 hex chars
};

/* ------------------------------------------------------------------------- */
/* Main                                                                      */
/* ------------------------------------------------------------------------- */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator",     { alias: "a", type: "string", describe: "ReputationAggregator address", demandOption: true })
      .option("link",           { alias: "l", type: "string", describe: "LINK token address",             demandOption: true })
      .option("oracle",         { alias: "o", type: "string", describe: "Oracle contract address",         demandOption: true })
      .option("wrappedverdikta",{ alias: "w", type: "string", describe: "WrappedVerdiktaToken address",    demandOption: true })
      .option("jobids",         { alias: "j", type: "array",  describe: "Job ID strings",                 demandOption: true })
      .option("classes",        { alias: "c", type: "array",  describe: "Capability classes",             demandOption: true })
      .strict()
      .argv;

    /* ------------------------------------------------------------------- */
    /* Setup signer & provider                                             */
    /* ------------------------------------------------------------------- */
    const [signer] = await ethers.getSigners();
    const owner    = await signer.getAddress();
    console.log("Using owner account:", owner);

    /* ------------------------------------------------------------------- */
    /* Contract instances                                                  */
    /* ------------------------------------------------------------------- */
    const provider   = ethers.provider;
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper          = new ethers.Contract(keeperAddr, ReputationKeeperABI, signer);
    const wrappedVerdikta = new ethers.Contract(argv.wrappedverdikta, ERC20ABI, signer);
    const linkToken       = new ethers.Contract(argv.link,           ERC20ABI, signer);

    const oracleAddr = argv.oracle;
    const classes    = argv.classes.map(Number);

    /* ------------------------------------------------------------------- */
    /* Constants (fee & stake)                                             */
    /* ------------------------------------------------------------------- */
    const linkFee  = ethers.parseUnits("0.05", 18);   // 0.05 LINK
    const vdkaStake= ethers.parseUnits("100", 18);    // 100 wVDKA

    /* ------------------------------------------------------------------- */
    /* Ensure wVDKA allowance                                              */
    /* ------------------------------------------------------------------- */
    const vdkaBal = await wrappedVerdikta.balanceOf(owner);
    if (vdkaBal < vdkaStake) throw new Error("Insufficient wVDKA balance for staking");

    let vdkaAllowance = await wrappedVerdikta.allowance(owner, keeperAddr);
    if (vdkaAllowance < vdkaStake) {
      console.log("Approving keeper to spend wVDKA…");
      const tx = await wrappedVerdikta.approve(keeperAddr, vdkaStake);
      await tx.wait();
    }

    /* ------------------------------------------------------------------- */
    /* Iterate over job IDs                                                */
    /* ------------------------------------------------------------------- */
    for (const jobStr of argv.jobids) {
      const jobId = toBytes32(jobStr);
      console.log(`\nProcessing jobID ${jobStr} → ${jobId}`);

      const info = await keeper.getOracleInfo(oracleAddr, jobId);
      if (info.isActive) {
        console.log("Already registered – skipping registerOracle, ensuring LINK approval");
      } else {
        console.log("Calling registerOracle…");
        const tx = await keeper.registerOracle(oracleAddr, jobId, linkFee, classes);
        await tx.wait();
        console.log("Oracle registered.");
      }
    }

    /* ------------------------------------------------------------------- */
    /* Ensure LINK approval for aggregator                                 */
    /* ------------------------------------------------------------------- */
    const cfg = await aggregator.getContractConfig();
    const linkAllowance = await linkToken.allowance(owner, argv.aggregator);
    if (linkAllowance < linkFee) {
      console.log("Approving LINK for aggregator…");
      const tx = await linkToken.approve(argv.aggregator, linkFee);
      await tx.wait();
    }

    console.log("\nSetup completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle registration:", err);
    process.exit(1);
  }
})();

