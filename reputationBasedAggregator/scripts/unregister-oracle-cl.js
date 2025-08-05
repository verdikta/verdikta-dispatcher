#!/usr/bin/env node
/*
  scripts/unregister-oracle-cl.js – Hardhat + ethers

  Removes an oracle from a ReputationKeeper even when the --oracle address
  is just the Chainlink node’s EOA (i.e. no byte-code, no owner()).

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/unregister-oracle-cl.js \
  --aggregator      0x262f48f06DEf1FE49e0568dB4234a3478A191cFd \
  --oracle          0x00A08b75178de0e0d7FF13Fdd4ef925AC3572503 \
  --wrappedverdikta 0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3 \
  --jobids          "38f19572c51041baa5f2dea284614590" \
                    "39515f75ac2947beb7f2eeae4d8eaf3e"
*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ────────────────────────── Minimal ABIs ──────────────────────────── */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)"
];

const KeeperABI = [
  "function deregisterOracle(address,bytes32)",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256,uint256,bool)",
  "function owner() view returns (address)"
];

const ERC20_BALANCE = [
  "function balanceOf(address) view returns (uint256)"
];

const OWNER_ABI = [
  "function owner() view returns (address)"
];

/* ───────────── helper: bytes32 or ascii jobId → bytes32 ───────────── */
const toBytes32 = (id) => {
  if (/^0x[0-9a-f]{64}$/i.test(id)) return id;        // already bytes32
  const bytes = ethers.toUtf8Bytes(id);
  if (bytes.length > 32) throw new Error(`Job ID too long: ${id}`);
  return ethers.hexlify(bytes).padEnd(66, "0");
};

/* ─────── helper: return owner(addr) if present, else addr itself ───── */
async function getOwnerOrSelf(addr, provider, signer) {
  const code = await provider.getCode(addr);
  if (code === "0x") {
    console.warn(
      `${addr} has no byte-code (EOA?) – treating it as self-owned`
    );
    return addr.toLowerCase();
  }
  try {
    const owner = await new ethers.Contract(addr, OWNER_ABI, signer).owner();
    return owner.toLowerCase();
  } catch {
    console.warn(
      `${addr} has byte-code but no owner() – treating it as self-owned`
    );
    return addr.toLowerCase();
  }
}

/* ───────────────────────────── Main ───────────────────────────────── */
(async () => {
  try {
    /* CLI args */
    const argv = yargs(hideBin(process.argv))
      .option("aggregator",      { alias: "a", type: "string", demandOption: true })
      .option("oracle",          { alias: "o", type: "string", demandOption: true })
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: true })
      .option("jobids",          { alias: "j", type: "array",  demandOption: true })
      .strict().argv;

    const [signer] = await ethers.getSigners();
    const caller   = await signer.getAddress();
    console.log("Caller:", caller);

    /* Find ReputationKeeper */
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, signer);
    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper = new ethers.Contract(keeperAddr, KeeperABI, signer);

    /* Authorisation check */
    const [oracleOwner, keeperOwner] = await Promise.all([
      getOwnerOrSelf(argv.oracle, signer.provider, signer),
      keeper.owner().then(o => o.toLowerCase()),
    ]);

    if (
      caller.toLowerCase() !== oracleOwner &&
      caller.toLowerCase() !== keeperOwner
    ) {
      throw new Error("Caller must be oracle owner (or EOA itself) or ReputationKeeper owner");
    }

    /* wVDKA balance before */
    const verdikta  = new ethers.Contract(argv.wrappedverdikta, ERC20_BALANCE, signer);
    const balBefore = await verdikta.balanceOf(caller);
    console.log("Initial wVDKA balance:", ethers.formatEther(balBefore));

    /* Loop through job IDs */
    for (const rawId of argv.jobids) {
      const jobId = toBytes32(rawId);
      console.log(`\nJobID ${rawId} → ${jobId}`);

      const info = await keeper.getOracleInfo(argv.oracle, jobId);
      if (!info.isActive) {
        console.log("Not registered – skipping");
        continue;
      }

      console.log("Calling deregisterOracle…");
      const tx = await keeper.deregisterOracle(argv.oracle, jobId);
      await tx.wait();
      console.log("Deregistered (tx:", tx.hash, ")");
    }

    /* wVDKA balance after */
    const balAfter = await verdikta.balanceOf(caller);
    console.log("\nFinal wVDKA balance:", ethers.formatEther(balAfter));
    console.log("Oracle deregistration completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle deregistration:", err);
    process.exit(1);
  }
})();

