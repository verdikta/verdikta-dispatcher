# Fee Mechanisms

Every fee, who pays it, when it is credited, and how payment flows through the Verdikta Dispatcher system end to end.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch, in [`reputationBasedAggregator/contracts`](https://github.com/verdikta/verdikta-dispatcher/tree/beacon/reputationBasedAggregator/contracts). v2 is not deployed yet; its addresses are set at the v2 deployment. The quotes in the worked examples were checked by calling `maxTotalFee` on the v2 contracts, and the Small round's accounting by running one on Hardhat's in-process network. The committer-share figures (Small with 6 and with 5 commits, Jumbo with 44) and the pool example were also run on the in-process network against the contracts at 366e70c, and match to the wei. The ReputationAggregator is paid in ETH. ReputationSingleton and SimpleContract are legacy contracts, still paid in LINK and written for the v1 keeper. Values that the owner can change are given with the function that returns the current value. For the v1 aggregator (`maxTotalFee(fee) = fee × (K + B × P)`, all base fees credited at the request, `finalizeEvaluationTimeout`) see the `aggregator-v0.1.0` tag and the [ETH payment history](eth-payment-migration.md).

## Token Overview

| Token | Purpose | Held By |
|-------|---------|---------|
| **ETH** | Pays for evaluations made through the ReputationAggregator: base fees, bonuses, beacon payments and the draw and promote rewards | Requesters, the aggregator (escrow, the `ethOwed` ledger and the arbiter pool in it), arbiter owners |
| **LINK** (Chainlink) | Pays arbiters of the legacy ReputationSingleton and SimpleContract. The aggregator still sends its requests over the Chainlink request path, with a LINK amount of zero, and holds no LINK | Requesters of the legacy contracts, those contracts, operators |
| **VDKA** (Wrapped Verdikta) | Staked by arbiter operators in the ReputationKeeper | Arbiter operators, the ReputationKeeper |

## Fee Flows by Contract

### ReputationAggregator

#### Who Pays

The **requester** (the `msg.sender` of `requestAIEvaluationWithApproval`) pays everything, in ETH. The function is `payable`: the ETH travels with the call. There is no token to approve.

The requester prepays a worst-case budget, `maxTotalFee(maxFee, minFee, withBeacons, K, P)`, for the jury the request asks for. The contract takes from the requester's existing credit (`ethOwed(requester)`) only what `msg.value` does not cover, and returns any excess `msg.value` to credit, so the round's escrow is exactly the quote. If the two together are too little the call reverts with `InsufficientPayment()`. A quote above 2^88 − 1 wei reverts with `BadInput()`.

#### The Request's Fee Parameters

| Parameter | Meaning |
|-----------|---------|
| `maxFee` | The fee **ceiling**. `eff = min(maxFee, maxOracleFee())`. An arbiter is eligible only if its posted fee is at most `eff`. The draw and promote rewards are counted in `eff` |
| `minFee` | The fee **floor** (TODO item 8). Each juror is paid `max(posted fee, minFee)`; 0 means none. It may exceed the ceiling: the ceiling decides who is eligible, the floor what each is paid |
| `withBeacons` | Adds the beacon quorum (`JuryBeacons.quorum()`, 2 by default) to the budget. Reverts if the aggregator has no beacon contract |
| `K`, `P` | From the request's jury: K jurors are paid a base fee, up to P earn the bonus |

#### Maximum Total Fee Calculation

From [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol):

```solidity
function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) public view returns (uint256) {
    uint256 eff = maxFee < maxOracleFee ? maxFee : maxOracleFee;
    uint256 juror = minFee > eff ? minFee : eff;
    uint256 n = uint256(K) + uint256(bonusMultiplier) * P;
    if (withBeacons) n += beacons.quorum();
    return juror * n + eff * (uint256(drawRewardFees) + promoteRewardFees);
}
```

That is

```
eff         = min(maxFee, maxOracleFee())        0.0004 ETH by default
juror       = max(eff, minFee)
maxTotalFee = juror × (K + B × P [+ quorum]) + eff × (drawRewardFees + promoteRewardFees)
```

with the defaults B = `bonusMultiplier()` = 3, `drawRewardFees()` = 2, `promoteRewardFees()` = 1 and a quorum of 2. Each round stores the multiplier, the two reward counts and the quorum at request time, so an owner change later cannot break its escrow.

#### What a Round Pays

| Component | Amount | When credited | To |
|-----------|--------|---------------|----|
| **Base fee** | `max(posted fee as of block B, minFee)` per jury slot (`BasePayment`) | At the draw, for every slot whose request was dispatched | The owner (`owner()`) of the slot's operator contract, read at the draw |
| **Bonus** | that slot's paid fee × B, per member of the cluster (`BonusPayment`) | At finalization (the N-th counted reveal) | The same owner as the slot's base fee |
| **Draw reward** | `eff × drawRewardFees` (2 × eff) (`JuryDrawn`) | At the draw | The caller of the drawing `drawJury`: the requester within `requesterDrawPriority()` (30 s) of the request, anyone after that. A third party drawing earlier gets nothing, and the amount stays in the refund |
| **Promote reward** | `eff × promoteRewardFees` (1 × eff) | At `promote` | Its caller, whoever it is |
| **Beacon payment** | `max(eff, minFee)` per used beacon value (`BeaconPayment`) | At the second `drawJury`, also when the quorum was missed | The operator owner of each beacon whose value was used |
| **Committer share** | `(received − baseFees − bonuses − rewards) / commits` per committed slot (`CommitPayment`) | At `settle`, only for a round with at least M commits that was never promoted | The owner of each committed slot's operator, read at the draw |
| **Refund** | `received − baseFees − bonuses − rewards` (`RequesterRefunded`) | When the round ends; see [Refunds and the Arbiter Pool](#refunds-and-the-arbiter-pool) | The requester, or the arbiter pool (`address(0)`) |
| **Pool payout** | `ethOwed(address(0)) / 8` (`PoolPayment`) | At every `drawJury` that draws a jury, from the pool, not from that round's prepay | One registered arbiter's operator owner, picked from the draw's seed |

A juror keeps its base fee whether or not it answers: a fee conditional on committing would reward fake commits, and silence is handled by the [reputation rules](reputation.md). A slot whose request could not be dispatched (its operator's `owner()` unreadable, or the dispatch reverted; `SlotSkipped`) is not credited, and its fee stays in the refund. In a thin pool one arbiter can hold several slots; it is paid per slot.

Beacons are paid the round's **ceiling** (or the floor, if higher), not their posted fee. The bonus is paid to exactly P reveals (the cluster), on each one's paid fee, so it is at most `B × P × juror`. `getRoundInfo(aggId)` returns `received`, `baseFees`, `bonuses` and `rewards` (draw and promote rewards, beacon payments and committer shares together); `getSlot(aggId, i).fee` is the fee a slot was paid.

#### Worked Example: Small

A Small jury (K 6, M 5, N 4, P 3, timeout 300 s), a ceiling of 0.00015 ETH, no floor, no beacons, default settings. Assume every juror posts 0.00002 ETH, the fee every v1 arbiter on Base mainnet posted in November 2026.

```
eff         = min(0.00015, 0.0004) = 0.00015 ETH
juror       = max(0.00015, 0)      = 0.00015 ETH
maxTotalFee = 0.00015 × (6 + 3 × 3) + 0.00015 × (2 + 1) = 0.00015 × 18 = 0.0027 ETH
```

| Outcome | Credited to others | Refund to the requester |
|---------|--------------------|-------------------------|
| Round completes | base 6 × 0.00002 = 0.00012; bonus 3 × 3 × 0.00002 = 0.00018; draw reward 0.0003; promote reward 0.00015 | 0.0027 − 0.00075 = **0.00195 ETH** |
| Round dies in the commit phase with fewer than 5 commits (settled) | base 0.00012; draw reward 0.0003 | 0.0027 − 0.00042 = 0.00228 ETH |
| All 6 commit, the phase closes, but nobody sends `promote` (settled) | base 0.00012; draw reward 0.0003; 0.00228 shared by the 6 committed slots, 0.00038 each (`CommitPayment`) | **0** |
| 5 commit, nobody closes the phase or promotes (settled) | base 0.00012; draw reward 0.0003; 0.00228 shared by the 5 committed slots, 0.000456 each | **0** |

In the last two rows 0.00228 ETH divides evenly, so nothing is left for the arbiter pool. The rows assume a third party earned the draw reward; had the requester drawn within 30 s, that 0.0003 would be its credit and the shares would be 0.00038 ETH smaller in total, since the unspent prepay is what is left after the draw reward.

If the requester draws its own round within 30 seconds, the draw reward (0.0003 ETH) is credited to it as well: a completed round then costs it 0.00045 ETH, or 0.0003 ETH if it also sends `promote`. The bounty program's Small class sets no floor, so its cost per round follows the arbiters' posted fees. Network gas comes on top.

#### Worked Example: Jumbo

A Jumbo jury (K 50, M 38, N 27, P 17, timeout 600 s) with beacons, the default ceiling of 0.0004 ETH, and a floor of 0.00011 ETH (about $0.25 at $2,287 per ETH, the bounty program's floor for the larger classes). Assume every juror posts 0.00002 ETH, below the floor.

```
eff         = min(0.0004, 0.0004)  = 0.0004 ETH
juror       = max(0.0004, 0.00011) = 0.0004 ETH
maxTotalFee = 0.0004 × (50 + 3 × 17 + 2) + 0.0004 × (2 + 1) = 0.0004 × 106 = 0.0424 ETH
```

Each juror is paid the floor, 0.00011 ETH, since its posted fee is lower. If the round completes:

| Component | Amount |
|-----------|--------|
| Base fees | 50 × 0.00011 = 0.0055 ETH |
| Bonuses | 17 × 3 × 0.00011 = 0.00561 ETH |
| Beacon payments | 2 × max(0.0004, 0.00011) = 0.0008 ETH |
| Draw reward | 2 × 0.0004 = 0.0008 ETH |
| Promote reward | 0.0004 ETH |
| **Refund** | 0.0424 − 0.01311 = **0.02929 ETH** |

The requester's priority for the draw runs from the second beacon value (`readyAt`), not from the request. If it draws and promotes itself, the round costs it 0.01191 ETH. Every attempt costs at least K × floor plus the beacons, here 0.0055 + 0.0008 ETH, whatever the arbiters post: that is what the floor is for.

If instead the phase closes at the M+-th commit (44) and nobody promotes, the round spends the base fees, the beacons and the draw reward (0.0071 ETH), and the 44 committed slots share the other 0.0353 ETH at settlement: 802,272,727,272,727 wei each, with the indivisible 12 wei credited to the arbiter pool (`RequesterRefunded(aggId, address(0), 12)`). The requester gets nothing back.

#### Worked Example: the Pool

Suppose a cancelled Small round has put its whole 0.0027 ETH in the arbiter pool and nothing else is in it. The next `drawJury` that draws a jury, in any round, pays 0.0027 / 8 = 0.0003375 ETH to one registered arbiter (`PoolPayment`), leaving 0.0023625 ETH; the draw after that pays an eighth of what is left, and so on. If the keeper's two picks both land on paused, banned, exiting or understaked arbiters, that draw pays nobody and the pool stays as it was.

#### The Fee Floor

The floor (item 8) makes repeated attempts expensive: a requester who re-submits until it gets a jury it likes pays at least `K × minFee` per attempt. Selection also scores the fee the requester pays, so below the floor every arbiter weighs the same, and a near-zero posted fee wins no extra weight. The floor deters only a requester who cannot choose it. In the bounty program that is the bounty creator's setting, passed into every request for the bounty; it protects nothing when a submitter calls the aggregator directly with its own floor.

#### Refunds and the Arbiter Pool

The refund, `received − baseFees − bonuses − rewards`, is credited once, when the round ends. Where it goes depends on how the round ended. Whenever a refund would let a requester throw away a jury it dislikes and draw again for the price of the base fees (a free re-roll), the requester gets nothing back: a round that had M commits but was never promoted pays it to the slots that committed, and every other such round sends it to the arbiter pool. v2 has no treasury: v2 drafts before 2026-11-25 sent these amounts to one.

| How the round ended | When | Refund to |
|---------------------|------|-----------|
| Result (phase 6) | at finalization | requester |
| Draw found no eligible arbiter (phase 8) | at the draw | requester (no jury could be drawn) |
| Beacon stage: fewer candidates than the quorum (phase 8) | at the first `drawJury` | requester |
| Beacon quorum missed by the deadline (phase 8) | at the second `drawJury`; the beacons that answered are paid | **arbiter pool** |
| No jury after the beacon stage (phase 8) | at the second `drawJury`; the beacons are paid | requester if the keeper's walk covers the whole class list (`scansAll(class)`), else **arbiter pool** |
| Dead in the commit phase with fewer than M commits (phase 8) | at `settle` | requester |
| Dead with at least M commits but never promoted, closed or not (phase 8) | at `settle` | **the committed slots**, in equal shares (`CommitPayment`); the remainder, under one wei per committer, to the **arbiter pool** |
| Dead in the reveal phase: fewer than N reveals (phase 8) | at `settle` | requester |
| Never drawable: unsealed for 8,191 blocks, or undrawn a day after the request (phase 9) | `cancelUnsealed`: the whole prepayment | **arbiter pool** (`RoundCancelled`) |

The `RequesterRefunded(aggId, to, amount)` event names the address credited, address(0) for the pool; it fires only for a non-zero amount.

**The arbiter pool** is the ledger entry `ethOwed(address(0))`. Nobody can withdraw it: `withdrawEthFor(address(0))` reverts `NotAuthorized()`, and `msg.sender` is never address(0). Every `drawJury` that draws a jury pays an eighth of it to one registered arbiter's payee (its operator's `owner()`), picked uniformly by the keeper's `poolPayee(seed)` from that draw's seed. The keeper makes at most two picks and skips arbiters that are paused, banned, exiting or understaked; if both miss, nobody is paid and the pool waits for the next draw. The call is capped at 80,000 gas, so it cannot make the draw fail. The seed is fixed by a block hash after the request and is the same whoever draws, a forfeiting round never picks its own winner, and an eighth per draw makes grinding with many requests cost more than it wins. A dead round's refund waits until someone calls `settle(aggId)` after the deadline. New requests also settle due rounds, in queue order, until `settlePerRequest()` (2) × their own K slots are spent; the last round settled may overshoot, so the first due round is always settled, whatever its size. The walk stops at the first round not yet past its deadline, so a long-timeout round at the head holds back shorter ones behind it, and `settlePerRequest = 0` turns this off. Call `settle` yourself.

#### ETH Flow Diagram

```
Requester Wallet
    │
    └── msg.value (plus existing ethOwed credit) ──→ escrow for this round (exactly maxTotalFee)
                                                         │
          (at the draw, for each of the K dispatched slots:)
                                                         ├── max(fee, floor) ──→ ethOwed[operator owner]
          (at the draw:)                                 ├── 2 × eff ──→ ethOwed[drawer]
          (at the second draw, with beacons:)            ├── max(eff, floor) ──→ ethOwed[beacon owner] × used values
          (at promote:)                                  ├── 1 × eff ──→ ethOwed[promote caller]
          (at finalization, for each of the P clustered:)├── paid fee × B ──→ ethOwed[operator owner]
          (when the round ends:)                         └── the rest ──→ ethOwed[requester], or the committed slots'
                                                                          owners (never promoted), or ethOwed[address(0)]

ethOwed[address(0)], the arbiter pool ── 1/8 at each jury draw ──→ ethOwed[a random registered arbiter's owner]

ethOwed[address] ──→ withdrawEth() ──→ that address's wallet
```

The Chainlink request that carries the work to each arbiter is sent with a LINK amount of zero.

#### Credits and Withdrawals

Every payment above is an entry in the contract's `ethOwed` ledger, not a transfer:

- `withdrawEth()` sends the caller's whole balance to the caller.
- `withdrawEthFor(payee)` sends `payee`'s whole balance to `payee`. Only `payee` or the contract owner can call it, and the ETH always goes to `payee`.
- A requester's credit is used automatically for that requester's next request, for whatever `msg.value` does not cover.

The owner cannot take ETH out of the aggregator any other way, and nobody can withdraw the arbiter pool: `withdrawEthFor(address(0))` reverts `NotAuthorized()`. The pool leaves only through its payouts to arbiters.

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

Arbiter operators stake Wrapped Verdikta (VDKA) in the v2 ReputationKeeper to register. See [Reputation System](reputation.md) for the burns.

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `stakeRequirement` | 100 VDKA (`100e18`) | `setStakeRequirement(uint256)` | Pulled at registration. An arbiter whose stake is below it is not eligible (flag `F_UNDERSTAKED`); a new requirement applies to an arbiter at its next stake change |
| `burnPerBlock` | 0 | `setPenalties(maxOffenses, burnPerBlock, burnOnBan)` | VDKA burned on each block, doubled per earlier offense |
| `burnOnBan` | off | `setPenalties(...)` | Burn the whole remaining stake on a ban |
| `unbondingPeriod` | 2 days | `setTiming(lock, decay, callDeadline, unbonding)` | Delay between `requestExit` and `completeExit`; never below `MIN_UNBONDING` (2 days) |

### Staking Flow

```
Operator Owner Wallet
    │
    └─── approve(keeper, stakeRequirement)
    └─── registerArbiter(oracle, jobId, fee, classes, chainHead)
              └──→ transferFrom(caller, keeper, stakeRequirement)
```

The caller must be the operator contract's `owner()` or the keeper's owner. `topUpStake(key, amount)` adds stake (the operator owner or the keeper owner).

### Unstaking Flow

```
requestExit(key)                      the arbiter is no longer selected; blocks and bans still apply
    │   (unbondingPeriod, 2 days by default)
completeExit(key)
    └──→ transfer(operator owner, remaining stake)
```

Either the operator's owner or the keeper owner can run both steps, also for a frozen arbiter. `completeExit` reverts with `StillBonded()` before the period ends and with `Blocked()` while the arbiter is blocked. The stake goes to the operator's `owner()`, not necessarily to whoever staked.

### Burns

Burned VDKA is burned with the token's `burn`, or sent to `0x…dEaD` if the token has none. Slashed stake never goes to a requester, a reporter or the aggregator's arbiter pool: paying anyone from slashing would reward making other arbiters fail. Both burns are off by default.

## Fee Configuration

### ReputationAggregator Settings

The constructor sets the defaults; `deploy/03_config.js` sets the request bounds with `setLimits(50, 3600, 155)` and the shared parameters with `setParams(3, 2, 250000, 30000, 0.0004 ETH)`.

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `maxOracleFee` | 0.0004 ETH (`4e14` wei) | `setParams(..., maxOracleFee)` | Global fee ceiling. A request's `maxFee` above it is lowered to it, in the quote and in selection |
| `bonusMultiplier` | 3 | `setParams(bonusMult, ...)` | B, at most 20. Stored per round at request |
| `settlePerRequest` | 2 | `setParams(..., settlePerReq, ...)` | A request settles due rounds until this × its own K slots are spent (the last may overshoot); 0 turns it off |
| `drawRewardFees` | 2 | `setRewards(drawFees, priority, promoteFees, revealWindow)` | Draw reward, in multiples of eff. Stored per round |
| `requesterDrawPriority` | 30 s | `setRewards(...)` | Seconds in which only the requester earns the draw reward |
| `promoteRewardFees` | 1 | `setRewards(...)` | Promote reward, in multiples of eff. Stored per round |
| `maxJury`, `maxTimeout`, `tPlus` | 50, 3,600 s, 155 s | `setLimits(maxJury, maxTimeout, tPlus)` | Bounds on the request's jury; no timeout may exceed 1 day, whatever `maxTimeout` says |

There is no treasury setting: `setContracts(keeper, beacons)` takes only the keeper and the beacon contract, and the forfeits go to the committers or the arbiter pool. The pool's share per draw (1/8) and the keeper call's gas cap (80,000) are constants in `AggregatorLib`.

The beacon quorum is `JuryBeacons.quorum()` (2 by default), set with `JuryBeacons.setParams(polled, quorum, timeout)`; each round stores it at request.


### ReputationSingleton Settings (legacy, LINK)

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `maxOracleFee` | 0.1 LINK | `setMaxOracleFee(uint256)` | Ceiling on per-oracle fee |
| `baseFeePct` | 1 | `setBaseFeePct(uint256)` | Percentage of `maxOracleFee` used as base cost estimate (1–100%) |
| `maxFeeBasedScalingFactor` | 10 | `setMaxFeeBasedScalingFactor(uint256)` | Cap on fee advantage for cheap oracles |
| `alpha` | 500 | `setAlpha(uint256)` | Default reputation weight factor (0–1000) |

### SimpleContract Settings (legacy, LINK)

The SimpleContract's `fee` is set at deployment and is not dynamically configurable (no `onlyOwner` setter pattern).

### Arbiter Fee Registration

Each arbiter posts a fee with `registerArbiter(oracle, jobId, fee, classes, chainHead)` (`fee` is a `uint64`, greater than 0) and can change it with `setFee(key, fee)` without losing its reputation. Selection reads the fee as of the request block B, so a change after B does not affect that round. An arbiter whose fee is above a request's ceiling is not eligible for it.

The keeper stores the fee as a plain number; the v2 aggregator reads it as ETH wei. Because the aggregator never accepts a ceiling above `maxOracleFee()` (0.0004 ETH), an arbiter posting more is never selected.

## Emergency LINK Withdrawal

The legacy contracts provide `withdrawLink(address payable to, uint256 amount)` for recovering LINK in the contract.

| Contract | Access Control | Error on Failure |
|----------|---------------|-----------------|
| ReputationSingleton | `onlyOwner` | Standard ERC-20 revert |
| SimpleContract | **No access control** (test contract) | Standard ERC-20 revert |

The v2 ReputationAggregator has no `withdrawLink`: it holds no LINK. It has no ETH sweep either: ETH leaves only through `withdrawEth()` and `withdrawEthFor(payee)`, always to the credited address.

## Practical Fee Guidance

### For Requesters

**ReputationAggregator (ETH):**

1. **Choose the jury, ceiling and floor**, then call `maxTotalFee(maxFee, minFee, withBeacons, K, P)`.
2. **Send it with the request**: subtract your existing `ethOwed` credit and attach the rest as `msg.value`. No approval is needed.
3. **Set the ceiling with the pool in mind.** A low ceiling filters out expensive arbiters and can thin the pool; the keeper's `eligibleCount(class, maxFee)` shows how many are eligible now. A thin pool repeats arbiters rather than failing.
4. **Draw your own round within 30 seconds** to get the draw reward back, and send `promote` yourself to keep the promote reward.
5. **Settle dead rounds**: call `settle(aggId)` after the deadline, or the refund stays in the round.
6. **Collect or reuse your credit**: `withdrawEth()`, or leave it to pay for your next request.

**ReputationSingleton and SimpleContract (legacy, LINK):**

1. **Calculate max cost** before submitting: call `maxTotalFee(yourMaxFee)` on the contract
2. **Approve sufficient LINK**: `link.approve(contractAddress, maxTotalFee)`. For SimpleContract the approval must persist through fulfillment

### For Arbiter Operators

1. **Set competitive fees**: a lower fee raises the selection weight (see [fee weighting](oracle-selection.md#weight)), but only down to the round's floor: below it every arbiter costs the requester the same.
2. **Earnings per round**, in ETH: `max(fee, floor)` for every slot the arbiter is drawn for, `B × max(fee, floor)` more if its reveal is in the cluster, and `max(ceiling, floor)` for a used beacon value. If it committed in a round that had M commits but was never promoted, an equal share of that round's unspent prepay. And while it is registered and not paused, banned, exiting or understaked, any jury draw may pick it for an eighth of the arbiter pool (`PoolPayment`), whether or not it is on that jury.
3. **Collect them**: they are credited to the address that the operator contract's `owner()` returned at the draw (or at the beacon payment). That address calls `withdrawEth()` on the aggregator; `ethOwed(address)` shows the balance.

### Cost Comparison

| Contract | Paid In | Min Cost | Max Cost | Formula |
|----------|---------|----------|----------|---------|
| SimpleContract (legacy) | LINK | `2 × fee` | `2 × fee` | Fixed: base + bonus |
| ReputationSingleton (legacy) | LINK | `2 × oracleFee` | `2 × maxOracleFee` | 2 × selected oracle's fee |
| ReputationAggregator (v2) | ETH | nothing if no arbiter is eligible; otherwise at least the K base fees, less the rewards the requester earns back | the quote, `maxTotalFee` (a cancelled round sends all of it to the arbiter pool) | Base fees + bonuses + beacons + rewards; the rest is refunded unless the round ended in a way that would be a re-roll |
