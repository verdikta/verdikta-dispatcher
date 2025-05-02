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

module.exports = {
  getContract
};

