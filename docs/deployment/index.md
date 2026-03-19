# Deployment Guide

Step-by-step deployment procedures for each Verdikta Dispatcher component, deployed contract addresses, environment variable configuration, and post-deployment verification.

## Prerequisites

- **Node.js** (v18+) and npm
- **Hardhat** with `hardhat-deploy` and `@nomicfoundation/hardhat-toolbox`
- **Private keys** for deployer accounts (two accounts recommended: deployer + oracle operator)
- **LINK tokens** on the target network
- **VDKA tokens** (Wrapped Verdikta) for oracle staking
- **Infura API key** for RPC access
- **Etherscan/Basescan API key** for contract verification (optional but recommended)

## Supported Networks

| Network | Chain ID | LINK Token | Notes |
|---------|----------|------------|-------|
| **Base Sepolia** (testnet) | 84532 | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` | Primary testnet |
| **Base** (mainnet) | 8453 | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` | Production |
| **Ethereum Sepolia** (testnet) | 11155111 | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | Legacy testnet |
| localhost / hardhat | 31337 | N/A | Local development |

## Environment Variables

Create a `.env` file in each subproject directory.

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Primary deployer/owner private key | `fb...` |
| `PRIVATE_KEY_2` | Secondary key (oracle operator, optional) | `34...` |
| `INFURA_API_KEY` | Infura project ID for RPC endpoints | `66...` |

### Verification Variables

| Variable | Description |
|----------|-------------|
| `ETHERSCAN_API_KEY` | Etherscan API key (used for Etherscan V2 API across all chains) |
| `BASESCAN_API_KEY` | Basescan-specific API key (fallback) |

### Token Variables

| Variable | Network | Description |
|----------|---------|-------------|
| `WRAPPED_VERDIKTA_TOKEN` | Default | Wrapped VDKA token address |
| `WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA` | Base Sepolia | Network-specific override |
| `WRAPPED_VERDIKTA_TOKEN_BASE` | Base mainnet | Network-specific override |

### Optional Variables

| Variable | Description |
|----------|-------------|
| `SKIP_MIGRATIONS` | Set to any value to skip deployment scripts |

## Deployed Contract Addresses

### Base Sepolia (Testnet)

| Contract/Token | Address |
|----------------|---------|
| LINK Token | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Verdikta Token | `0xe46F6b494F111d958CDBB52536AD78c4eEeB0149` |
| Wrapped Verdikta Token (Aggregator) | `0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3` |
| Wrapped Verdikta Token (Singleton) | `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` |
| ReputationKeeper (Singleton) | `0xE09821277D9af702F7910a57e85EaC6D83e4d794` |

### Base (Mainnet)

| Contract/Token | Address |
|----------------|---------|
| LINK Token | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` |
| Wrapped Verdikta Token | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` |

### Ethereum Sepolia (Testnet)

| Contract/Token | Address |
|----------------|---------|
| LINK Token | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| Verdikta Token | `0xbb7079F45367ce928789cc40d8C9D4E3A19b0a49` |

## Deployment Procedures

All projects use `hardhat-deploy` unless otherwise noted. Deployments are run via `npx hardhat deploy --network <network>`.

### 1. ReputationAggregator + ReputationKeeper

This is the primary deployment. Located in `reputationBasedAggregator/`.

```bash
cd reputationBasedAggregator
npm install
```

The deployment runs three sequential scripts:

#### Step 1: Deploy ReputationAggregator (`deploy/01_aggregator.js`)

Deploys the aggregator with a **dummy keeper address** (zero address). The real keeper is wired in step 2.

```bash
npx hardhat deploy --tags aggregator --network base_sepolia
```

Constructor args: `(linkTokenAddress, address(0))`

The LINK token address is resolved by network:
- Base Sepolia: `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`
- Base mainnet: `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196`
- Sepolia: `0x779877A7B0D9E8603169DdbD7836e478b4624789`

#### Step 2: Deploy ReputationKeeper (`deploy/02_keeper.js`)

Deploys the keeper and wires it bidirectionally to the aggregator:

1. Deploys `ReputationKeeper(wrappedVerdiktaTokenAddress)`
2. Calls `keeper.approveContract(aggregatorAddress)` — allows the aggregator to select oracles and update scores
3. Calls `aggregator.setReputationKeeper(keeperAddress)` — points the aggregator at the keeper

```bash
npx hardhat deploy --tags keeper --network base_sepolia
```

The Wrapped Verdikta token address is resolved from environment variables in order of preference:
1. `WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA` (for Base Sepolia)
2. `WRAPPED_VERDIKTA_TOKEN_BASE` (for Base mainnet)
3. `WRAPPED_VERDIKTA_TOKEN` (generic fallback)

#### Step 3: Configure (`deploy/03_config.js`)

Sets operational parameters on both contracts:

1. Verifies/sets the VDKA token address in the keeper
2. Calls `aggregator.setConfig(6, 4, 3, 2, 300)` — K=6, M=4, N=3, P=2, timeout=300s
3. Calls `aggregator.setMaxOracleFee(0.05 LINK)`

```bash
npx hardhat deploy --tags config --network base_sepolia
```

#### All-in-one Deployment

```bash
npx hardhat deploy --network base_sepolia
```

This runs all three scripts in order (01 → 02 → 03) via `hardhat-deploy` dependency resolution.

### 2. ReputationSingleton

Located in `reputationBasedSingleton/`. Uses an **existing** ReputationKeeper deployment.

```bash
cd reputationBasedSingleton
npm install
```

#### Step 1: Deploy Singleton (`deploy/01_singleton.js`)

Reads `keeper` and `linkToken` addresses from `deployment-addresses.json` (base_sepolia section).

