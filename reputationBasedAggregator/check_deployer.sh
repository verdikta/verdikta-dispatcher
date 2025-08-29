#!/usr/bin/env bash
# check-deployer.sh – Hardhat version

set -euo pipefail
set -a; source .env; set +a

npx hardhat run scripts/check-deployer.js --network "${HARDHAT_NETWORK:-base_sepolia}"

