#!/usr/bin/env bash
# register_oracle.sh – Hardhat version

set -euo pipefail
set -a; source .env; set +a

npx hardhat run scripts/register-oracle.js --network "${HARDHAT_NETWORK:-base_sepolia}"

