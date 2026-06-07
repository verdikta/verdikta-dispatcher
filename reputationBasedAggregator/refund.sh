#!/usr/bin/env bash
# refund.sh — finalize a timed-out round (optional) and withdraw your ETH credit.
#   ./refund.sh                     # just withdraw your ethOwed credit
#   ./refund.sh 0x<aggId>           # finalize that stuck round first, then withdraw
# Network via HARDHAT_NETWORK (default base_sepolia); secrets load via hardhat.config.
set -euo pipefail
set -a; [ -f .env ] && source .env; set +a
[ -n "${1:-}" ] && export AGG_ID="$1"
npx hardhat run scripts/refund.js --network "${HARDHAT_NETWORK:-base_sepolia}"
