#!/usr/bin/env node
/*
  scripts/unregister-oracle-by-class-cl.js – Hardhat + ethers

  Finds all oracles registered in a ReputationKeeper that support a given
  capability class, then deregisters them.

  The wVDKA token address is resolved automatically from the on-chain
  aggregator → keeper → verdiktaToken chain.

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/unregister-oracle-by-class-cl.js \
  --aggregator 0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089 \
  --class      4040

  Add --dry-run to preview without actually deregistering.

HARDHAT_NETWORK=base \
node scripts/unregister-oracle-by-class-cl.js \
  --aggregator 0x2f7a02298D4478213057edA5e5bEB07F20c4c054 \
  --class      129

*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const readline = require("readline");

/* ────────────────────────── Minimal ABIs ──────────────────────────── */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)",
];

const KeeperABI = [
  "function registeredOracles(uint256) view returns (address oracle, bytes32 jobId)",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256,uint256,bool)",
  "function getOracleClassesByKey(address,bytes32) view returns (uint64[])",
  "function deregisterOracle(address,bytes32)",
  "function owner() view returns (address)",
  "function verdiktaToken() view returns (address)",
];

const ERC20_BALANCE = [
  "function balanceOf(address) view returns (uint256)",
];

const OWNER_ABI = [
  "function owner() view returns (address)",
];

/* ─────── helper: return owner(addr) if present, else addr itself ───── */
async function getOwnerOrSelf(addr, provider) {
  const code = await provider.getCode(addr);
  if (code === "0x") {
    return addr.toLowerCase(); // EOA
  }
  try {
    const owner = await new ethers.Contract(addr, OWNER_ABI, provider).owner();
    return owner.toLowerCase();
  } catch {
    return addr.toLowerCase();
  }
}

/* ─────── helper: prompt for confirmation ───── */
async function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/* ─────── helper: get balances for multiple addresses ───── */
async function getBalances(verdikta, addresses) {
  const balances = {};
  for (const addr of addresses) {
    balances[addr.toLowerCase()] = await verdikta.balanceOf(addr);
  }
  return balances;
}

/* ─────── helper: print balance comparison ───── */
function printBalanceComparison(label, address, before, after) {
  const diff = after - before;
  const sign = diff >= 0n ? "+" : "";
  console.log(`  ${label} (${address}):`);
  console.log(`    Before: ${ethers.formatEther(before)} wVDKA`);
  console.log(`    After:  ${ethers.formatEther(after)} wVDKA`);
  console.log(`    Change: ${sign}${ethers.formatEther(diff)} wVDKA`);
}

