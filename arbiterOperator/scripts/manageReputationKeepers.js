/**
 * manageReputationKeepers.js
 * ──────────────────────────
 * Drive it ENTIRELY with environment variables so you can run everything
 * in one shell line, e.g.:
 *
 * HARDHAT_NETWORK=base_sepolia \
 * RK_ACTION=add \
 * RK_OPERATOR=0xb8b2302759e1FB7144d35f6F41057f11dbFAdDbD \
 * RK_KEEPER=0x3ee944351bc1c6074f1b66349d05ceBCcbb200fB \
 * node scripts/manageReputationKeepers.js
 *
 * To remove, set RK_ACTION=remove.
 *
 * Notes
 * ─────
 * • `HARDHAT_NETWORK` picks the network (same flag Hardhat uses).
 * • The script grabs the first signer returned by Hardhat—make sure that
 *   signer is the *owner* of the ArbiterOperator contract.
 * • You can still override any env-var on the command line:
 *     RK_ACTION=remove ... node scripts/manageReputationKeepers.js
 */

// Add and Remove Examples:
/* 
HARDHAT_NETWORK=base_sepolia RK_ACTION=add RK_OPERATOR=0xb8b2302759e1FB7144d35f6F41057f11dbFAdDbD \
RK_KEEPER=0x3ee944351bc1c6074f1b66349d05ceBCcbb200fB node scripts/manageReputationKeepers.js

HARDHAT_NETWORK=base_sepolia RK_ACTION=remove RK_OPERATOR=0xb8b2302759e1FB7144d35f6F41057f11dbFAdDbD \
RK_KEEPER=0x3ee944351bc1c6074f1b66349d05ceBCcbb200fB node scripts/manageReputationKeepers.js
*/

require("dotenv").config();           // optional .env support

const hre    = require("hardhat");
const { ethers } = hre;

async function main() {
  const action   = (process.env.RK_ACTION || "").toLowerCase();   // add | remove
  const operator = process.env.RK_OPERATOR;
  const keeper   = process.env.RK_KEEPER;

  if (!["add", "remove"].includes(action) || !operator || !keeper) {
    console.error(`
Missing or bad env-vars.

Required:
  RK_ACTION   = add | remove
  RK_OPERATOR = <ArbiterOperator address>
  RK_KEEPER   = <ReputationKeeper address>
Optional:
  HARDHAT_NETWORK = <network name>   (defaults to hardhat.config default)

Example (single line):
  HARDHAT_NETWORK=base_sepolia \\
  RK_ACTION=add \\
  RK_OPERATOR=0x... \\
  RK_KEEPER=0x... \\
  node scripts/manageReputationKeepers.js
`);
    process.exit(1);
  }

  const abi = [
    "function addReputationKeeper(address)",
    "function removeReputationKeeper(address)"
  ];

  const signer = (await ethers.getSigners())[0];
  const op     = new ethers.Contract(operator, abi, signer);

  if (action === "add") {
    console.log(`Adding ${keeper} to operator ${operator} …`);
    const tx = await op.addReputationKeeper(keeper);
    console.log("  tx:", tx.hash);
    await tx.wait();
    console.log("✓ keeper added");
  } else {
    console.log(`Removing ${keeper} from operator ${operator} …`);
    const tx = await op.removeReputationKeeper(keeper);
    console.log("  tx:", tx.hash);
    await tx.wait();
    console.log("✓ keeper removed");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

