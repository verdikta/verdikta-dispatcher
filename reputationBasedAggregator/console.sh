#!/usr/bin/env bash
set -euo pipefail
set -a; [ -f .env ] && source .env; set +a
npx hardhat console --network "${HARDHAT_NETWORK:-base_sepolia}"