/* ───────────────────────────── Main ───────────────────────────────── */
(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", {
        alias: "a",
        type: "string",
        describe: "ReputationAggregator contract address",
        demandOption: true,
      })
      .option("class", {
        alias: "c",
        type: "number",
        describe: "Capability class ID to filter and unregister",
        demandOption: true,
      })
      .option("dry-run", {
        alias: "d",
        type: "boolean",
        describe: "Preview matches without deregistering",
        default: false,
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        describe: "Skip confirmation prompt",
        default: false,
      })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const caller = await signer.getAddress();
    console.log("Caller:", caller);

    /* Find ReputationKeeper */
    console.log(`\nLooking up ReputationKeeper from Aggregator at: ${argv.aggregator}`);
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, signer);
    const keeperAddr = await aggregator.reputationKeeper();
    console.log(`Found ReputationKeeper at: ${keeperAddr}`);

    const keeper = new ethers.Contract(keeperAddr, KeeperABI, signer);
    const keeperOwner = (await keeper.owner()).toLowerCase();
    console.log(`ReputationKeeper owner: ${keeperOwner}`);

    const verdiktaTokenAddr = await keeper.verdiktaToken();
    console.log(`Verdikta token (wVDKA): ${verdiktaTokenAddr}`);

    /* Scan for oracles matching the specified class */
    console.log(`\nScanning for oracles with capability class ${argv.class}...`);
    const matchingOracles = [];

    for (let i = 0; i < 100; i++) {
      try {
        const { oracle, jobId } = await keeper.registeredOracles(i);
        if (oracle !== ethers.ZeroAddress) {
          const info = await keeper.getOracleInfo(oracle, jobId);
          if (!info.isActive) continue;

          let classes = [];
          try {
            classes = await keeper.getOracleClassesByKey(oracle, jobId);
          } catch (_) {}

          const hasClass = classes.some((c) => Number(c) === argv.class);
          if (hasClass) {
            const oracleOwner = await getOwnerOrSelf(oracle, signer.provider);
            matchingOracles.push({ oracle, jobId, classes, oracleOwner });
          }
        }
      } catch (_) {
        break; // out-of-bounds
      }
    }

    if (!matchingOracles.length) {
      console.log(`\nNo active oracles found with class ${argv.class}.`);
      process.exit(0);
    }

    /* Display matches */
    console.log(`\nFound ${matchingOracles.length} oracle(s) with class ${argv.class}:\n`);
    for (let i = 0; i < matchingOracles.length; i++) {
      const { oracle, jobId, classes, oracleOwner } = matchingOracles[i];
      let printableJobId;
      try {
        printableJobId = ethers.decodeBytes32String(jobId);
      } catch (_) {
        printableJobId = jobId;
      }
      console.log(`  ${i + 1}. Oracle: ${oracle}`);
      console.log(`     JobID:  ${printableJobId}`);
      console.log(`     Classes: ${classes.join(", ")}`);
      console.log(`     Owner:  ${oracleOwner}`);
    }

    if (argv.dryRun) {
      console.log("\n[DRY RUN] No oracles were deregistered.");
      process.exit(0);
    }

    /* Authorisation check */
    const canDeregister = matchingOracles.filter(
      ({ oracleOwner }) =>
        caller.toLowerCase() === oracleOwner || caller.toLowerCase() === keeperOwner
    );

    if (canDeregister.length === 0) {
      console.error(
        "\nCaller is not authorised to deregister any of these oracles.\n" +
          "You must be the oracle owner or the ReputationKeeper owner."
      );
      process.exit(1);
    }

    if (canDeregister.length < matchingOracles.length) {
      console.log(
        `\nNote: Caller can only deregister ${canDeregister.length} of ${matchingOracles.length} oracles.`
      );
    }

    /* Confirmation */
    if (!argv.yes) {
      const proceed = await confirm(
        `\nProceed with deregistering ${canDeregister.length} oracle(s)? [y/N] `
      );
      if (!proceed) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    /* Collect unique addresses to track */
    const uniqueOracleOwners = [...new Set(canDeregister.map(o => o.oracleOwner))];
    const addressesToTrack = new Set([
      caller.toLowerCase(),
      keeperOwner,
      ...uniqueOracleOwners,
    ]);

    /* wVDKA balances before */
    const verdikta = new ethers.Contract(verdiktaTokenAddr, ERC20_BALANCE, signer);
    const balancesBefore = await getBalances(verdikta, [...addressesToTrack]);

    console.log("\n--- Initial wVDKA Balances ---");
    console.log(`  Caller (${caller}): ${ethers.formatEther(balancesBefore[caller.toLowerCase()])}`);
    console.log(`  Keeper Owner (${keeperOwner}): ${ethers.formatEther(balancesBefore[keeperOwner])}`);
    for (const owner of uniqueOracleOwners) {
      if (owner !== caller.toLowerCase() && owner !== keeperOwner) {
        console.log(`  Oracle Owner (${owner}): ${ethers.formatEther(balancesBefore[owner])}`);
      }
    }

    /* Deregister each oracle */
    let successCount = 0;
    for (const { oracle, jobId } of canDeregister) {
      let printableJobId;
      try {
        printableJobId = ethers.decodeBytes32String(jobId);
      } catch (_) {
        printableJobId = jobId;
      }
      console.log(`\nDeregistering ${oracle} (jobId: ${printableJobId})...`);

      try {
        const tx = await keeper.deregisterOracle(oracle, jobId);
        await tx.wait();
        console.log(`  ✓ Deregistered (tx: ${tx.hash})`);
        successCount++;
      } catch (err) {
        let msg = err.message;
        if (err.data) {
          try {
            const parsed = keeper.interface.parseError(err.data);
            if (parsed) {
              const args = parsed.args.length ? `(${parsed.args.join(", ")})` : "";
              msg = parsed.name + args;
            }
          } catch {}
        }
        if (!msg && err.reason) msg = err.reason;
        console.error(`  ✗ Failed: ${msg}`);
      }
    }

    /* wVDKA balances after */
    const balancesAfter = await getBalances(verdikta, [...addressesToTrack]);

    console.log("\n--- Final wVDKA Balance Summary ---");
    printBalanceComparison("Caller", caller, balancesBefore[caller.toLowerCase()], balancesAfter[caller.toLowerCase()]);
    
    if (keeperOwner !== caller.toLowerCase()) {
      printBalanceComparison("Keeper Owner", keeperOwner, balancesBefore[keeperOwner], balancesAfter[keeperOwner]);
    }
    
    for (const owner of uniqueOracleOwners) {
      if (owner !== caller.toLowerCase() && owner !== keeperOwner) {
        printBalanceComparison("Oracle Owner", owner, balancesBefore[owner], balancesAfter[owner]);
      }
    }

    console.log(`\nDeregistered ${successCount}/${canDeregister.length} oracle(s).`);

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();

