#!/usr/bin/env bash
# ./single-query.sh            -> base_sepolia (default)
# ./single-query.sh base       -> mainnet
set -euo pipefail
npx hardhat run scripts/single-query.js --network "${1:-${HARDHAT_NETWORK:-base_sepolia}}"
