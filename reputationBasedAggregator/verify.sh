#!/usr/bin/env bash
# verify.sh – Hardhat version

set -euo pipefail
set -a; source .env; set +a

# Aggregator
# npx hardhat verify --network base_sepolia \
# 0xYourContractAddressHere \
# 0xChainlinkAddressHere \
# 0x0000000000000000000000000000000000000000
if true; then
echo "Running Aggregator verification..."
npx hardhat verify --network "${HARDHAT_NETWORK:-base_sepolia}" \
  --contract contracts/ReputationAggregator.sol:ReputationAggregator \
  0xb10f6D7fD908311BfEa947881a835Df828f7bBE1 \
  0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196 \
  0x0000000000000000000000000000000000000000 \
  || echo "Aggregator already verified (or verify failed); continuing"
fi

# Reputation Keeper
# npx hardhat verify --network base_sepolia \
# 0xYourReputationKeeperAddress \
# 0xYourWrappedVerdiktaTokenAddress
if true; then
echo "Running ReputationKeeper verification..."
npx hardhat verify --network "${HARDHAT_NETWORK:-base_sepolia}" \
  --contract contracts/ReputationKeeper.sol:ReputationKeeper \
  0xD3cA6b320c8d7AAdBc0fc759fe6A5800fbA445bd \
  0x1EA68D018a11236E07D5647175DAA8ca1C3D0280 \
  || echo "ReputationKeeper already verified (or verify failed); continuing"
fi
