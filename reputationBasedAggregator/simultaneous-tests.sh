#!/usr/bin/env bash
# simultaneous-tests.sh  — ./simultaneous-tests.sh [network]   (default base_sepolia)
# Keys/RPC load from ../../secrets/.env.secrets via hardhat.config (no .env sourcing).
set -euo pipefail
npx hardhat run scripts/simultaneous-tests.js --network "${1:-${HARDHAT_NETWORK:-base_sepolia}}"
