#!/usr/bin/env bash
# scripts/deploy.sh  – Hardhat version (no token/mocks step)
# ----------------------------------------------------------
# Deploy sequence:
#   1. ReputationKeeper
#   2. ReputationAggregator
#   3. Post-deployment config
#
# Run with:
#   ./scripts/deploy.sh
#   # or explicitly:
#   NET=base_sepolia ./scripts/deploy.sh
# ----------------------------------------------------------

set -euo pipefail
NET=${NET:-base_sepolia}   # override by exporting NET=<network>

echo "=== Verdikta Deployment Script (Hardhat) ==="
echo "Deploying keeper + aggregator + config to ${NET}..."

# Use --reset to force redeployment even when compiled bytecode is the same
npx hardhat deploy --network "${NET}" --tags aggregator,keeper,config --reset

echo "✅  All deployments finished."

