# Fee Mechanisms

Every fee, who pays it, when it is charged, and how LINK flows through the Verdikta Dispatcher system end to end.

## Token Overview

The Verdikta system uses two tokens:

| Token | Purpose | Held By |
|-------|---------|---------|
| **LINK** (Chainlink) | Pays oracles for evaluations and bonus rewards | Requesters, aggregator/singleton contracts, oracle operators |
| **VDKA** (Verdikta / Wrapped Verdikta) | Staked by oracle operators as collateral | Oracle operators, ReputationKeeper contract |

## Fee Flows by Contract

### ReputationAggregator

The ReputationAggregator has the most complex fee structure due to its multi-oracle commit-reveal design.

#### Who Pays

The **requester** (the `msg.sender` of `requestAIEvaluationWithApproval`) pays all fees. LINK is pulled from the requester's wallet via `transferFrom`.

#### Fee Breakdown

| Fee Component | Amount | When Charged | Recipient |
|---------------|--------|-------------|-----------|
| **Commit-phase base fees** | Each oracle's registered `fee` (K transfers) | At request creation, one `transferFrom` per oracle | Each oracle via Chainlink `transferAndCall` through the ArbiterOperator |
| **Reveal-phase fees** | 0 (reveal requests carry zero LINK) | N/A | N/A |
| **Bonus payments** | `pollFees[slot] × bonusMultiplier` per clustered oracle | At finalization, pulled from requester via `transferFrom` | Each clustered oracle directly |

#### Maximum Total Fee Calculation

```solidity
function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
    uint256 eff = min(requestedMaxOracleFee, maxOracleFee);
    return eff * (commitOraclesToPoll + bonusMultiplier * clusterSize);
    //     eff * (        K           +       B       *      P      )
}
```

With defaults (K=6, B=3, P=2):

```
maxTotalFee = eff × (6 + 3 × 2) = eff × 12
```

**Example:** If `maxOracleFee = 0.05 LINK`, maximum possible cost is `0.05 × 12 = 0.6 LINK`.

**Important:** The actual cost is typically lower because:
- Individual oracle fees may be less than `maxOracleFee`
- Only P oracles (those in the best cluster) receive bonuses
- Bonuses use each oracle's actual registered fee, not `maxOracleFee`

#### LINK Flow Diagram

```
Requester Wallet
    │
    ├─── transferFrom(fee₁) ──→ Aggregator ──→ sendOperatorRequestTo ──→ Oracle 1 (via ArbiterOperator)
    ├─── transferFrom(fee₂) ──→ Aggregator ──→ sendOperatorRequestTo ──→ Oracle 2
    ├─── ...                                                           ──→ Oracle K
    │
    │   (After finalization, for each of the P clustered oracles:)
    ├─── transferFrom(fee × B) ──→ Clustered Oracle 1 (direct transfer)
    └─── transferFrom(fee × B) ──→ Clustered Oracle 2
```

#### LINK Approval Requirement

The requester must approve the aggregator contract to spend at least `maxTotalFee(maxOracleFee)` LINK tokens **before** calling `requestAIEvaluationWithApproval`. Critically, the approval must remain valid through finalization — bonuses are pulled from the requester's wallet when the evaluation completes, which may be minutes after the initial request.

If the requester's allowance is insufficient at bonus-payment time, the bonus transfer fails with `BonusTransferFailed()`. The evaluation itself still completes (results are stored), but the affected clustered oracle does not receive its bonus.

### ReputationSingleton

The ReputationSingleton uses a simpler 2× fee model.

#### Fee Breakdown

| Fee Component | Amount | When Charged | Recipient |
|---------------|--------|-------------|-----------|
| **Base fee + bonus** | `oracleFee × 2` pulled upfront | At request creation, single `transferFrom` into the contract | Contract holds both portions |
| **Base fee** | `oracleFee` | Sent with the Chainlink request | Oracle via `sendChainlinkRequestTo` |
| **Bonus payment** | `oracleFee` (1× multiplier) | At fulfillment, transferred from contract balance | Oracle directly via `link.transfer()` |

