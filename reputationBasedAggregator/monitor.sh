#!/usr/bin/env bash
# scripts/monitor.sh – Hardhat version

export NODE_NO_WARNINGS=1   # keep the warning‑suppress flag

# Hardhat doesn’t use Ganache, so GANACHE_SKIP_NATIVE_BINDINGS is irrelevant
npx hardhat run scripts/monitor-contracts.js --network base_sepolia

