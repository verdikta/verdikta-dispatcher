#!/usr/bin/env bash
# Deploy a fresh ETH ReputationAggregator (+ AggregatorLib) and wire it to the
# EXISTING ReputationKeeper (reuse-keeper path; operators need no rkList change).
#
#   NET=base_sepolia KEEPER_ADDRESS=0x... ./deploy_aggregatorOnly.sh   # testnet
#   NET=base         KEEPER_ADDRESS=0x... ./deploy_aggregatorOnly.sh   # mainnet
#
# KEEPER_ADDRESS may instead come from .env or the local deployments/<net>/ artifact.
set -euo pipefail
if [ -f .env ]; then set -a; source .env; set +a; fi
NET=${NET:-${HARDHAT_NETWORK:-base_sepolia}}
echo "Deploying ETH aggregator to ${NET}, wiring to existing keeper..."
npx hardhat run scripts/deploy_just_aggregator.js --network "${NET}"
