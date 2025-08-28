#!/usr/bin/env bash
set -euo pipefail
set -a; source .env; set +a
npx hardhat console --network "${HARDHAT_NETWORK:-base_sepolia}"

