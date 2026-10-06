[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Verdikta Dispatcher

Decentralized oracle infrastructure for AI-powered evaluation and dispute resolution on EVM chains. The dispatcher coordinates requests between client applications and an oracle network that performs off-chain AI evaluation, returning cryptographically committed results on-chain.

**Status: Live in production.** The dispatcher contracts are deployed and operating on **Base Mainnet** and **Base Sepolia**, powering live applications such as [Verdikta Bounties](https://bounties.verdikta.org) (see [live network metrics](https://bounties.verdikta.org/analytics)). Deployed addresses are listed [below](#deployed-contract-addresses).

**Query funding:** The production `ReputationAggregator` uses **native ETH on Base** for evaluation fees. Requesters do not need to buy LINK or approve LINK spending. ETH for network gas is still required.

## Architecture

```
                        ┌─────────────────────┐
                        │  Client Application  │
                        │  (or DemoClient)     │
                        └──────────┬──────────┘
                                   │ requestAIEvaluationWithApproval{value: ...}()
                                   ▼
              ┌────────────────────────────────────────┐
              │          Aggregation Layer              │
              │                                        │
              │  ReputationAggregator (commit-reveal)  │
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

**Data flow:** A client submits IPFS evidence CIDs to the ETH-funded `ReputationAggregator`, attaching the required ETH prepayment or using its existing `ethOwed` credit. The aggregator selects oracles via the ReputationKeeper, dispatches zero-LINK Chainlink requests through ArbiterOperators, collects responses, and returns aggregated results on-chain. Oracle fees and any unspent prepayment are credited to the aggregator's ETH withdrawal ledger.

### Funding an evaluation

- Read `maxTotalFee(maxOracleFee)` for the worst-case evaluation budget in **ETH wei**. The aggregator applies the requester's existing `ethOwed` credit first; attach the remaining amount as `msg.value`. Keep enough additional ETH for gas.
- `requestAIEvaluationWithApproval` retains its historical name, but the current aggregator needs **no LINK approval or LINK balance** from the requester. Chainlink request/response transport remains in use with a zero-LINK payment.
- After settlement, any unspent prepayment becomes `ethOwed` credit. It can fund another request or be claimed with `withdrawEth()`; oracle owners also withdraw their credited ETH from the aggregator. The worst-case prepayment is a budget, not a promise that part of it will be refunded.

See the [ETH payment implementation notes](docs/advanced/eth-payment-migration.md), [current query script](reputationBasedAggregator/scripts/single-query.js), and [refund script](reputationBasedAggregator/scripts/refund.js). For Verdikta Bounties, use its [current agent/API guide](https://bounties.verdikta.org/agents.txt): bounty rewards, evaluation prepayment, and network gas are separate ETH costs.

`ReputationAggregatorLINK.sol`, `ReputationSingleton`, and `SimpleContract` retain legacy LINK-based implementations. They are not the ETH-funded production flow described above.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| **arbiterOperator/** | Chainlink-compatible operator with access-control restrictions, ensuring only approved contracts can request oracle services |
| **reputationBasedAggregator/** | Production ETH-funded commit-reveal aggregator with K/M/N/P phased polling (default 6/4/3/2); archived LINK implementation also retained |
| **reputationBasedSingleton/** | Legacy LINK-funded single-oracle implementation |
| **demoClient/** | ETH-funded demo client showing the current integration pattern |
| **simpleContract/** | Legacy LINK-funded fixed-oracle contract for development and testing |
| **docs/** | MkDocs documentation site source |

Each subdirectory is a standalone Hardhat project with its own `contracts/`, `deploy/`, `scripts/`, `test/`, and `.env.example`.

## Deployed Contract Addresses

LINK addresses below are retained for Chainlink transport and legacy deployments; they do not mean requesters must fund or approve LINK for the ETH aggregator. Verdikta token addresses serve separate staking/reputation roles.

### Base (Mainnet)

| Contract | Address |
|----------|---------|
| ReputationAggregator (ETH-funded) | `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` |
| LINK Token (transport / legacy) | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` |
| Wrapped Verdikta Token | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` |

### Base Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| ReputationAggregator (ETH-funded) | `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` |
| LINK Token (transport / legacy) | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Verdikta Token | `0x50f0C663931A5F9caDF36EFd0BE4E4D18196200e` |
| Wrapped Verdikta Token (Aggregator) | `0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3` |
| Wrapped Verdikta Token (Singleton) | `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` |
| ReputationKeeper (Singleton) | `0xE09821277D9af702F7910a57e85EaC6D83e4d794` |

### Ethereum Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| LINK Token (transport / legacy) | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| Verdikta Token | `0xbb7079F45367ce928789cc40d8C9D4E3A19b0a49` |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Hardhat](https://hardhat.org/)
- An Infura or Alchemy API key (set in `.env`)
- A funded wallet private key for deployment (set in `.env`)

## Quick Start

```bash
# Use the current ETH-funded aggregator
cd reputationBasedAggregator

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
- [ETH Payment Implementation](docs/advanced/eth-payment-migration.md) — current aggregator funding, credits, settlement, and withdrawals; read the implementation notes before the historical design sections
- [Current Query Example](reputationBasedAggregator/scripts/single-query.js) — attach ETH after accounting for existing credit
- [Legacy Fee Mechanisms](docs/advanced/fees.md) — historical LINK-payment and VDKA-staking reference; LINK payment instructions do not apply to the current ETH aggregator
- [Legacy Integration Walkthrough](docs/examples/integration.md) — historical LINK-based client example; use the ETH implementation notes and current query script for new integrations

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
