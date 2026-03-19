[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Verdikta Dispatcher

Decentralized oracle infrastructure for AI-powered evaluation and dispute resolution on EVM chains. The dispatcher coordinates requests between client applications and an oracle network that performs off-chain AI evaluation, returning cryptographically committed results on-chain.

## Architecture

```
                        ┌─────────────────────┐
                        │  Client Application  │
                        │  (or DemoClient)     │
                        └──────────┬──────────┘
                                   │ requestAIEvaluationWithApproval()
                                   ▼
              ┌────────────────────────────────────────┐
              │          Aggregation Layer              │
              │                                        │
              │  ReputationAggregator (commit-reveal)  │
              │        — or —                          │
              │  ReputationSingleton  (single-oracle)  │
              │        — or —                          │
              │  SimpleContract       (fixed oracle)   │
              └──────────┬─────────────────────────────┘
                         │ selectOracles()    ▲ updateScores()
                         ▼                    │
              ┌──────────────────────┐        │
              │  ReputationKeeper    │────────┘
              │  (registry, scores,  │
              │   staking, selection)│
              └──────────┬──────────┘
                         │ isContractApproved()
                         ▼
              ┌──────────────────────┐
              │  ArbiterOperator     │
              │  (Chainlink operator │
              │   + access control)  │
              └──────────┬──────────┘
                         │ OracleRequest / fulfillOracleRequestV
                         ▼
              ┌──────────────────────┐
              │  Chainlink Node(s)   │
              │  (off-chain AI eval) │
              └──────────────────────┘
```

**Data flow:** A client submits IPFS evidence CIDs and LINK payment to an aggregation contract. The aggregator selects oracles via the ReputationKeeper, dispatches Chainlink requests through ArbiterOperators, collects responses, and returns aggregated results on-chain.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| **arbiterOperator/** | Chainlink-compatible operator with access-control restrictions, ensuring only approved contracts can request oracle services |
| **reputationBasedAggregator/** | Multi-oracle commit-reveal aggregation contract with K/M/N/P phased polling (default 6/4/3/2) |
| **reputationBasedSingleton/** | Single-oracle fast-resolution contract for simpler disputes needing quick turnaround |
| **demoClient/** | Demo client contract showing the minimal integration pattern |
| **simpleContract/** | Minimal fixed-oracle contract for development and testing |
| **docs/** | MkDocs documentation site source |

Each subdirectory is a standalone Hardhat project with its own `contracts/`, `deploy/`, `scripts/`, `test/`, and `.env.example`.

## Deployed Contract Addresses

### Base (Mainnet)

| Contract | Address |
|----------|---------|
| LINK Token | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` |
| Wrapped Verdikta Token | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` |

### Base Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| LINK Token | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Verdikta Token | `0x50f0C663931A5F9caDF36EFd0BE4E4D18196200e` |
| Wrapped Verdikta Token (Aggregator) | `0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3` |
| Wrapped Verdikta Token (Singleton) | `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` |
| ReputationKeeper (Singleton) | `0xE09821277D9af702F7910a57e85EaC6D83e4d794` |

### Ethereum Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| LINK Token | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
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

Key pages:

- [Deployment Guide](docs/deployment/index.md) — step-by-step deploy procedures and verification
- [Error Reference](docs/api/errors.md) — all custom errors and revert conditions
- [Events Reference](docs/api/events.md) — every event with parameters and lifecycle
- [Reputation System](docs/advanced/reputation.md) — oracle scoring and penalty mechanics
- [Oracle Selection](docs/advanced/oracle-selection.md) — weighted selection algorithm
- [Fee Mechanisms](docs/advanced/fees.md) — LINK and VDKA token flows
- [Integration Walkthrough](docs/examples/integration.md) — calling the dispatcher from a client contract

## Contributing

Contributions are welcome. Please follow these guidelines:

1. **Fork** the repository and create a feature branch from `master`.
2. **Install dependencies** in the relevant subproject (`npm install`).
3. **Write tests** for any new functionality or bug fixes.
4. **Run the existing test suite** before submitting (`npx hardhat test`).
5. **Follow existing code style** — Solidity contracts use NatSpec comments; JavaScript follows the patterns already in the repo.
6. **Do not commit secrets** — use `.env` for private keys and API keys. Only `.env.example` files with placeholder values should be tracked.
7. **Submit a pull request** with a clear description of what changed and why.

### Commit Messages

Use clear, imperative-mood messages:

```
Add oracle class filtering to selection algorithm
Fix bonus payment for user-funded aggregator requests
Update deployment addresses for Base Sepolia
```

### Reporting Issues

Open an issue on GitHub with:
- The contract or subproject affected
- Steps to reproduce (or a failing test case)
- Expected vs. actual behavior
- Network and transaction hash if applicable

## License

This project is licensed under the [MIT License](LICENSE).
