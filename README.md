[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Verdikta Dispatcher

Decentralized oracle infrastructure for AI-powered evaluation and dispute resolution on EVM chains. The dispatcher coordinates requests between client applications and an oracle network that performs off-chain AI evaluation, returning cryptographically committed results on-chain.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| **arbiterOperator/** | Chainlink-compatible operator with access-control restrictions, ensuring only approved contracts can request oracle services |
| **reputationBasedAggregator/** | Multi-oracle commit-reveal aggregation contract for high-stakes disputes requiring maximum security |
| **reputationBasedSingleton/** | Single-oracle fast-resolution contract for simpler disputes needing quick turnaround |
| **demoClient/** | Demo client contract for integration testing |
| **simpleContract/** | Minimal oracle interaction contract for development and testing |
| **docs/** | MkDocs documentation site source |

Each subdirectory is a standalone Hardhat project with its own `contracts/`, `deploy/`, `scripts/`, `test/`, and `.env.example`.

## Deployed Contract Addresses

### Base Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| LINK Token | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Verdikta Token | `0x50f0C663931A5F9caDF36EFd0BE4E4D18196200e` |
| Wrapped Verdikta Token | `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` |
| Keeper | `0xE09821277D9af702F7910a57e85EaC6D83e4d794` |

### Ethereum Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| Verdikta Token | `0xbb7079F45367ce928789cc40d8C9D4E3A19b0a49` |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Hardhat](https://hardhat.org/)
- An Infura or Alchemy API key (set in `.env`)
- A funded wallet private key for deployment (set in `.env`)

## Quick Start

```bash
# Pick a subproject, e.g. reputationBasedSingleton
cd reputationBasedSingleton

# Install dependencies
npm install

# Copy the example env file and fill in your keys
cp .env.example .env

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to Base Sepolia
npx hardhat deploy --network base_sepolia
```

## Documentation

Full documentation is available at **[https://verdikta.org](https://verdikta.org)**.

## License

This project is licensed under the [MIT License](LICENSE).
