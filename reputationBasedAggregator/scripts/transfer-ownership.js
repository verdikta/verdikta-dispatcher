// scripts/transfer-ownership.js
// -----------------------------------------------------------------------------
// Transfer ownership of any OZ-Ownable contract (e.g. ReputationKeeper) to a new
// owner. OZ Ownable is SINGLE-STEP and IMMEDIATE — there is no accept step, so an
// incorrect NEW_OWNER permanently loses control. This script therefore:
//   - requires the current signer to BE the current owner (fails fast otherwise),
//   - requires an explicit CONFIRM=yes to actually broadcast,
//   - re-reads owner() afterwards to confirm.
//
// Usage (run with the CURRENT owner's key as PRIVATE_KEY):
//   TARGET=0x<contract> NEW_OWNER=0x<newOwner> \
//     npx hardhat run scripts/transfer-ownership.js --network base_sepolia
//   # add CONFIRM=yes to broadcast; without it the script only previews.
// -----------------------------------------------------------------------------
require("dotenv").config();
const hre = require("hardhat");

const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

async function main() {
  const { ethers, network } = hre;
  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error(
      "No signer available — set PRIVATE_KEY (the CURRENT owner's key) in env/.env for " + network.name
    );
  }

  const target = process.env.TARGET;
  const newOwner = process.env.NEW_OWNER;
  if (!ethers.isAddress(target)) throw new Error(`TARGET is not a valid address: ${target}`);
  if (!ethers.isAddress(newOwner)) throw new Error(`NEW_OWNER is not a valid address: ${newOwner}`);
  if (newOwner === ethers.ZeroAddress) throw new Error("NEW_OWNER must not be the zero address");

  const code = await ethers.provider.getCode(target);
  if (code === "0x") throw new Error(`No contract code at TARGET ${target} on ${network.name}`);

  const c = new ethers.Contract(target, OWNABLE_ABI, signer);
  const current = await c.owner();

  console.log(`Network        : ${network.name}`);
  console.log(`Target         : ${target}`);
  console.log(`Current owner  : ${current}`);
  console.log(`Signer         : ${signer.address}`);
  console.log(`New owner      : ${newOwner}`);

  if (current.toLowerCase() === newOwner.toLowerCase()) {
    console.log("Already owned by NEW_OWNER — nothing to do.");
    return;
  }
  if (current.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the current owner; transferOwnership is onlyOwner. ` +
      `Run with the key for ${current}.`
    );
  }

  // Warn if NEW_OWNER looks like a contract (could be intended, e.g. a multisig).
  const newOwnerCode = await ethers.provider.getCode(newOwner);
  console.log(`New owner type : ${newOwnerCode === "0x" ? "EOA" : "CONTRACT (verify this is intended!)"}`);

  if (process.env.CONFIRM !== "yes") {
    console.log("\nPREVIEW ONLY. Re-run with CONFIRM=yes to broadcast this IRREVERSIBLE transfer.");
    return;
  }

  console.log("\nBroadcasting transferOwnership…");
  const tx = await c.transferOwnership(newOwner);
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error("transferOwnership tx reverted");

  // Verify owner(), retrying a few times: a status-1 receipt means the transfer
  // happened, but an immediate read on a load-balanced (public) RPC can hit a node
  // that is a block behind and return the stale owner. Poll until it converges.
  let after;
  for (let i = 0; i < 6; i++) {
    after = await c.owner();
    if (after.toLowerCase() === newOwner.toLowerCase()) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log("New owner is now:", after);
  if (after.toLowerCase() !== newOwner.toLowerCase()) {
    throw new Error(
      "owner() still not the new owner after retries — but the tx may have succeeded. " +
      "Verify the OwnershipTransferred event on the receipt directly before re-sending."
    );
  }
  console.log("Ownership transfer complete.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
