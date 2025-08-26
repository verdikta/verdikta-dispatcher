#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Standalone CLI to read ArbiterOperator.getAuthorizedSenders
// No Hardhat runtime or artifacts needed.
//
// Usage examples:
//   node scripts/getAuthorizedSenders-cl.js \
//     --operator 0xYourOperator \
//     --rpc https://sepolia.base.org
//
//   OPERATOR=0xYourOperator RPC_URL=https://sepolia.base.org \
//   node scripts/getAuthorizedSenders-cl.js
//
//   node scripts/getAuthorizedSenders-cl.js \
//     -o 0xYourOperator -r https://sepolia.base.org --json
//
/*   
     Example: node scripts/getAuthorizedSenders-cl.js \
     -o 0xBF5AEC1B08D0e69106366b12752bB1F61e1B76A0 -r https://sepolia.base.org --json
*/

const { hideBin } = require("yargs/helpers");
const yargs = require("yargs/yargs");
const { JsonRpcProvider, Wallet, Contract, isAddress, getAddress } = require("ethers");

const ABI = [
  "function getAuthorizedSenders() view returns (address[])"
];

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("operator", {
      alias: "o",
      type: "string",
      describe: "ArbiterOperator contract address",
    })
    .option("rpc", {
      alias: "r",
      type: "string",
      describe: "RPC URL (e.g. https://sepolia.base.org)",
    })
    .option("key", {
      alias: "k",
      type: "string",
      describe: "Private key (optional; only needed if you want to sign)",
    })
    .option("json", {
      type: "boolean",
      default: false,
      describe: "Output JSON array only",
    })
    .demandOption(
      ["operator"],
      "Please provide --operator or set OPERATOR env var"
    )
    .help()
    .argv;

  const operatorRaw = argv.operator || process.env.OPERATOR;
  if (!operatorRaw || !isAddress(operatorRaw)) {
    throw new Error(`Invalid --operator address: ${operatorRaw}`);
  }
  const operator = getAddress(operatorRaw);

  const rpcUrl = argv.rpc || process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Missing RPC URL. Pass --rpc or set RPC_URL.");

  const provider = new JsonRpcProvider(rpcUrl);

  // Optional signer (not required for a view call)
  const key = argv.key || process.env.PRIVATE_KEY;
  const signerOrProvider = key ? new Wallet(key, provider) : provider;

  // Sanity check: is there code at the address?
  const code = await provider.getCode(operator);
  if (code === "0x") {
    throw new Error(`No contract code found at ${operator}`);
  }

  const op = new Contract(operator, ABI, signerOrProvider);
  const senders = await op.getAuthorizedSenders();

  if (argv.json) {
    console.log(JSON.stringify(senders, null, 2));
    return;
  }

  console.log("RPC URL  :", rpcUrl);
  console.log("Operator :", operator);
  console.log(
    "Mode     :",
    key ? "signed (key provided)" : "read-only"
  );

  if (!senders || senders.length === 0) {
    console.log("No authorised senders.");
    return;
  }

  console.log(`Authorised senders (${senders.length}):`);
  senders.forEach((addr, i) => console.log(`  ${i + 1}. ${addr}`));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

