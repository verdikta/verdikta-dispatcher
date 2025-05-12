#!/usr/bin/env node
/*
  Deploy ArbiterOperator and save its address to
  deployments/<network>/ArbiterOperator.json so that other scripts
  (e.g. setAuthorizedSenders.js) can auto-detect it.

  Usage:
    npx hardhat run scripts/deployArbiterOperator.js --network base_sepolia
*/

const hre   = require("hardhat");
const fs    = require("fs");
const path  = require("path");

async function main() {
  const net  = hre.network.name;                  // e.g. "base_sepolia"
  const ADDR = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployment-addresses.json"))
  )[net];

  if (!ADDR || !ADDR.linkTokenAddress) {
    throw new Error(`No linkTokenAddress for ${net} in deployment-addresses.json`);
  }
  const LINK = ADDR.linkTokenAddress;

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying ArbiterOperator from ${deployer.address}`);
  console.log(`LINK token: ${LINK}`);

  const Factory = await hre.ethers.getContractFactory("ArbiterOperator");
  const op      = await Factory.deploy(LINK);
  await op.waitForDeployment();

  const address = await op.getAddress();
  console.log("ArbiterOperator deployed at:", address);

  /*────────── persist JSON for other scripts ──────────*/
  const artifact = await hre.artifacts.readArtifact("ArbiterOperator");
  const outDir   = path.join(__dirname, "..", "deployments", net);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, "ArbiterOperator.json"),
    JSON.stringify({ address, abi: artifact.abi }, null, 2)
  );

  /*────────── convenience: echo export line ───────────*/
  console.log(`\n# paste in your shell if you need it right away`);
  console.log(`export OPERATOR=${address}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

