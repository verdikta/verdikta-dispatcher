[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Verdikta Dispatcher

Decentralized oracle infrastructure for AI-powered evaluation and dispute resolution on EVM chains. The dispatcher coordinates requests between client applications and an oracle network that performs off-chain AI evaluation, returning cryptographically committed results on-chain.

**Status.** The **v1** contracts (tag `aggregator-v0.1.0`) are deployed and operating on **Base Mainnet** and **Base Sepolia**, powering live applications such as [Verdikta Bounties](https://bounties.verdikta.org) (see [live network metrics](https://bounties.verdikta.org/analytics)); their addresses are listed [below](#deployed-contract-addresses-v1). **v2**, on the `beacon` branch, is a breaking redeploy that is **not deployed or audited yet**: one aggregator serves every jury size because each request carries its jury, the jury is drawn after the request from a later block hash (optionally mixed with arbiter beacons), and reputation, staking and liveness are rebuilt. [`reputationBasedAggregator/MIGRATION.md`](reputationBasedAggregator/MIGRATION.md) lists what changes for every consumer.

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
              │  JuryBeacons (optional seed beacons)   │
              └──────────┬─────────────────────────────┘
                         │ selectArbiters()   ▲ applyOutcomes()
                         ▼                    │
              ┌──────────────────────┐        │
              │  ReputationKeeper    │────────┘
              │  (registry, stake,   │
              │   scores, health,    │
              │   selection)         │
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

**Data flow (v2):** A client submits IPFS evidence CIDs and its jury `(K, M, N, P, timeout)` to the ETH-funded `ReputationAggregator`, attaching the ETH prepayment or using its existing `ethOwed` credit. The request only escrows. From two blocks later anyone calls `drawJury`, and the keeper draws K arbiters from its state as of the request block; the aggregator dispatches zero-LINK Chainlink requests through the arbiters' ArbiterOperators. The commit phase closes at M+ commits (or after T+), `promote` draws M of the commits to reveal, and the N-th reveal finalizes the result. After the round's deadline, `settle` reports every juror's outcome to the keeper. Fees, bonuses, rewards and any unspent prepayment are credited to the aggregator's ETH withdrawal ledger.

### Funding an evaluation

- Read `maxTotalFee(maxFee, minFee, withBeacons, K, P)` for the worst-case budget of a round with that jury, in **ETH wei** (v1: `maxTotalFee(maxOracleFee)`). The aggregator takes from the requester's existing `ethOwed` credit only what `msg.value` does not cover. Keep enough additional ETH for gas.
- `requestAIEvaluationWithApproval` retains its historical name, but the current aggregator needs **no LINK approval or LINK balance** from the requester. Chainlink request/response transport remains in use with a zero-LINK payment.
- When the round ends, any unspent prepayment becomes `ethOwed` credit, except where a refund would be a free re-roll of the jury: then a round that had M commits but was never promoted pays it to the slots that committed, and the other cases send it to the arbiter pool, which pays an eighth of itself to one random registered arbiter at each jury draw. There is no treasury. The credit can fund another request or be claimed with `withdrawEth()`; arbiter owners, and whoever earned the draw and promote rewards, also withdraw their credited ETH from the aggregator. The worst-case prepayment is a budget, not a promise that part of it will be refunded.

See [Fee Mechanisms](docs/advanced/fees.md) and the [integration examples](docs/examples/index.md). The `scripts/` in `reputationBasedAggregator/` (such as `single-query.js` and `refund.js`) are v1 and not yet ported to v2; the [ETH payment note](docs/advanced/eth-payment-migration.md) is the v1 design history. For Verdikta Bounties, use its [current agent/API guide](https://bounties.verdikta.org/agents.txt): bounty rewards, evaluation prepayment, and network gas are separate ETH costs.

`ReputationSingleton` and `SimpleContract` retain legacy LINK-based implementations written for the v1 keeper. They are not the ETH-funded flow described above and do not work with the v2 keeper. The legacy LINK-funded aggregator (`ReputationAggregatorLINK.sol`) has been removed from the tree; its source is preserved at the `aggregator-v0.1.0` tag.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| **arbiterOperator/** | Chainlink-compatible operator with access-control restrictions, ensuring only approved contracts can request oracle services |
| **reputationBasedAggregator/** | The v2 contracts: ETH-funded commit-reveal aggregator with a per-request jury (K drawn, M promoted, N counted, P clustered), the ReputationKeeper and JuryBeacons. See its [README](reputationBasedAggregator/README.md) |
| **reputationBasedSingleton/** | Legacy LINK-funded single-oracle implementation |
| **demoClient/** | ETH-funded demo client for the v1 aggregator (not ported to v2) |
| **simpleContract/** | Legacy LINK-funded fixed-oracle contract for development and testing |
| **docs/** | MkDocs documentation site source |

Each subdirectory is a standalone Hardhat project with its own `contracts/`, `deploy/`, `scripts/`, `test/`, and `.env.example`.

## Deployed Contract Addresses (v1)

These are the deployed **v1** contracts. The v2 addresses are set at the v2 deployment. LINK addresses below are retained for Chainlink transport and legacy deployments; they do not mean requesters must fund or approve LINK for the ETH aggregator. Verdikta token addresses serve separate staking/reputation roles.

### Base (Mainnet)

| Contract | Address |
|----------|---------|
| v1 ReputationAggregator (ETH-funded) | `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` |
| LINK Token (transport / legacy) | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` |
| Wrapped Verdikta Token | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` |

### Base Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| v1 ReputationAggregator (ETH-funded) | `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` |
| LINK Token (transport / legacy) | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Verdikta Token | `0xe46F6b494F111d958CDBB52536AD78c4eEeB0149` |
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
# The v2 contracts (beacon branch)
cd reputationBasedAggregator

# Install dependencies
npm install

# Copy the example env file and fill in your keys
cp .env.example .env

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy in-process, then to Base Sepolia (aggregator, keeper + JuryBeacons, config)
npx hardhat deploy --tags aggregator,keeper,config
npx hardhat deploy --network base_sepolia --tags aggregator,keeper,config
```

## Documentation

Full documentation is available at **[https://verdikta.org](https://verdikta.org)**.

Key pages:

- [Deployment Guide](docs/deployment/index.md) — the v2 deploy scripts, wiring, operators adding the v2 keeper, and verification
- [Error Reference](docs/api/errors.md) — all custom errors and revert conditions
- [Events Reference](docs/api/events.md) — every event with parameters and lifecycle
- [Reputation System](docs/advanced/reputation.md) — two scores, points per round, settlement codes, blocks, bans and the freeze
- [Oracle Selection](docs/advanced/oracle-selection.md) — the two-phase draw, beacons, the shortlist, and K drawn → M promoted → N counted → P clustered
- [Security Model](docs/advanced/security.md) — the v2 threat model
- [Fee Mechanisms](docs/advanced/fees.md) — the quote, fee ceiling and floor, rewards, refunds, committer shares and the arbiter pool, with worked examples
- [Integration Walkthrough](docs/examples/integration.md) — a v2 client contract and a Node script that drives its round
- [Integration Examples](docs/examples/index.md) — client contracts, a Hardhat test and frontend code for the v2 aggregator
- [MIGRATION.md](reputationBasedAggregator/MIGRATION.md) — v1 → v2 for BountyEscrow, arbiter nodes, operators and scripts
- [ETH Payment Implementation](docs/advanced/eth-payment-migration.md) — history: the v1 move from LINK to ETH payment

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
