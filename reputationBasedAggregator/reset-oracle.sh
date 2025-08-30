#!/usr/bin/env bash
# reset-oracle.js – Hardhat version

set -euo pipefail
set -a; source .env; set +a

npx hardhat run scripts/reset-oracle.js --network "${HARDHAT_NETWORK:-base_sepolia}"
