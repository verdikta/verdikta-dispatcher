#!/usr/bin/env node
// Call with: node scripts/approve-link.js amount
// Example: node scripts/approve-link.js 4
require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

const LINK    = '0xE4aB69C077896252FAFBD49EFD26B5D171A32410';   // LINK token
const AGGREGATOR = '0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02';   // aggregator
const AMOUNT  = ethers.parseUnits(process.argv[2] || '0', 18);   // amount from CLI

(async () => {
  const [signer] = await ethers.getSigners();
  const abi  = (await hre.artifacts.readArtifact('LinkTokenInterface')).abi;
  const link = new ethers.Contract(LINK, abi, signer);

  const tx = await link.approve(AGGREGATOR, AMOUNT);
  console.log('approve tx:', tx.hash);
  await tx.wait();
  console.log('approved', ethers.formatUnits(AMOUNT, 18), 'LINK');
})();

