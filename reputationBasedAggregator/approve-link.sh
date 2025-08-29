#!/usr/bin/env bash
# Usage: ./approve-link.sh 0.5
set -euo pipefail

# Load .env (export all vars)
set -a; [ -f .env ] && source .env; set +a

node scripts/approve-link.js "${1:-0}"

