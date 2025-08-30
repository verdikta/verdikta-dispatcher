#!/usr/bin/env bash
# simultaneous-tests.sh – Hardhat version

set -euo pipefail
set -a; source .env; set +a

npx hardhat run scripts/simultaneous-tests.js --network "${HARDHAT_NETWORK:-base_sepolia}"
