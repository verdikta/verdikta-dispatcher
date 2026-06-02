// deploy/helpers.js
// Shared utilities for deployment scripts

const hre = require("hardhat");

const LOCAL_NETWORKS = new Set(["hardhat", "localhost", "development"]);

/**
 * Verify a contract on the block explorer with retry logic.
 * Skips silently on local networks or when no API key is configured.
 *
 * @param {string} address          - Deployed contract address
 * @param {Array}  constructorArgs  - Constructor arguments used at deploy time
 * @param {string} [contractFQN]    - Fully qualified name, e.g.
 *                                    "contracts/Foo.sol:Foo"  (optional but
 *                                    recommended when multiple .sol files exist)
 * @param {Object} [libraries]      - Linked external libraries, keyed by FQN,
 *                                    e.g. { "contracts/Foo.sol:FooLib": "0x..." }
 *                                    (required to verify a library-linked contract)
 */
async function verifyContract(address, constructorArgs, contractFQN, libraries) {
  const network = hre.network.name;

  // Skip local/test networks
  if (LOCAL_NETWORKS.has(network)) return;

  // Skip if no API key is configured
  const hasKey =
    process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY;
  if (!hasKey) {
    console.log("No ETHERSCAN_API_KEY or BASESCAN_API_KEY set — skipping verification.");
    return;
  }

  console.log(`\nVerifying ${contractFQN || address} on ${network} (will retry for up to 60 s)...`);

  const maxAttempts = 4;
  const delayMs = 15_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const verifyArgs = {
        address,
        constructorArguments: constructorArgs,
      };
      if (contractFQN) verifyArgs.contract = contractFQN;
      if (libraries && Object.keys(libraries).length) verifyArgs.libraries = libraries;

      await hre.run("verify:verify", verifyArgs);
      console.log("Verified successfully!");
      return;
    } catch (err) {
      const msg = err.message || err.toString();

      if (msg.includes("Already Verified") || msg.includes("already verified")) {
        console.log("Contract already verified!");
        return;
      }

      if (msg.includes("has no bytecode") && attempt < maxAttempts) {
        console.log(
          `Attempt ${attempt}/${maxAttempts}: Contract not indexed yet. Retrying in ${delayMs / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      console.log(`Verify failed (attempt ${attempt}/${maxAttempts}): ${msg}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        const argsStr = constructorArgs.map((a) => `"${a}"`).join(" ");
        const contractFlag = contractFQN ? ` --contract ${contractFQN}` : "";
        console.log("Try verifying manually later with:");
        console.log(
          `  npx hardhat verify --network ${network}${contractFlag} ${address} ${argsStr}`
        );
      }
    }
  }
}

module.exports = { verifyContract };
