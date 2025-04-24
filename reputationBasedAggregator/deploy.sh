#!/usr/bin/env bash
# scripts/deploy.sh  – Hardhat version (no token/mocks step)
# ----------------------------------------------------------
# Deploy sequence:
#   1. ReputationKeeper
#   2. ReputationAggregator
#   3. Post‑deployment config
#
# All three are tagged in their deploy scripts as:
#   module.exports.tags = ["keeper"];      // 003_keeper.js
#   module.exports.tags = ["aggregator"];  // 004_agg.js
#   module.exports.tags = ["config"];      // 005_config.js
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

npx hardhat deploy --network "${NET}" --tags keeper,aggregator,config

echo "✅  All deployments finished."

