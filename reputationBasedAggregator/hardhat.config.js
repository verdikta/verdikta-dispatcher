// hardhat.config.js
const path = require("path");
// Load shared deploy secrets (PRIVATE_KEY, PRIVATE_KEY_2, INFURA_API_KEY,
// BASESCAN_API_KEY, ...) from the sibling secrets dir, then any local .env.
// Secrets load first; dotenv never overrides values already in process.env, so
// precedence is: real shell env  >  ../../secrets/.env.secrets  >  local .env.
require("dotenv").config({ path: path.resolve(__dirname, "../../secrets/.env.secrets") });
require("dotenv").config();
const https = require("https");
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-deploy");

const ACCOUNTS = [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(Boolean);
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.30",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    ],
  },

  networks: {
    development: {
      url: "http://127.0.0.1:8545",
      accounts: ACCOUNTS,
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 11155111,
      gas: 18_500_000,
      gasPrice: 10_000_000_000,
      accounts: ACCOUNTS,
    },
    base_sepolia: {
      // Override with BASE_SEPOLIA_RPC_URL (e.g. https://sepolia.base.org, no API key);
      // falls back to Infura when that env var is unset.
      url: process.env.BASE_SEPOLIA_RPC_URL || `https://base-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 84532,
      gas: 10_000_000,
      gasPrice: 300_000_000, // increase this if needed
      accounts: ACCOUNTS,
    },
    base: {
      // Override with BASE_RPC_URL (e.g. https://mainnet.base.org, no API key);
      // falls back to Infura when that env var is unset.
      url: process.env.BASE_RPC_URL || `https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 8453,
      accounts: ACCOUNTS,
      // Optional: explicit EIP-1559 caps if you want to pin them
      // maxFeePerGas:  "30_000_000_000",  // 30 gwei
      // maxPriorityFeePerGas: "1_000_000_000", // 1 gwei
    },
  },

  // Tell hardhat-deploy to *always* use ordinary CREATE (no CREATE2)
  deterministicDeployment: false,  

  namedAccounts: {
    deployer: 0,
    owner:    0,
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY,
    customChains: [
      {
        network:  "base_sepolia",
        chainId:  84532,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network:  "base",
        chainId:  8453,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org",
        },
      },
      {
        network:  "sepolia",
        chainId:  11155111,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=11155111",
          browserURL: "https://sepolia.etherscan.io",
        },
      },
    ],
  },

  mocha: { timeout: 100_000 },
  sourcify: {enabled: false},
};

