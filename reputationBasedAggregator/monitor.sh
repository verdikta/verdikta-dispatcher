#!/usr/bin/env bash
# monitor.sh – Hardhat version

set -euo pipefail
set -a; source .env; set +a

export NODE_NO_WARNINGS=1   # keep the warning-suppress flag
npx hardhat run scripts/monitor-contracts.js --network "${HARDHAT_NETWORK:-base_sepolia}"

