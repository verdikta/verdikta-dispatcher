# Deployment Guide

Step-by-step deployment of the v2 contracts, the wiring between them, the arbiter operators' part, environment variables, deployed (v1) addresses and post-deployment checks.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 against [`reputationBasedAggregator/deploy/`](https://github.com/verdikta/verdikta-dispatcher/tree/beacon/reputationBasedAggregator/deploy) (`01_aggregator.js`, `02_keeper.js`, `03_config.js`) on the `beacon` branch, which were run on Hardhat's in-process network (`npx hardhat deploy --tags aggregator,keeper,config`). **v2 is not deployed on any public network yet**, so no v2 address exists: they are set at the v2 deployment. v2 is a redeploy, not an upgrade: a new keeper, aggregator and `JuryBeacons`, and every arbiter registers again. The addresses below are those of the deployed **v1** contracts (tag `aggregator-v0.1.0`). ReputationSingleton and SimpleContract are legacy contracts paid in LINK and written for the v1 keeper.

## Prerequisites

- **Node.js** (v18+) and npm
- **Hardhat** with `hardhat-deploy` and `@nomicfoundation/hardhat-toolbox`
- **A deployer key** with ETH on the target network, for gas and for test requests
- **VDKA tokens** (Wrapped Verdikta) for arbiter stakes (100 VDKA per arbiter by default)
- **LINK** only for the legacy ReputationSingleton or SimpleContract. The v2 aggregator needs none
- **An RPC endpoint** (Infura key, or a public URL)
- **Etherscan/Basescan API key** for contract verification (optional but recommended)

## Supported Networks

| Network | Chain ID | LINK Token | Notes |
|---------|----------|------------|-------|
| **Base Sepolia** (testnet) | 84532 | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` | Primary testnet; the v2 testnet run is planned here (TODO item 16) |
| **Base** (mainnet) | 8453 | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` | Production |
| **Ethereum Sepolia** (testnet) | 11155111 | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | Legacy testnet; `01_aggregator.js` has no LINK address for it |
| localhost / hardhat | 31337 | deployed by the script | Local development: a `MockLinkToken` and a `TestToken` are deployed |

The aggregator takes the LINK token address in its constructor because its requests still travel over the Chainlink request path, with a LINK amount of zero. A requester holds and approves no LINK.

v2 also needs the EIP-2935 block-hash history contract at `0x0000F90827F1C53a10cb7A02335B175320002935` (live on Base, checked 2026-11-17): the draw reads `blockhash(B+1)` from it once the block is more than 256 blocks old.

## Environment Variables

Create a `.env` file in `reputationBasedAggregator/`.

### Required Variables

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Deployer and owner key |
| `PRIVATE_KEY_2` | Second key (optional) |
| `INFURA_API_KEY` | Infura project ID, unless `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` are set |

### Token Variables

| Variable | Network | Description |
|----------|---------|-------------|
| `WRAPPED_VERDIKTA_TOKEN_BASE` | Base mainnet | The stake token for the keeper |
| `WRAPPED_VERDIKTA_TOKEN_BASE_SEPOLIA` | Base Sepolia | Same, testnet |
| `WRAPPED_VERDIKTA_TOKEN` | any other non-local network | Fallback |

