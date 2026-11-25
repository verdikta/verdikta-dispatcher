# Oracle Selection Algorithm

How the v2 contracts draw a jury for a request: the randomness, the eligibility rules, the keeper's shortlist and weighted draw, classes, what happens in a thin pool, and how the per-request jury narrows from K drawn to P clustered.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch: [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) (`selectArbiters`, `pickBeacons`), [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol) (`drawJury`, `promote`), [`ScoringLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ScoringLib.sol) and [`JuryBeacons.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/JuryBeacons.sol). The design record is [TODO.md](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/TODO.md), items 9 (two-phase request and beacons), 10 (clustering), 14 (reputation and the M+ / T+ promotion) and 15 (jury sizes). v1 selected oracles in the request transaction from `block.prevrandao`, the timestamp and an entropy buffer fed by reveal salts; none of that is in v2.

## Overview

A round's jury is settled in four steps, each from a seed nobody could know when the request was signed:

1. **Request (block B).** The request escrows the prepayment and records the query and its jury `{K, M, N, P, timeout}`. Nothing is selected yet.
2. **Draw (from block B+2).** `drawJury(aggId)` asks the keeper for K arbiters, chosen from the keeper's state **as of block B** with the seed `keccak256(aggId, blockhash(B+1))` (and, with beacons, the beacon values too). The keeper builds a **shortlist** of eligible arbiters in a random order and draws K from it, weighted by reputation and fee.
3. **Promotion (from block C+2).** Once the commit phase has closed at block C, `promote(aggId)` draws M of all the commits received, uniformly, with `keccak256(aggId, "promote", blockhash(C+1))`.
4. **Counting and clustering.** The first N promoted reveals are counted, and P of them form the cluster whose mean is the result.

So a request goes **K drawn → M promoted → N counted → P clustered**.

Only contracts approved with `setApproved(address, true)` can call `selectArbiters` and `pickBeacons`. The deploy scripts approve the aggregator and `JuryBeacons`.

## Randomness

### The Two-Phase Draw

| Seed | Used for | Known from |
|------|----------|------------|
| `keccak256(aggId, blockhash(B+1))` | the jury (no beacons) | block B+1 |
| `keccak256(aggId, blockhash(B+1), mix)` | the jury (with beacons) | the quorum-th beacon value |
| `keccak256(aggId, "beacons", blockhash(B+1))` | which arbiters are beacons | block B+1 |
| `keccak256(aggId, "promote", blockhash(C+1))` | which commits are promoted | block C+1 |
| `keccak256(blockhash(B+1), slot)` | the order that breaks cluster ties | block B+1 |

Why it is built this way:

