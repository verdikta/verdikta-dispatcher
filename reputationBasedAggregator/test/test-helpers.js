const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Read the deployment addresses file
const deploymentAddressesPath = path.join(__dirname, "../deployment-addresses.json");
const deploymentAddresses = JSON.parse(fs.readFileSync(deploymentAddressesPath, "utf8"));

async function getContract(name, signer) {
  try {
    // Get the current network name
    const networkName = network.name;
    
    // Special handling for token contracts
    if (name === "WrappedVerdiktaToken") {
      // Check if the address exists in the deployment addresses
      const addressKey = "wrappedVerdiktaTokenAddress";
      if (deploymentAddresses[networkName] && deploymentAddresses[networkName][addressKey]) {
        const address = deploymentAddresses[networkName][addressKey];
        return ethers.getContractAt("IERC20", address, signer);
      }
    }
    
    // For other contracts, try to get from deployments
    const { deployments } = require("hardhat");
    const deployment = await deployments.get(name);
    return ethers.getContractAt(name, deployment.address, signer);
  } catch (error) {
    console.error(`Error getting contract ${name}:`, error.message);
    throw error;
  }
}

// Suites that read contracts from a hardhat-deploy deployment (keeper.test.js,
// aggregator.test.js; e.g. test.sh runs them with --network base_sepolia) have nothing
// to read on the in-process hardhat network. Call from a before() hook as
// `await skipUnlessDeployed(this, "ReputationKeeper")`: it skips the suite there
// instead of failing the hook, and changes nothing on a network that has the deployment.
async function skipUnlessDeployed(mochaContext, ...names) {
  const { deployments } = require("hardhat");
  for (const name of names) {
    if (!(await deployments.getOrNull(name))) {
      console.log(`    skipped: no ${name} deployment on network "${network.name}"`);
      mochaContext.skip();
    }
  }
}

module.exports = {
  getContract,
  skipUnlessDeployed
};

