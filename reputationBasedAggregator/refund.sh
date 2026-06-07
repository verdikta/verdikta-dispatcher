#!/usr/bin/env bash
# refund.sh — finalize a timed-out round (optional) and withdraw your ETH credit.
#   ./refund.sh                         # withdraw your credit on base_sepolia
#   ./refund.sh 0x<aggId>               # finalize that stuck round (testnet), then withdraw
#   ./refund.sh 0x<aggId> base          # same, on mainnet
#   ./refund.sh "" base                 # just withdraw your credit on mainnet
# Secrets/keys load via hardhat.config (../../secrets/.env.secrets).
set -euo pipefail
[ -n "${1:-}" ] && export AGG_ID="$1"
npx hardhat run scripts/refund.js --network "${2:-${HARDHAT_NETWORK:-base_sepolia}}"
