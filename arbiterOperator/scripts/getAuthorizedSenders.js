#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Reads the authorised sender list from ArbiterOperator.getAuthorizedSenders
//
// OPERATOR – operator contract address (optional; auto-detected if omitted)
//
// Example:
// npx hardhat run scripts/getAuthorizedSenders.js --network base_sepolia
//

const hre   = require("hardhat");
const fs    = require("fs");
const path  = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

async function main () {
  /*──────── CLI + env ────────*/
  const argv = yargs(hideBin(process.argv))
    .option("operator", { type: "string", describe: "operator contract address" })
    .argv;

  // Resolve operator address:
  let operatorAddr = argv.operator || process.env.OPERATOR;
  if (!operatorAddr) {
    const depPath = path.join(
      __dirname, "..", "deployments", hre.network.name, "ArbiterOperator.json"
    );
    if (!fs.existsSync(depPath)) {
      throw new Error(
        `Cannot find ${depPath}. Pass --operator <addr> or set OPERATOR env-var.`
      );
    }
    operatorAddr = JSON.parse(fs.readFileSync(depPath)).address;
  }

  /*──────── status ────────*/
  console.log("Network   :", hre.network.name);
  console.log("Operator  :", operatorAddr);

  const [signer] = await hre.ethers.getSigners();
  const abi = [ "function getAuthorizedSenders() view returns (address[])" ];
  const op  = await hre.ethers.getContractAt(abi, operatorAddr, signer);

  const senders = await op.getAuthorizedSenders();
  if (senders.length === 0) {
    console.log("No authorised senders.");
    return;
  }

  console.log("Authorised senders (" + senders.length + "):");
  for (const [i, addr] of senders.entries()) {
    console.log(`  ${i+1}. ${addr}`);
  }

  // For programmatic use you might also emit JSON:
  // console.log(JSON.stringify(senders));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