- **The requester cannot predict the jury** when it signs: B+1 does not exist yet. It cannot re-roll it either, because the draw reads the keeper's state as of B and the seed fixed by B+1, so who calls `drawJury`, and when, changes nothing. No abort path that would amount to a free re-roll refunds the requester: the unspent prepay goes to the committers of a never-promoted round, or else to the arbiter pool (see [Fee Mechanisms](fees.md#refunds-and-the-arbiter-pool)).
- **A later state change cannot shift the draw.** Everything selection reads (scores, flags, the block-until time, the fee, the health-call times, the stake flag) is checkpointed by block number, and class lists have checkpointed lengths. A fee change, a top-up, a pause or a new registration after B does not affect a draw at B.
- **Block hashes stay readable** with `BLOCKHASH` for 256 blocks and from the EIP-2935 history contract up to 8,191 blocks (about 27 minutes at Base's 0.2 s blocks). `drawJury` or `sealSeed(aggId)` stores `blockhash(B+1)`; a round never sealed in that window can only be cancelled. No draw is allowed more than a day after the request (`DrawExpired`), and the keeper refuses a request block more than a day old (`StaleBlock`), a bound that the 2-day unbonding floor and slot reuse rely on.
- **The arbiter that closes the commit phase cannot predict the promotion**, which is drawn from the block after the close. Answering early therefore earns nothing.

What remains: the builder of block B+1 (on Base, the sequencer) knows `blockhash(B+1)` first and could choose among the blocks it might build. The bounty sizing in TODO item 15 assumes a bribed sequencer gets a choice of 256 seeds, and that is what limits Small and Medium to bounties of about $1,000. Beacons address it.

### Beacons

A request may set `withBeacons`. The bounty program does for its largest class (Jumbo). Then:

1. The first `drawJury` stores `blockhash(B+1)` and asks `JuryBeacons` to start. The keeper's `pickBeacons` takes `polled` arbiters (4 by default) of the request's class, in a seed-derived random order, entirely from its state as of B: registered and not paused, banned, exiting, under-staked, blocked or frozen. Each gets a health call (`BeaconCalled` is emitted for information).
2. Each beacon answers like any health call, with its next hash-chain value. Its beacon value is its **first value revealed after block B+1** (`keeper.revealAfter(key, B+1)`): the preimage of its head as of B+1, so fixed before anyone but the builder of B+1 knew the pick. A beacon can choose only when to reveal, or not to.
3. Once the first `quorum` values (2 by default) are revealed in completed blocks within `timeout` (120 s) of the start, a second `drawJury` draws the jury with `keccak256(aggId, blockhash(B+1), mix)`, where `mix` chains the used values in beacon-index order. Ties in arrival go to the lower index; arrival decides which values are used, not their order.

The used beacons are paid one fee each, `max(ceiling, floor)`. If the quorum is missed, the second `drawJury` ends the round with no result, pays the beacons that answered, and sends the rest of the prepayment to the arbiter pool. If fewer candidates than the quorum qualify, the round fails with a refund.

What beacons buy and cost (TODO items 9 and 15): a bribed sequencer is left about 40 seeds instead of 256, which on Jumbo's jury raises the sequencer limit from about $25K to $164K. But a cartel holding beacon seats gets a choice of seeds by timing its reveals, and can force a no-result round by withholding. Withholding is cheap: a beacon that answers just after the deadline is frozen only for about a minute. With 2 of 4 used, forcing a no-result round takes 3 colluding beacons. That is why beacons are on for Jumbo only. The owner's settings are `JuryBeacons.setParams(polled, quorum, timeout)`; keep the keeper's `callDeadline` (60 s) below the beacon `timeout`.

## Eligibility at Block B

An arbiter is eligible for a draw if, in its checkpoint as of block B and at the request time:

| Condition | Flag or field |
|-----------|---------------|
| registered | `F_REGISTERED` |
| not paused by its owner (`setPaused`) | `F_PAUSED` |
| not banned | `F_BANNED` |
| not exiting (`requestExit` starts unbonding) | `F_EXITING` |
| stake at least `stakeRequirement` | `F_UNDERSTAKED` |
| not blocked at the request time | `blockedUntil` |
| posted fee at most the request's ceiling, `min(maxFee, maxOracleFee())` | `fee` |
| not frozen at the request time: no health call outstanding for more than `callDeadline` (60 s) | `callSentAt`, `F_CALL_PENDING` |
| listed in the requested class | the class list as of B |

Blocked and banned arbiters are never admitted to fill a jury, even in a shortage: otherwise a cartel could knock out honest arbiters to bring its own blocked members back. The keeper's `isEligible(key, maxFee)` and `eligibleCount(class, maxFee)` report eligibility **now**, for monitoring and for checking a pool before a request.

## Classes

Two different things are called classes:

- **Arbiter classes** are protocol data. Each arbiter registers in 1 to 5 classes (`uint64` identifiers, `registerArbiter(..., classes, ...)`), and each request names one (`requestedClass`). The keeper keeps one list per class and draws only from that list. What a class means (a model family, a capability, a language) is a convention between requesters and operators; v1's arbiters on Base all listed class 128. `arbiterClasses(key)` lists an arbiter's classes, `classSize(class)` a list's length including freed slots.
- **Jury sizes** (the bounty program's Small, Medium, Large and Jumbo) are application presets: `K/M/N/P/timeout` and the beacon flag, sent with each request. The aggregator knows nothing of them; one deployment serves every size.

Exits free slots: `completeExit` empties the arbiter's slot in each of its classes, and the next registration in that class takes a freed slot before the list grows. A draw at B still reads B's occupants correctly, because an exiting arbiter has been ineligible since `requestExit`, at least the unbonding period (2 days) before its slot is freed, and no draw reads a B older than a day.

## The Keeper's Shortlist

`selectArbiters` does not look at the whole class. It visits the class list as of B in a random order derived from the seed (`keccak256(seed, "walk")`): random positions without repeats, tracked in a bitmap. It adds each eligible arbiter to the shortlist and stops once the shortlist holds `shortlistSize` arbiters (60) or it has visited `maxScan` entries (400), freed slots and ineligible arbiters included. After 2 × min(n, `maxScan`) random draws it finishes with a sweep from a random start over the unvisited positions, so it stays bounded and can still reach every entry.

Because the order is a uniform random sample, where an arbiter sits in the list does not matter: a cartel that registers back to back is drawn no more often than any other set. The cost, about 270 gas per entry visited (measured at optimizer runs 200; the build uses 20 since 2026-11-25), does not grow with the pool. `scansAll(class)` is true when the class list is no longer than `maxScan`, so the walk covers all of it and whether it finds enough arbiters does not depend on the seed.

## Weighted Selection

### Weight

For each shortlisted arbiter:

```
rep    = ((1000 − alpha) × quality + alpha × timeliness) / 1000          0 .. cap (1000)
weight = 1000 + rep × 1000 / cap                                          1000 .. 2000

fee    = max(posted fee, minFee)                    the fee the requester pays
ratio  = fee > baseCost ? (ceiling − baseCost) × 1e18 / (fee − baseCost) : scaling × 1e18
ratio  = min(ratio, scaling × 1e18)
if ratio > 1e18:  weight = weight × ratio / 1e18
```

`alpha` (0 to 1000), `estimatedBaseCost` and `maxFeeBasedScalingFactor` come from the request. Reputation can at most double an arbiter's weight, so a fast or always-agreeing cartel gains little seat share, and every eligible arbiter keeps a chance. The fee factor favours cheaper arbiters, up to `maxFeeBasedScalingFactor`; an arbiter at the ceiling gets 1×. Two changes from v1: the fee scored is the one the requester pays, so below the floor every arbiter weighs the same and a near-zero posted fee wins nothing; and a fee at or below the base cost gets the full boost (v1 gave it none).

**Example:** a ceiling of 0.00015 ETH, a base cost of `8e9` wei and a scaling factor of 5. An arbiter posting 0.00002 ETH gets ratio ≈ 7.5, capped at 5×; one posting 0.000075 ETH about 2×; one at the ceiling 1×. When every eligible arbiter posts the same fee (as on v1's Base pool in November 2026), the factor is the same for all and only reputation matters.

### The Draw

The keeper draws K arbiters from the shortlist of m, without replacement, each draw with `pivot = keccak256(seed, k) % remainingWeight`. Every juror gets a health call, and so do `liveRandom` (3) other shortlisted arbiters, chosen from the seed: these calls are how the keeper learns that an arbiter is down (it freezes if it does not answer within `callDeadline`).

If `m` is 0 the keeper reverts with `NoEligibleArbiters()`. The aggregator catches it: the round fails (phase 8) and the requester is refunded, since no jury could be drawn and the refund is no re-roll. After a beacon stage, the refund goes to the arbiter pool unless `scansAll(class)` holds, because then whether a jury could be found depended on the seed the beacons helped choose.

### A Thin Pool Repeats Arbiters

If the shortlist holds fewer arbiters than K (m < K), the draw does not fail. All m are drawn and the remaining slots repeat them in draw order: slot k holds pick `k mod m`. A repeated arbiter answers, is paid and is scored once per slot. This lets a small pool (testing, start-up, a niche class) still answer. Selection refuses only at zero eligible.

Repeats happen when fewer than K arbiters are eligible, and also in a deep pool in two cases: the aggregator checks K against the keeper's `shortlistSize()` only at request time, so the owner lowering `shortlistSize` below a pending round's K makes its draw repeat; and the walk stops at `maxScan` entries, so a large class whose first 400 visited entries hold fewer than K eligible arbiters repeats too.

!!! warning "A repeated arbiter can decide a round alone"
    A requester who chooses a class, or a fee ceiling, that only its own arbiter fits gets a jury of one operator. P ≥ 2 then does not mean two independent answers, and a Q-of-N rule on `getOutcomeScores` counts slots, not arbiters. Check `eligibleCount(class, maxFee)` before relying on a round, and in an application, don't let the party who benefits from the result choose the class or the ceiling. See [Security Model](security.md#thin-pools-and-self-chosen-juries).

## The Per-Request Jury

### K, M, N and P

| Step | Who | Rule |
|------|-----|------|
| **K drawn** | the keeper, at `drawJury` | as above; each of the K slots gets a commit request and is paid its base fee |
| **M promoted** | `promote`, from block C+2 | the commit phase closes at the **M+**-th commit, M+ = M + ⌈(K − M)/2⌉, or with any commit that brings the count to at least M once **T+** (`tPlus()`, 155 s, the mean plus two SDs of honest commit latency) has passed since the draw; `closeCommits` closes it after T+ if no commit comes. Then M of **all** commits received are drawn uniformly (`ScoringLib.pickPromoted`, a partial Fisher-Yates) |
| **N counted** | reveal order | the first N valid reveals among the promoted are counted; the N-th finalizes the round. Later promoted reveals, until the deadline, are scored but don't change the result |
| **P clustered** | `ScoringLib.aggregate` | the P counted reveals that agree most closely; their mean is the result, and they earn the bonus |

Waiting for M+ commits and promoting at random from them is the main protection small rounds have against a cartel that commits first to win promotion. A Small round (6/5/4/3) closes at the 6th commit; a Jumbo round (50/38/27/17) at the 44th.

The aggregator accepts a jury with `K ≥ M ≥ N ≥ P ≥ 1`, `N ≤ 40`, `P ≥ 2` unless `N = 1`, `K ≤ maxJury()` (50) and `K ≤ shortlistSize()` (60), and `tPlus() < timeout ≤ maxTimeout()` (3,600 s), and the timeout at most one day whatever `maxTimeout()` says; anything else reverts `BadJury()`. `getJury(aggId)` returns a round's jury.

### The Cluster

Reveals are first brought to their most common length (ties to the longer), cutting or zero-filling the others. Then:

- **One-number answers** (length 1): the exact cluster, the P consecutive values in sorted order with the smallest spread (the least trimmed squares location estimate).
- **Longer vectors**: TODO item 10's nearest-neighbour rule. For each counted reveal, its group is it and its P − 1 nearest (squared Euclidean distance); the cluster is the group with the smallest sum of pairwise distances. It replaces v1's greedy rule, which let identical colluders seed the cluster and pull its mean. For P = 2 both rules give the closest pair.

Ties go by `keccak256(blockhash(B+1), slot)`, not by reveal order, so the fastest arbiter gains nothing from equal scores.

## Parameters Reference

### Request Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `jury` | `Jury` | K, M, N, P and the timeout, as above |
| `alpha` | `uint256` | Reputation weight, 0 to 1000. Higher values weight timeliness more |
| `maxFee` | `uint256` | Fee ceiling, ETH wei; lowered to `maxOracleFee()`. Arbiters posting more are ineligible |
| `minFee` | `uint256` | Fee floor: each juror is paid at least this, and selection scores fees below it as the floor |
| `estimatedBaseCost` | `uint256` | Baseline for the fee factor; must be below the ceiling |
| `maxFeeBasedScalingFactor` | `uint256` | Cap on the fee factor, 1 to 65,535 |
| `requestedClass` | `uint64` | Arbiter class to draw from |
| `withBeacons` | `bool` | Mix beacon values into the seed |

### Owner-Configurable

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `shortlistSize` | 60 | `ReputationKeeper.setSelection(shortlist, maxScan, liveRandom)` | Largest shortlist; every request's K must fit it |
| `maxScan` | 400 | `setSelection(...)` | Entries visited per walk, at least the shortlist |
| `liveRandom` | 3 | `setSelection(...)` | Extra health calls per draw |
| `callDeadline` | 60 s | `ReputationKeeper.setTiming(lock, decay, deadline, unbonding)` | Time to answer a health call before freezing |
| `maxJury`, `maxTimeout`, `tPlus` | 50, 3,600 s, 155 s | `ReputationAggregator.setLimits(...)` | Bounds on the request's jury; no timeout may exceed 1 day, whatever `maxTimeout` says |
| `revealWindow` | 120 s | `ReputationAggregator.setRewards(...)` | Least reveal time after `promote` |
| `polled`, `quorum`, `timeout` | 4, 2, 120 s | `JuryBeacons.setParams(polled, quorum, timeout)` | Beacon stage |

The owner's `setSelection`, `maxScan` and `callDeadline` take effect at the next draw, including for rounds already requested.

## Practical Guidance

### Alpha Values

| Alpha | Behavior | Recommended For |
|-------|----------|-----------------|
| 0–200 | Strongly favor quality | High-stakes evaluations where accuracy matters most |
| 300–700 | Balanced selection | General-purpose use (the examples use 500) |
| 800–1000 | Strongly favor timeliness | Time-sensitive requests |

Since the weight spans only 1000 to 2000, alpha shifts the odds modestly.

### Fee Parameters

- Set `maxFee` to the most you are willing to pay per arbiter. A higher ceiling widens the pool and the prepayment, not the price.
- Set `minFee` if repeated attempts by the requester are a threat (see [Fee Mechanisms](fees.md#the-fee-floor)).
- Set `estimatedBaseCost` to a small fraction of the ceiling (for example 1%) and `maxFeeBasedScalingFactor` to 5–10; 1 disables the fee preference.

For the fee mechanics see [Fee Mechanisms](fees.md); for how scores change, [Reputation System](reputation.md); for the reference of every function, [ReputationKeeper](../contracts/reputation-keeper.md) and [ReputationAggregator](../contracts/reputation-aggregator.md).
