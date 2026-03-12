#!/usr/bin/env bash
# verify.sh – Verify contracts on the block explorer
#
# Reads addresses from hardhat-deploy artifacts by default.
# Override with env vars if needed:
#
#   AGGREGATOR_ADDR=0x... KEEPER_ADDR=0x... ./verify.sh
#
# Set HARDHAT_NETWORK to target a specific network (default: base_sepolia).

set -euo pipefail
set -a; source .env; set +a

NETWORK="${HARDHAT_NETWORK:-base_sepolia}"
DEPLOY_DIR="deployments/${NETWORK}"

# ---------------------------------------------------------------------------
# Resolve addresses: env var > hardhat-deploy artifact > error
# ---------------------------------------------------------------------------
resolve_address() {
  local name="$1"
  local env_val="$2"

  if [[ -n "${env_val}" ]]; then
    echo "${env_val}"
    return
  fi

  local artifact="${DEPLOY_DIR}/${name}.json"
  if [[ -f "${artifact}" ]]; then
    # Extract "address" field from the deployment JSON
    local addr
    addr=$(node -e "console.log(require('./${artifact}').address)")
    if [[ -n "${addr}" && "${addr}" != "undefined" ]]; then
      echo "${addr}"
      return
    fi
  fi

  echo ""
}

AGG_ADDR=$(resolve_address "ReputationAggregator" "${AGGREGATOR_ADDR:-}")
KEEP_ADDR=$(resolve_address "ReputationKeeper" "${KEEPER_ADDR:-}")

# ---------------------------------------------------------------------------
# Resolve constructor args
# ---------------------------------------------------------------------------
# Aggregator constructor: (linkTokenAddress, keeperAddress)
# At deploy time keeper is 0x0...0 (wired later), so verify with zero address.
LINK_ADDR_MAP_base="0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196"
LINK_ADDR_MAP_base_sepolia="0xE4aB69C077896252FAFBD49EFD26B5D171A32410"

LINK_VAR="LINK_ADDR_MAP_${NETWORK//-/_}"
LINK_ADDR="${!LINK_VAR:-}"

if [[ -z "${LINK_ADDR}" ]]; then
  echo "WARNING: No LINK address mapped for network ${NETWORK}. Aggregator verification may fail."
fi

# Keeper constructor: (wrappedVerdiktaTokenAddress)
if [[ "${NETWORK}" == "base" ]]; then
  WVDKA="${WRAPPED_VERDIKTA_TOKEN_BASE:-}"
elif [[ "${NETWORK}" == "base_sepolia" ]]; then
  WVDKA="${WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA:-}"
else
  WVDKA="${WRAPPED_VERDIKTA_TOKEN:-}"
fi

ZERO="0x0000000000000000000000000000000000000000"

# ---------------------------------------------------------------------------
# Verify ReputationAggregator
# ---------------------------------------------------------------------------
if [[ -n "${AGG_ADDR}" ]]; then
  echo "Verifying ReputationAggregator at ${AGG_ADDR} on ${NETWORK}..."
  npx hardhat verify --network "${NETWORK}" \
    --contract contracts/ReputationAggregator.sol:ReputationAggregator \
    "${AGG_ADDR}" \
    "${LINK_ADDR}" \
    "${ZERO}" \
    || echo "Aggregator verification failed or already verified; continuing."
else
  echo "SKIP: No ReputationAggregator address found."
  echo "  Set AGGREGATOR_ADDR=0x... or deploy first so artifacts exist."
fi

echo ""

# ---------------------------------------------------------------------------
# Verify ReputationKeeper
# ---------------------------------------------------------------------------
if [[ -n "${KEEP_ADDR}" ]]; then
  if [[ -z "${WVDKA}" ]]; then
    echo "SKIP: Cannot verify ReputationKeeper — WRAPPED_VERDIKTA_TOKEN not set for ${NETWORK}."
  else
    echo "Verifying ReputationKeeper at ${KEEP_ADDR} on ${NETWORK}..."
    npx hardhat verify --network "${NETWORK}" \
      --contract contracts/ReputationKeeper.sol:ReputationKeeper \
      "${KEEP_ADDR}" \
      "${WVDKA}" \
      || echo "ReputationKeeper verification failed or already verified; continuing."
  fi
else
  echo "SKIP: No ReputationKeeper address found."
  echo "  Set KEEPER_ADDR=0x... or deploy first so artifacts exist."
fi