#### Maximum Total Fee Calculation

```solidity
function maxTotalFee(uint256 requested) public view returns (uint256) {
    uint256 eff = min(requested, maxOracleFee);
    return eff * 2;  // base + bonus
}
```

#### Estimated Base Cost

The ReputationSingleton provides a helper for computing the `estimatedBaseCost` parameter used in oracle selection:

```solidity
function getEstimatedBaseCost() public view returns (uint256) {
    return (maxOracleFee * baseFeePct) / 100;   // baseFeePct default: 1%
}
```

#### LINK Flow

```
Requester Wallet
    │
    └─── transferFrom(oracleFee × 2) ──→ Singleton Contract
                                              │
                                              ├─── sendChainlinkRequestTo(oracleFee) ──→ Oracle
                                              │
                                              └─── transfer(oracleFee) ──→ Oracle (bonus, on fulfillment)
```

**Key difference from Aggregator:** The ReputationSingleton pulls `2 × oracleFee` upfront into the contract, then pays the bonus from its own balance at fulfillment. The requester's LINK allowance is fully consumed at request time. If the evaluation times out, the bonus LINK remains in the contract (recoverable by owner via `withdrawLink`).

### SimpleContract

The SimpleContract has the simplest fee model with a fixed oracle.

#### Fee Breakdown

| Fee Component | Amount | When Charged | Recipient |
|---------------|--------|-------------|-----------|
| **Base fee** | Contract's configured `fee` | At request creation, pulled from requester into contract | Oracle via Chainlink `_sendChainlinkRequest` |
| **Bonus payment** | Same as base `fee` | At fulfillment, pulled from requester by the contract | Oracle via `transferFrom(requester, msg.sender, fee)` |

#### Maximum Total Fee

```solidity
function maxTotalFee(uint256) external view returns (uint256) {
    return fee * 2;  // parameter is ignored; uses the fixed configured fee
}
```

#### LINK Flow

```
Requester Wallet
    │
    ├─── transferFrom(fee) ──→ SimpleContract ──→ sendChainlinkRequest ──→ Oracle
    │
    │   (At fulfillment, contract pulls bonus directly from requester:)
    └─── transferFrom(fee) ──→ Oracle (bonus, pulled during fulfill callback)
```

**Key difference:** The bonus in SimpleContract is pulled directly from the requester by the contract during the `fulfill` callback via `link.transferFrom(requester, msg.sender, fee)` — the requester's allowance for the SimpleContract must persist through fulfillment.

## VDKA Staking

Oracle operators must stake VDKA tokens to register with the ReputationKeeper.

| Parameter | Value | Description |
|-----------|-------|-------------|
| **Stake requirement** | 100 VDKA (`STAKE_REQUIREMENT = 100 × 10¹⁸`) | Fixed amount required to register each oracle/jobId |
| **Slash amount** | Configurable via `setSlashAmount()` (default: 0 VDKA) | Amount deducted per slash event |

### Staking Flow

```
Oracle Owner Wallet
    │
    └─── approve(keeper, 100 VDKA)
    └─── registerOracle(oracle, jobId, fee, classes)
              └──→ transferFrom(caller, keeper, 100 VDKA)
```

The staker must be either the oracle contract owner (`IOracleOwner(oracle).owner()`) or the ReputationKeeper contract owner.

### Unstaking Flow

```
deregisterOracle(oracle, jobId)
    │
    └──→ transfer(oracleOwner, remainingStake)
```

Stake is returned to `IOracleOwner(_oracle).owner()`, not necessarily to the original staker. The oracle must not be locked (`block.timestamp >= lockedUntil`).

### Slashing

