#!/usr/bin/env node
/*
  Adds node wallet(s) to ArbiterOperator.setAuthorizedSenders.

  Accepts EITHER:
    • --operator   0x...   --nodes 0xA,0xB            (after `--` sentinel)
    • or env vars OPERATOR and NODES

  Form with env:
    OPERATOR=0xOpAddr NODES=0xNode1,0xNode2 \
    npx hardhat run scripts/setAuthorizedSenders-cl.js --network base_sepolia

  Example:
    OPERATOR=0x5Eb49eC748a32f4094819bFb643937f8Cf295d3e NODES=0xA2944d1Dd73DB724d9bA31a80Ea240B5dF922498 \
    npx hardhat run scripts/setAuthorizedSenders-cl.js --network base_sepolia

*/
require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

async function main () {
  /*──────── parse CLI (after sentinel) ───────*/
  const argv = yargs(hideBin(process.argv))
    .option("operator", { alias: "o", type: "string" })
    .option("nodes",    { alias: "n", type: "string" })
    .argv;

  const operatorAddr = argv.operator || process.env.OPERATOR;
  const nodesRaw     = argv.nodes    || process.env.NODES;

  if (!operatorAddr)
    throw new Error("Provide --operator or set OPERATOR env-var");

  if (!nodesRaw)
    throw new Error("Provide --nodes or set NODES env-var");

  const nodeAddrs = nodesRaw.split(",").map(a => a.trim()).filter(Boolean);
  if (nodeAddrs.length === 0)
    throw new Error("No node addresses found in --nodes / NODES");

  /*──────── display info ─────────────────────*/
  console.log("Network   :", hre.network.name);
  console.log("Operator  :", operatorAddr);
  console.log("New nodes :", nodeAddrs.join(", "));

  const [signer] = await ethers.getSigners();
  console.log("Tx signer :", await signer.getAddress());

  /*──────── interact with contract ───────────*/
  const abi = [
    "function getAuthorizedSenders() view returns (address[])",
    "function setAuthorizedSenders(address[])"
  ];
  const op = new ethers.Contract(operatorAddr, abi, signer);

  const existing = (await op.getAuthorizedSenders()).map(a => a.toLowerCase());
  const merged   = Array.from(new Set([...existing, ...nodeAddrs.map(n => n.toLowerCase())]));

  if (merged.length === existing.length) {
    console.log("Nothing to add – all nodes already authorised.");
    return;
  }

  const tx = await op.setAuthorizedSenders(merged);
  console.log("Tx hash   :", tx.hash);
  await tx.wait(2);
  console.log("✓ Authorised senders updated.");
}

main().catch(e => { console.error(e); process.exit(1); });