```bash
npx hardhat deploy --tags ReputationSingleton --network base_sepolia
```

Constructor args: `(linkTokenAddress, keeperAddress)`

#### Step 2: Configure (`deploy/02_config.js`)

Performs several wiring and verification steps:

1. Reads the keeper address from `deployment-addresses.json`
2. Probes `keeper.isContractApproved(singletonAddress)` to check if already approved
3. Calls `keeper.approveContract(singletonAddress)` if needed
4. Verifies `selectOracles` connectivity by calling it as the singleton
5. Cross-checks LINK token consistency between singleton and operator contracts

```bash
npx hardhat deploy --tags ConfigSingleton --network base_sepolia
```

### 3. ArbiterOperator

Located in `arbiterOperator/`. This is the oracle node's operator contract.

```bash
cd arbiterOperator
npm install
npx hardhat run scripts/deploy.js --network base_sepolia
```

**Note:** The ArbiterOperator uses a direct deploy script (`scripts/deploy.js`), not `hardhat-deploy`.

Constructor args: `(linkTokenAddress)`

#### Post-Deployment: Wire to ReputationKeeper

```bash
# Add the ReputationKeeper to the operator's allowlist
npx hardhat run scripts/manageReputationKeepers.js --network base_sepolia

# Set authorized senders (Chainlink node addresses)
npx hardhat run scripts/setAuthorizedSenders.js --network base_sepolia
```

### 4. SimpleContract

Located in `simpleContract/`. Pre-configured with a fixed oracle.

```bash
cd simpleContract
npm install
npx hardhat deploy --network base_sepolia
```

Edit `deploy/01_simple_contract.js` to set your oracle address, job ID, fee, and class before deploying.

Current hardcoded defaults for Base Sepolia:
- Oracle: `0x00A08b75178de0e0d7FF13Fdd4ef925AC3572503`
- Job ID: `6c751f1a36f348dc8655c11e0f804b31` (16 bytes, right-padded to bytes32)
- Fee: `0.01 LINK`
- LINK: `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`
- Class: `128`

### 5. DemoClient

Located in `demoClient/`. A test client contract for end-to-end verification.

```bash
cd demoClient
npm install
npx hardhat deploy --network base_sepolia
```

Edit `deploy/01_demo_client.js` to set the aggregator address and LINK token address.

Current hardcoded defaults for Base Sepolia:
- Aggregator: `0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02`
- LINK: `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`

## Post-Deployment Verification

### Contract Verification on Block Explorer

All deploy scripts include automatic verification via Etherscan V2 API with retry logic (up to 4 attempts, 15-second delay). If automatic verification fails, verify manually:

```bash
npx hardhat verify --network base_sepolia \
  --contract contracts/ReputationAggregator.sol:ReputationAggregator \
  <address> <linkToken> <keeperAddress>
```

### Smoke Test Checklist

1. **Keeper wiring:**
   ```javascript
   const keeper = await aggregator.reputationKeeper();
   // Should return the deployed keeper address, not address(0)
   ```

2. **Contract approval:**
   ```javascript
   const approved = await keeper.isContractApproved(aggregatorAddress);
   // Should return true
   ```

3. **Oracle registration:** Register at least one oracle, then verify:
   ```javascript
   const count = await keeper.getRegisteredOraclesCount();
   // Should be >= 1
   ```

4. **LINK funding:** Transfer LINK to a test account and run a demo query:
   ```bash
   cd demoClient
   npx hardhat run scripts/transfer-link.js --network base_sepolia -- <demoClientAddress> 0.5
   npx hardhat run scripts/query-demo.js --network base_sepolia -- <demoClientAddress>
   ```

### Oracle Registration Verification

After deploying an ArbiterOperator and registering it with the ReputationKeeper:

```bash
cd reputationBasedAggregator
npx hardhat run scripts/register-oracle.js --network base_sepolia
npx hardhat run scripts/monitor-contracts.js --network base_sepolia
```

## Compiler Configuration

| Project | Solidity Version | Optimizer | viaIR |
|---------|-----------------|-----------|-------|
| reputationBasedAggregator | 0.8.30 | 200 runs | Yes |
| reputationBasedSingleton | 0.8.30 | 200 runs | Yes |
| arbiterOperator | 0.8.19 | 200 runs | No |
| simpleContract | 0.8.21 | 200 runs | No |
| demoClient | 0.8.19 | 200 runs | No |

## Network-Specific Notes

### Base Sepolia

- Recommended gas price: 300 Mwei (`gasPrice: 300_000_000` in hardhat config)
- Block confirmations: 2
- LINK faucet: Available via Chainlink faucet

### Base Mainnet

- Uses EIP-1559 fee estimation (no fixed gas price)
- Block confirmations: 2
- Deployment uses `deterministicDeployment: false` (ordinary CREATE, not CREATE2)

### Ethereum Sepolia

- Gas price: 10 Gwei
- Gas limit: 18.5M
- Block confirmations: 1

## Utility Scripts

The `reputationBasedAggregator/scripts/` directory contains several operational tools:

| Script | Purpose |
|--------|---------|
| `register-oracle.js` | Register an oracle with the keeper |
| `unregister-oracle.js` | Deregister an oracle |
| `monitor-contracts.js` | Monitor contract state and events |
| `oracle-poller.js` | Poll oracle status |
| `approve-link.js` | Approve LINK spending |
| `configure-contracts.js` | Update contract configuration |
| `reset-reputations-cl.js` | Reset all reputation scores |
| `single-query.js` | Submit a single test query |
| `agg-history.js` | View aggregation history |
| `withdraw-link-from-oracle.js` | Withdraw LINK from oracle contract |
| `show-gas.js` | Display gas usage statistics |