When an oracle crosses a penalty threshold (see [Reputation System](reputation.md)):
- `stakeAmount -= slashAmountConfig`
- If `stakeAmount < slashAmountConfig`, stake is set to 0
- Slashed tokens remain in the ReputationKeeper contract (not burned)
- The owner can recover slashed tokens via standard ERC-20 transfers from the keeper

## Fee Configuration

### ReputationAggregator Settings

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `maxOracleFee` | 0.1 LINK (set to 0.05 LINK by deploy script) | `setMaxOracleFee(uint256)` | Ceiling on per-oracle fee; `maxTotalFee()` uses `min(requested, maxOracleFee)` |
| `bonusMultiplier` | 3 | `setBonusMultiplier(uint256)` | Bonus multiplier for clustered oracles (0–20×) |
| `commitOraclesToPoll` (K) | 6 | `setConfig(K,M,N,P,timeout)` | Oracles polled in commit phase (affects base fee count) |
| `clusterSize` (P) | 2 | `setConfig(K,M,N,P,timeout)` | Cluster size (affects number of bonus payments) |

### ReputationSingleton Settings

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `maxOracleFee` | 0.1 LINK | `setMaxOracleFee(uint256)` | Ceiling on per-oracle fee |
| `baseFeePct` | 1 | `setBaseFeePct(uint256)` | Percentage of `maxOracleFee` used as base cost estimate (1–100%) |
| `maxFeeBasedScalingFactor` | 10 | `setMaxFeeBasedScalingFactor(uint256)` | Cap on fee advantage for cheap oracles |
| `alpha` | 500 | `setAlpha(uint256)` | Default reputation weight factor (0–1000) |

### SimpleContract Settings

The SimpleContract's `fee` is set at deployment and is not dynamically configurable (no `onlyOwner` setter pattern).

### Oracle Fee Registration

Each oracle registers with a specific LINK fee via `registerOracle(..., fee, ...)`. This fee is what the oracle charges per request. Oracles with fees above a request's `maxFee` parameter are excluded from selection. The fee must be greater than 0.

## Emergency LINK Withdrawal

All aggregation contracts provide a `withdrawLink(address payable to, uint256 amount)` function for recovering LINK tokens that may be stuck in the contract (e.g., from failed evaluations, unused bonus pools, or unclaimed funds).

| Contract | Access Control | Error on Failure |
|----------|---------------|-----------------|
| ReputationAggregator | `onlyOwner` | `LinkTransferFailed()` (custom error) |
| ReputationSingleton | `onlyOwner` | Standard ERC-20 revert |
| SimpleContract | **No access control** (test contract) | Standard ERC-20 revert |

## Practical Fee Guidance

### For Requesters

1. **Calculate max cost** before submitting: call `maxTotalFee(yourMaxFee)` on the contract
2. **Approve sufficient LINK**: `link.approve(contractAddress, maxTotalFee)` — for ReputationAggregator, the approval must persist through finalization (minutes after request)
3. **Set `maxFee` conservatively**: Lower values filter out expensive oracles but may reduce oracle availability. Check that oracles are registered with fees below your limit.

### For Oracle Operators

1. **Set competitive fees**: Lower fees increase selection probability via [fee weighting](oracle-selection.md)
2. **Fee earnings per request**:
   - ReputationAggregator: `fee` per commit request + `fee × bonusMultiplier` if clustered
   - ReputationSingleton: `fee` as base + `fee` as bonus on fulfillment
   - SimpleContract: `fee` as base + `fee` as bonus on fulfillment

### Cost Comparison

| Contract | Min Cost | Max Cost | Formula |
|----------|----------|----------|---------|
| SimpleContract | `2 × fee` | `2 × fee` | Fixed: base + bonus |
| ReputationSingleton | `2 × oracleFee` | `2 × maxOracleFee` | 2 × selected oracle's fee |
| ReputationAggregator | `sum(K fees)` | `sum(K fees) + B × P × max_fee` | Base fees + bonus pool |
