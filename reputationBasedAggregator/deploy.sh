#!/usr/bin/env bash
# deploy.sh  – Hardhat version (no token/mocks step)
# ----------------------------------------------------------
# Deploy sequence:
#   1. ReputationKeeper
#   2. ReputationAggregator
#   3. Post-deployment config
#
# Run with:
#   ./deploy.sh
#   # or explicitly:
#   NET=base_sepolia ./deploy.sh
# ----------------------------------------------------------

set -euo pipefail

# Load HARDHAT_NETWORK from .env if it exists
if [ -f .env ]; then
  set -a; source .env; set +a
fi

NET=${NET:-${HARDHAT_NETWORK:-base_sepolia}}

echo "=== Verdikta Deployment Script (Hardhat) ==="
echo "Deploying keeper + aggregator + config to ${NET}..."

# Use --reset to force redeployment even when compiled bytecode is the same
# npx hardhat deploy --network "${NET}" --tags aggregator,keeper,config --reset
npx hardhat deploy --network "${NET}" --tags aggregator,keeper,config

echo "All deployments finished."

