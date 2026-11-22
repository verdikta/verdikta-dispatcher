# Fee Mechanisms

Every fee, who pays it, when it is charged, and how payment flows through the Verdikta Dispatcher system end to end.

!!! note "Checked against the code"
    Revised on 2026-11-22 against the contracts in [`reputationBasedAggregator/contracts`](https://github.com/verdikta/verdikta-dispatcher/tree/master/reputationBasedAggregator/contracts) and against the aggregator deployed on Base mainnet at [`0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`](https://basescan.org/address/0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a). The ReputationAggregator is paid in ETH. ReputationSingleton and SimpleContract are legacy contracts that are still paid in LINK. Values that the contracts' owner can change are given with the function that returns the current value.

## Token Overview

| Token | Purpose | Held By |
|-------|---------|---------|
| **ETH** | Pays oracles for evaluations made through the ReputationAggregator: base fees and bonus rewards | Requesters, the aggregator contract (escrow and `ethOwed` ledger), oracle owners |
| **LINK** (Chainlink) | Pays oracles for evaluations made through the legacy ReputationSingleton and SimpleContract. The aggregator still sends its requests over the Chainlink request path, with a LINK amount of zero | Requesters of the legacy contracts, those contracts, oracle operators |
| **VDKA** (Verdikta / Wrapped Verdikta) | Staked by oracle operators as collateral | Oracle operators, ReputationKeeper contract |

## Fee Flows by Contract

### ReputationAggregator

The ReputationAggregator has the most complex fee structure due to its multi-oracle commit-reveal design. For the reasoning behind it see the [ETH payment implementation notes](eth-payment-migration.md).

#### Who Pays

The **requester** (the `msg.sender` of `requestAIEvaluationWithApproval`) pays all fees, in ETH. The function is `payable`: the ETH travels with the call. There is no token to approve and the requester needs no LINK.

The requester prepays a worst-case budget, `maxTotalFee(_maxOracleFee)`. The contract takes it first from any credit the requester already holds in the contract (`ethOwed(requester)`) and requires the rest as `msg.value`; if the two together are too little the call reverts with `InsufficientPayment()`.

#### Fee Breakdown

| Fee Component | Amount | When Credited | Recipient |
|---------------|--------|---------------|-----------|
| **Commit-phase base fees** | Each polled oracle's registered `fee` (K credits) | At request creation, in the request transaction (`BasePayment` event) | The owner of each polled oracle's operator contract (`owner()`), as a credit in `ethOwed` |
| **Reveal-phase fees** | 0 (there is no fee for the reveal phase) | N/A | N/A |
| **Bonus payments** | `pollFees[slot] × bonusMultiplier` per clustered oracle. The multiplier is the one in force when the request was made | At finalization (`BonusPayment` event) | The same owner address that received that oracle's base fee, as a credit in `ethOwed` |
| **Refund** | `ethReceived − baseCredited − bonusCredited` | When the round ends: at finalization, or when `finalizeEvaluationTimeout()` closes a timed-out round (`RequesterRefunded` event) | The requester, as a credit in `ethOwed` |

A polled oracle keeps its base fee whether or not it answers. An oracle whose request could not be dispatched is not credited, and its fee stays in the requester's refund.

#### Maximum Total Fee Calculation

```solidity
function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
    uint256 eff = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
    return eff * (commitOraclesToPoll + bonusMultiplier * clusterSize);
    //     eff * (        K           +       B       *      P      )
}
```

With the current settings (K=6, B=3, P=2):

```
maxTotalFee = eff × (6 + 3 × 2) = eff × 12
```

**Example:** On Base mainnet `maxOracleFee()` is 0.0004 ETH, so the largest possible prepayment is `0.0004 × 12 = 0.0048 ETH` (`maxTotalFee(0.0004 ETH)` returned that value on 2026-11-22). A request with a ceiling of 0.00015 ETH prepays `0.00015 × 12 = 0.0018 ETH`.

**Important:** The prepayment is a budget, not the price. The actual cost is lower because:
- Individual oracle fees may be less than the ceiling
- Only P oracles (those in the best cluster) receive bonuses
- Bonuses use each oracle's actual registered fee, not the ceiling

On 2026-11-22 all 40 oracles registered on Base mainnet charged 0.00002 ETH (the ReputationKeeper's `registeredOracles(i)` and `getOracleInfo(operator, jobId)` list every oracle with its fee). At that fee:

| Outcome | Cost in oracle fees | Credited back from a 0.0018 ETH prepayment |
|---------|---------------------|---------------------------------------------|
| Round completes | 6 × 0.00002 + 2 × 3 × 0.00002 = 0.00024 ETH | 0.00156 ETH |
| Round times out | 6 × 0.00002 = 0.00012 ETH | 0.00168 ETH |

Network gas for the request transaction comes on top.

#### ETH Flow Diagram

```
Requester Wallet
    │
    └─── msg.value (plus existing ethOwed credit) ──→ Aggregator escrow for this round
                                                          │
            (In the request transaction, for each of the K polled oracles:)
                                                          ├─── fee ──→ ethOwed[owner of oracle 1]
                                                          ├─── ...
                                                          ├─── fee ──→ ethOwed[owner of oracle K]
                                                          │
            (At finalization, for each of the P clustered oracles:)
                                                          ├─── fee × B ──→ ethOwed[owner of clustered oracle]
                                                          │
            (When the round ends:)
                                                          └─── the rest ──→ ethOwed[requester]

ethOwed[address] ──→ withdrawEth() ──→ that address's wallet
```

The Chainlink request that carries the work to each oracle is sent with a LINK amount of zero. The aggregator holds no LINK in normal operation.

#### Credits and Withdrawals

Every payment above is an entry in the contract's `ethOwed` ledger, not a transfer:

- `withdrawEth()` sends the caller's whole balance to the caller.
- `withdrawEthFor(payee)` sends `payee`'s whole balance to `payee`. Only `payee` or the contract owner can call it, and the ETH always goes to `payee`.
- A requester's credit is used automatically for that requester's next request, before any new ETH is asked for.

#### When a Round Times Out

A round is not closed automatically. Once `responseTimeoutSeconds()` has passed since the request (300 seconds on Base mainnet, one window for the commit and reveal phases together), anyone can call `finalizeEvaluationTimeout(aggId)`. That call closes the round as failed, pays no bonus and credits the requester the prepayment less the base fees. Until someone makes the call, the prepayment stays reserved in the round.

### ReputationSingleton (legacy, LINK)

The ReputationSingleton is a legacy contract that is paid in LINK. It uses a simpler 2× fee model.

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

**Key difference from Aggregator:** The ReputationSingleton is paid in LINK through an allowance: it pulls `2 × oracleFee` upfront into the contract, then pays the bonus from its own balance at fulfillment. The requester's LINK allowance is fully consumed at request time. If the evaluation times out, the bonus LINK remains in the contract (recoverable by owner via `withdrawLink`).

### SimpleContract (legacy, LINK)

The SimpleContract is a legacy development and test contract that is paid in LINK. It has the simplest fee model with a fixed oracle.

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
- Slashed tokens remain in the ReputationKeeper contract (not burned). The keeper has no function that moves them out: the only token transfers in the contract are the stake taken in `registerOracle()` and the stake returned in `deregisterOracle()`

On Base mainnet `slashAmountConfig()` returned 0 on 2026-11-22, so a slash event locks the oracle but takes no tokens today.

## Fee Configuration

### ReputationAggregator Settings

The defaults are set in the constructor; `deploy/03_config.js` sets K, M, N, P, the timeout and `maxOracleFee` again after deployment. The aggregator on Base mainnet returned these same values on 2026-11-22.

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `maxOracleFee` | 0.0004 ETH (`4e14` wei) | `setMaxOracleFee(uint256)` | Ceiling on per-oracle fee, in ETH wei. A request's `_maxOracleFee` above it is lowered to it, both in `maxTotalFee()` and in oracle selection |
| `bonusMultiplier` | 3 | `setBonusMultiplier(uint256)` | Bonus multiplier for clustered oracles (0–20×) |
| `commitOraclesToPoll` (K) | 6 | `setConfig(K,M,N,P,timeout)` | Oracles polled in commit phase (affects base fee count) |
| `clusterSize` (P) | 2 | `setConfig(K,M,N,P,timeout)` | Cluster size (affects number of bonus payments; must be at least 2) |
| `responseTimeoutSeconds` | 300 | `setConfig(K,M,N,P,timeout)` or `setResponseTimeout(uint256)` | Time after which a round can be closed as failed and the requester refunded |

### ReputationSingleton Settings (legacy, LINK)

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `maxOracleFee` | 0.1 LINK | `setMaxOracleFee(uint256)` | Ceiling on per-oracle fee |
| `baseFeePct` | 1 | `setBaseFeePct(uint256)` | Percentage of `maxOracleFee` used as base cost estimate (1–100%) |
| `maxFeeBasedScalingFactor` | 10 | `setMaxFeeBasedScalingFactor(uint256)` | Cap on fee advantage for cheap oracles |
| `alpha` | 500 | `setAlpha(uint256)` | Default reputation weight factor (0–1000) |

### SimpleContract Settings (legacy, LINK)

The SimpleContract's `fee` is set at deployment and is not dynamically configurable (no `onlyOwner` setter pattern).

### Oracle Fee Registration

Each oracle registers with a specific fee via `registerOracle(..., fee, ...)`. This fee is what the oracle charges per request. Oracles with fees above a request's `maxFee` parameter are excluded from selection. The fee must be greater than 0.

The ReputationKeeper stores the fee as a plain number. The contract that selects the oracle decides what it means: the ReputationAggregator reads it as ETH wei, and the legacy ReputationSingleton reads it as LINK. Because the aggregator never accepts a fee above its `maxOracleFee()` (0.0004 ETH, or `4e14`), an oracle registered with a larger number is never selected by it.

There is no function that changes a registered fee. An oracle that wants another fee has to call `deregisterOracle()` and register again, which starts its reputation from zero.

## Emergency LINK Withdrawal

All aggregation contracts provide a `withdrawLink(address payable to, uint256 amount)` function for recovering LINK tokens that are in the contract. In the legacy contracts that can be LINK from failed evaluations or unused bonus pools. The ReputationAggregator holds no LINK in normal operation, so there the function only recovers LINK sent to it by mistake.

| Contract | Access Control | Error on Failure |
|----------|---------------|-----------------|
| ReputationAggregator | `onlyOwner` | `LinkTransferFailed()` (custom error) |
| ReputationSingleton | `onlyOwner` | Standard ERC-20 revert |
| SimpleContract | **No access control** (test contract) | Standard ERC-20 revert |

The ReputationAggregator has no matching function for ETH. The owner cannot take ETH out of the contract: ETH leaves only through `withdrawEth()` and `withdrawEthFor(payee)`, and always to the address it is credited to.

## Practical Fee Guidance

### For Requesters

**ReputationAggregator (ETH):**

1. **Calculate the prepayment** before submitting: call `maxTotalFee(yourMaxFee)` on the contract
2. **Send it with the request**: subtract your existing `ethOwed` credit and attach the rest as `msg.value`. No approval is needed
3. **Set `maxFee` conservatively**: Lower values filter out expensive oracles but may reduce oracle availability. Check that oracles are registered with fees below your limit
4. **Close timed-out rounds**: call `finalizeEvaluationTimeout(aggId)` after the timeout, or your prepayment stays reserved
5. **Collect or reuse your credit**: call `withdrawEth()`, or leave the credit to pay for your next request

**ReputationSingleton and SimpleContract (legacy, LINK):**

1. **Calculate max cost** before submitting: call `maxTotalFee(yourMaxFee)` on the contract
2. **Approve sufficient LINK**: `link.approve(contractAddress, maxTotalFee)`. For SimpleContract the approval must persist through fulfillment

### For Oracle Operators

1. **Set competitive fees**: Lower fees increase selection probability via [fee weighting](oracle-selection.md)
2. **Fee earnings per request**:
   - ReputationAggregator: `fee` for every request the oracle is polled for + `fee × bonusMultiplier` if clustered, in ETH
   - ReputationSingleton: `fee` as base + `fee` as bonus on fulfillment, in LINK
   - SimpleContract: `fee` as base + `fee` as bonus on fulfillment, in LINK
3. **Collect ReputationAggregator earnings**: they are credited to the address that `owner()` of the operator contract returned when the request was made. That address calls `withdrawEth()` on the aggregator; `ethOwed(address)` shows the balance

### Cost Comparison

| Contract | Paid In | Min Cost | Max Cost | Formula |
|----------|---------|----------|----------|---------|
| SimpleContract (legacy) | LINK | `2 × fee` | `2 × fee` | Fixed: base + bonus |
| ReputationSingleton (legacy) | LINK | `2 × oracleFee` | `2 × maxOracleFee` | 2 × selected oracle's fee |
| ReputationAggregator | ETH | `sum(K fees)` (round times out) | `sum(K fees) + B × sum(fees of the P clustered oracles)` | Base fees + bonuses; the prepayment `ceiling × (K + B × P)` covers the worst case and the rest is credited back |
