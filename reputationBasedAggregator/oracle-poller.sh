#!/usr/bin/env bash
# oracle-poller.sh – Hardhat version

set -euo pipefail
set -a; source .env; set +a

npx hardhat run scripts/oracle-poller.js --network "${HARDHAT_NETWORK:-base_sepolia}"