There is no treasury to configure: `TREASURY_ADDRESS` is no longer read (an older `.env` may still set it; it is ignored). The prepay that would be a free re-roll goes to the round's committers or to the aggregator's arbiter pool (see [Fee Mechanisms](../advanced/fees.md#refunds-and-the-arbiter-pool)).

### Verification and Other Variables

| Variable | Description |
|----------|-------------|
| `ETHERSCAN_API_KEY` | Etherscan V2 API key (all chains) |
| `BASESCAN_API_KEY` | Basescan key (fallback) |
| `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL` | RPC overrides |
| `SKIP_MIGRATIONS` | Set to any value to skip the deploy scripts |

## Deployed Contract Addresses (v1)

These are the v1 contracts, which speak the v1 interface (7-argument request, `maxTotalFee(fee)`, `finalizeEvaluationTimeout`). The v2 addresses are set at the v2 deployment.

### Base Sepolia (Testnet), v1

| Contract/Token | Address |
|----------------|---------|
| v1 ReputationAggregator (ETH-funded) | `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` |
| v1 ReputationKeeper (that aggregator's `reputationKeeper()`; also the Singleton's keeper) | `0xE09821277D9af702F7910a57e85EaC6D83e4d794` |
| Wrapped Verdikta Token staked in that keeper | `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` |
| LINK Token (Chainlink request path, legacy contracts) | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Verdikta Token | `0xe46F6b494F111d958CDBB52536AD78c4eEeB0149` |
| Earlier aggregator, not the ETH-funded contract | `0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02` |
| Wrapped Verdikta Token staked in the earlier aggregator's keeper | `0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3` |

### Base (Mainnet), v1

| Contract/Token | Address |
|----------------|---------|
| v1 ReputationAggregator (ETH-funded) | `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` |
| v1 ReputationKeeper | `0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0` |
| Wrapped Verdikta Token (the v1 keeper's `verdiktaToken()`) | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` |
| LINK Token (Chainlink request path, legacy contracts) | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` |

### Ethereum Sepolia (Testnet)

| Contract/Token | Address |
|----------------|---------|
| LINK Token | `0x779877A7B0D9E8603169DdbD7836e478b4624789` |
| Verdikta Token | `0xbb7079F45367ce928789cc40d8C9D4E3A19b0a49` |

## Deployment Procedures

### 1. The v2 Contracts: Aggregator, Keeper and JuryBeacons

Located in `reputationBasedAggregator/`. One aggregator serves every jury size: each request carries its own jury.

```bash
cd reputationBasedAggregator
npm install
npx hardhat test                                    # all tests, a few minutes
npx hardhat deploy --tags aggregator,keeper,config  # in-process dry run
```

`./deploy.sh` runs the same three tags against `NET` (default `base_sepolia`):

```bash
NET=base_sepolia ./deploy.sh
# or
npx hardhat deploy --network base_sepolia --tags aggregator,keeper,config
```

#### Step 1: Libraries and Aggregator (`deploy/01_aggregator.js`, tag `aggregator`)

1. Deploys the two external libraries, `AggregatorLib` (payload, CID and salt parsing, hex, the jury check) and `ScoringLib` (cluster, quality classes, promotion draw). They are linked, so the aggregator stays under the 24 KB code-size limit.
2. Deploys `ReputationAggregator(linkToken, address(0))`, linked to both libraries. The keeper is set in step 2.

The LINK address is chosen by network (Base, Base Sepolia); local networks get a `MockLinkToken` (the request path needs an ERC-677 `transferAndCall`). On any other network the script stops with `No LINK token address configured for network`.

#### Step 2: Keeper, JuryBeacons and Wiring (`deploy/02_keeper.js`, tag `keeper`)

1. Deploys `ReputationKeeper(stakeToken)`, with the token from the variables above (a `TestToken` on local networks).
2. Deploys `JuryBeacons(keeper)`. Its keeper is immutable.
3. Wires them, each step skipped if already done:
   - `keeper.setApproved(aggregator, true)`: the aggregator selects juries and reports outcomes;
   - `keeper.setApproved(beacons, true)`: JuryBeacons picks beacons;
   - `beacons.setApproved(aggregator, true)`: the aggregator starts beacon stages;
   - `aggregator.setContracts(keeper, beacons)`: two arguments, the keeper and the beacon contract.

`setContracts` does not check that the beacon contract uses the same keeper, which is why the script deploys them as a pair. Don't swap the keeper while rounds await settlement, or the beacon contract while a round is in its beacon stage.

#### Step 3: Configure (`deploy/03_config.js`, tag `config`)

1. Checks that the keeper's `shortlistSize()` (60) is at least the largest jury.
2. `aggregator.setLimits(50, 3600, 155)`: juries up to K = 50, timeouts up to 3,600 s, T+ 155 s (the measured mean plus two SDs of honest commit latency). Every request's timeout must exceed T+.
3. `aggregator.setParams(3, 2, 250000, 30000, 0.0004 ETH)`: bonus multiplier 3, settle due rounds up to 2 × the request's K slots per request, a 250k-gas dispatch stipend, a spread floor of 30,000 (3 points), and a fee ceiling of 0.0004 ETH (`4e14` wei).

The class presets (Small 6/5/4/3/300 s, Medium 8/5/4/3/300 s, Large 21/16/13/10/300 s, Jumbo 50/38/27/17/600 s with beacons) are not set on-chain: they live with the consumers (the bounty program's `shared/classPresets.js`). `JuryBeacons` keeps its defaults (4 polled, the first 2 used, 120 s), and the keeper its own (stake 100 VDKA, unbonding 2 days, call deadline 60 s, shortlist 60, `maxScan` 400; see [Reputation System](../advanced/reputation.md#configurable-parameters)). The draw and promote rewards (2 and 1 fees, 30 s requester priority, 120 s reveal window) are the aggregator's constructor defaults, changed with `setRewards`.

### 2. ArbiterOperator: Adding the v2 Keeper

Located in `arbiterOperator/`. Each arbiter's Chainlink operator contract.

```bash
cd arbiterOperator
npm install
npx hardhat run scripts/deploy.js --network base_sepolia          # new operators only
```

Constructor args: `(linkTokenAddress)`. Every operator, new or existing, must then accept the v2 aggregator's requests. Its gate asks each keeper on its list `isContractApproved(requester)`, and the v2 keeper approves the v2 aggregator, so **each operator owner calls `addReputationKeeper(<v2 keeper>)`** on its operator. `addReputationKeeper` is owner-only and checks that the keeper answers `isContractApproved`. Without it every dispatch to that operator reverts and the aggregator skips its slot. An operator with an empty keeper list accepts every requester, so keep a keeper on it.

```bash
# Add a keeper to the operator's allowlist (edit the keeper address in the script)
npx hardhat run scripts/manageReputationKeepers.js --network base_sepolia

# Authorize the Chainlink node's keys to fulfil and to answer health calls
npx hardhat run scripts/setAuthorizedSenders.js --network base_sepolia
```

### 3. Registering Arbiters with the v2 Keeper

Every arbiter registers again with the v2 keeper; v1 registrations do not carry over. The repository's `register-oracle.js` scripts are v1 and not ported (see [MIGRATION.md](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md)); the arbiter node's `beacon` branch generates the hash chain. The calls:

1. `stakeToken.approve(keeper, stakeRequirement)` (100 VDKA by default), from the operator's owner.
2. `keeper.registerArbiter(operator, jobId, fee, classes, chainHead)`: the caller must be the operator's `owner()` or the keeper owner; `fee` in ETH wei (`uint64`, above 0, at most `maxOracleFee()` to be selectable); 1 to 5 `uint64` classes; `chainHead` the head of the node's hash chain, or 0 to let the node's health job set it (the arbiter starts frozen until then).
3. The node's health job answers `HealthCall`s with `rotateChain(key, preimage, preimage)` within `callDeadline` (60 s), from an authorized sender of the operator.

`keyOf(operator, jobId)` gives the arbiter's key; `getArbiter(key)` its state. To leave: `requestExit(key)`, then `completeExit(key)` after the unbonding period (2 days). See [ReputationKeeper](../contracts/reputation-keeper.md).

### 4. ReputationSingleton (legacy, LINK, v1 keeper)

Located in `reputationBasedSingleton/`. A legacy contract that is paid in LINK. Uses an **existing v1** ReputationKeeper deployment. It calls the v1 keeper's `selectOracles`, and its config script calls `approveContract`; the v2 keeper has neither (it has `selectArbiters` and `setApproved`), so the Singleton does not work with v2.

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

### 5. SimpleContract (legacy, LINK)

Located in `simpleContract/`. A legacy development and test contract that is paid in LINK. Pre-configured with a fixed oracle.

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

### 6. DemoClient (v1)

Located in `demoClient/`. The DemoClient still speaks the v1 interface (a 7-argument request and `maxTotalFee(fee)`) and has not been ported to v2, so it works only with a v1 aggregator. For a v2 client see the [Smart Contract Integration Walkthrough](../examples/integration.md).

## Post-Deployment Verification

### Contract Verification on Block Explorer

The deploy scripts verify each contract through the Etherscan V2 API, with up to 4 attempts 15 seconds apart, when an API key is set. The aggregator is library-linked, so a manual verification names the libraries:

```bash
npx hardhat verify --network base_sepolia \
  --contract contracts/ReputationAggregator.sol:ReputationAggregator \
  --libraries libraries.js \
  <aggregator> <linkToken> 0x0000000000000000000000000000000000000000
```

with `libraries.js` exporting `{ AggregatorLib: "<address>", ScoringLib: "<address>" }`. The constructor arguments are the ones the contract was deployed with: the zero address as keeper, set afterwards with `setContracts`. `verify.sh` and `size-contracts.sh` in the folder are v1 and omit `JuryBeacons` and the libraries.

### Smoke Test Checklist

1. **Wiring:**
   ```javascript
   await aggregator.keeper();     // the keeper's address, not address(0)
   await aggregator.beacons();    // JuryBeacons
   await aggregator.ethOwed(ethers.ZeroAddress);   // the arbiter pool: 0 on a fresh deployment
   await keeper.approvedContracts(aggregator.target);   // true
   await keeper.isContractApproved(aggregator.target);  // true (what operators ask)
   await keeper.approvedContracts(beacons.target);      // true
   await beacons.approved(aggregator.target);           // true
   ```

2. **Limits and fees:**
   ```javascript
   await aggregator.maxJury();       // 50
   await aggregator.maxTimeout();    // 3600
   await aggregator.tPlus();         // 155
   await aggregator.maxOracleFee();  // 400000000000000 (0.0004 ETH)
   await keeper.shortlistSize();     // 60, at least maxJury
   // Small at the ceiling: 4e14 x (6 + 3 x 3) + 4e14 x (2 + 1) = 7.2e15
   await aggregator.maxTotalFee(4n * 10n ** 14n, 0, false, 6, 3);
   ```

3. **Arbiters:** after the operators have added the v2 keeper and their owners have registered:
   ```javascript
   await keeper.classSize(128);               // entries in the class list
   await keeper.eligibleCount(128, 4n * 10n ** 14n);   // eligible now, at the ceiling
   await keeper.getArbiter(await keeper.keyOf(operator, jobId));
   ```
   An arbiter that does not answer its first health call within 60 s is frozen and not eligible.

4. **A round end to end.** Send a request with a Small jury, call `drawJury` from two blocks later, `promote` once the commit phase has closed (and `closeCommits` if it is still open after 155 s with at least 5 commits), and read `getEvaluation`. The JavaScript in [Integration Examples](../examples/index.md#frontend-integration-examples) drives each step. The repository's `single-query.js` and `refund.js` are v1 and not ported. The v2 testnet milestone (TODO item 16) is a Small round and a Jumbo round with beacons completing end to end, including a failed round and a settlement.

## Compiler Configuration

| Project | Solidity Version | Optimizer | viaIR |
|---------|-----------------|-----------|-------|
| reputationBasedAggregator | 0.8.30 | 20 runs (200 until 2026-11-25; lowered to fit the aggregator under the 24,576-byte limit: 24,500 B) | Yes |
| reputationBasedSingleton | 0.8.30 | 200 runs | Yes |
| arbiterOperator | 0.8.19 | 200 runs | No |
| simpleContract | 0.8.21 | 200 runs | No |
| demoClient (v1) | 0.8.30 | 200 runs | Yes |

## Network-Specific Notes

### Base Sepolia

- Gas price in the hardhat config: 1 gwei in `reputationBasedAggregator` (`gasPrice: 1_000_000_000`), 300 Mwei in `demoClient` (`gasPrice: 300_000_000`)
- Block confirmations: 2
- LINK faucet: Available via Chainlink faucet (needed for the legacy LINK-paid contracts only)

### Base Mainnet

- Uses EIP-1559 fee estimation (no fixed gas price)
- Block confirmations: 2
- Deployment uses `deterministicDeployment: false` (ordinary CREATE, not CREATE2)

### Ethereum Sepolia

- Gas price: 10 Gwei
- Gas limit: 18.5M
- Block confirmations: 1

## Utility Scripts

The scripts in `reputationBasedAggregator/scripts/` were written for v1 and have not been ported: on this branch `ethers.getContractAt("ReputationAggregator", …)` gets the v2 ABI, so run them against the live v1 contracts from a checkout of the `aggregator-v0.1.0` tag. [MIGRATION.md](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md#scripts-in-this-folder) lists each one with its v2 replacement:

| Script (v1) | v2 replacement |
|-------------|----------------|
| `register-oracle.js` | `registerArbiter` with a chain head; `getArbiter(key)` |
| `unregister-oracle.js` | `requestExit`, then `completeExit` after 2 days |
| `reset-reputations-cl.js` | none (no reset in v2) |
| `monitor-contracts.js`, `oracle-poller.js`, `agg-history.js` | `ArbiterRegistered` events, `classSize`, `getArbiter`, `getJury`, `getRoundInfo` |
| `configure-contracts.js` | `setApproved`, `setLimits`, `setParams`, `setContracts` (or `deploy/`) |
| `single-query.js` | the 10-argument request, `maxTotalFee(fee, floor, flag, K, P)`, then `drawJury` and `promote` |
| `refund.js` | `settle`, `getRoundInfo`, `withdrawEth` |
| `approve-link.js`, `withdraw-link-from-oracle.js`, `show-gas.js` | unchanged calls; check before use |

`deploy.sh` runs `deploy/` and works with v2; `deploy_aggregatorOnly.sh` runs a v1 script.
