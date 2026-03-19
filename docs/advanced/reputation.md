# Reputation System

Full explanation of how oracle reputation scoring works in the Verdikta Dispatcher, including initial values, score updates, penalty mechanics, and how scores affect oracle selection.

## Overview

The reputation system tracks oracle performance across two dimensions — **quality** and **timeliness** — using additive integer scores. These scores directly influence the probability that an oracle is selected for future evaluations via the [oracle selection algorithm](oracle-selection.md).

Reputation data is stored in the [ReputationKeeper](../contracts/reputation-keeper.md) contract and updated by approved aggregator contracts after each evaluation round.

## Score Dimensions

Each oracle maintains two independent scores, both stored as `int256`:

| Score | Measures | Positive signal | Negative signal |
|-------|----------|-----------------|-----------------|
| **qualityScore** | Response accuracy and consensus participation | Clustered with other oracles | Outlier response or no response |
| **timelinessScore** | Response speed and availability | Timely commit and reveal | Late or missing response |

## Initial Values

When an oracle is registered via `registerOracle()`, both scores start at **0**:

```
qualityScore    = 0
timelinessScore = 0
```

Scores are unbounded `int256` values that accumulate over the oracle's lifetime. They can go negative. The only reset mechanism is `resetAllReputations()` (owner-only), which zeroes all scores, call counts, and block/lock states across all registered oracles.

## Score Update Formula

Scores are updated by calling `updateScores(oracle, jobId, qualityChange, timelinessChange)` where both change values are `int8` (range: −128 to +127).

The update is purely additive:

```
qualityScore    = qualityScore    + qualityChange
timelinessScore = timelinessScore + timelinessChange
callCount       = callCount       + 1
```

There is no decay function — scores persist indefinitely. Each `updateScores()` call also increments the oracle's `callCount` and appends a `ScoreRecord` to the oracle's history.

### Who Can Call `updateScores()`

Only contracts that are:
1. Approved via `approveContract()`, AND
2. Have previously called `recordUsedOracles()` with this oracle's identity

This ensures only aggregator contracts that actually dispatched work to an oracle can update its scores.

## Score Deltas by Outcome Tier

The ReputationAggregator assigns different score deltas depending on how an oracle performed in a given evaluation round. These values are configurable via `setScoreDeltas()` (owner-only).

### Default Score Deltas

| Outcome Tier | Quality Delta | Timeliness Delta | Description |
|-------------|---------------|------------------|-------------|
| **Clustered** | **+60** | **+60** | Oracle's response was in the best consensus cluster |
| **Selected but not clustered** | **−60** | **0** | Oracle was selected for aggregation but was an outlier |
| **Revealed but not selected** | **0** | **−20** | Oracle revealed but wasn't among the first N responses |
| **Committed but not revealed** | **0** | **−20** | Oracle committed but did not reveal (or reveal was rejected) |

### Outcome Tier Assignment

During a ReputationAggregator evaluation with K=6, M=4, N=3, P=2:

1. **K=6 oracles** are polled in the commit phase
2. The **first M=4** to commit are sent reveal requests
3. The **first N=3** valid reveals are marked as "selected" for aggregation
4. Among those N=3 selected, the **closest P=2** (by Euclidean distance) form the consensus cluster

The tier assignment during `_finalizeAggregation()`:

```
For each of the K polled oracles:
  if oracle is inactive at finalization:
    → Skipped (OracleScoreUpdateSkipped event)
  else if oracle revealed AND was selected AND is in the cluster:
    → Clustered tier (+60 quality, +60 timeliness)
  else if oracle revealed AND was selected AND is NOT in the cluster:
    → Selected-not-clustered tier (−60 quality, 0 timeliness)
  else if oracle revealed but was NOT selected:
    → Revealed-not-selected tier (0 quality, −20 timeliness)
  else (oracle did not reveal — either didn't commit or commit-only):
    → Committed-not-revealed tier (0 quality, −20 timeliness)
```

### Timeout Penalties

When `finalizeEvaluationTimeout()` is called:

- **Commit timeout** (fewer than M commits received): Oracles that did not submit a commit (slot has `bytes16(0)`) receive the committed-not-revealed penalty (default: 0 quality, −20 timeliness)
- **Reveal timeout** (fewer than N reveals received): Oracles that did not submit a valid reveal receive the same penalty

Oracles that did commit or reveal before the timeout are not penalized during timeout processing.

## Score History and Trend Detection

The ReputationKeeper maintains a rolling history of recent scores for each oracle:

- **Window size**: `maxScoreHistory` (default: **25** score snapshots)
- After each `updateScores()` call, a `ScoreRecord{qualityScore, timelinessScore}` is appended
- When the history reaches `maxScoreHistory`, the oldest entry is shifted out (FIFO)

### Consistent Degradation Detection

When the score history buffer is full (25 entries), the system checks for consistent worsening:

```
worsening = true
for i in 1..maxScoreHistory:
  if scores[i].quality >= scores[i-1].quality AND
     scores[i].timeliness >= scores[i-1].timeliness:
    worsening = false
    break
```

If `worsening` remains `true` (every single consecutive entry is strictly worse than the previous on at least one dimension), the oracle receives:
- **Slash**: `stakeAmount -= slashAmountConfig`
- **Block**: `blocked = true` (excluded from selection)
- **Lock**: `lockedUntil = block.timestamp + lockDurationConfig`
- **History cleared**: `delete info.recentScores`

This is an independent check from threshold-based penalties — it can trigger even if scores are above both thresholds, as long as the trend is consistently downward.

## Penalty Thresholds and Slashing

Penalties are evaluated after each score update, but **only** if the oracle's current lock period has expired (`block.timestamp >= lockedUntil`).

### Auto-Unblock

When `block.timestamp >= lockedUntil` and the oracle was blocked, it is automatically unblocked (`blocked = false`) before threshold checks proceed. This allows previously penalized oracles to recover.

### Severe Threshold

```
Default: severeThreshold = −900
```

If `qualityScore < −900` **OR** `timelinessScore < −900`:
- **Slash**: `stakeAmount -= slashAmountConfig` (default: 0 VDKA, configurable)
- **Block**: `blocked = true` (excluded from selection)
- **Lock**: `lockedUntil = block.timestamp + lockDurationConfig` (default: 24 hours)
- **Score reset**: The offending score(s) are raised to `mildThreshold` (−300) to prevent repeated immediate slashing on the next update

### Mild Threshold

```
Default: mildThreshold = −300
```

If `qualityScore < −300` **OR** `timelinessScore < −300` (and severe threshold was not triggered):
- **No slash**: Stake is not reduced
- **No block**: `blocked = false` (oracle remains selectable after lock expires)
- **Lock**: `lockedUntil = block.timestamp + lockDurationConfig` (default: 24 hours)

### Manual Blocking

The owner can block any oracle directly via `manualBlockOracle(oracle, jobId, duration)`:
- Sets `blocked = true` and `lockedUntil = block.timestamp + duration`
- If `duration == 0`, uses `lockDurationConfig` as default
- Does not slash stake

### Summary of Penalty Actions

| Trigger | Slashing | Blocked | Lock Duration | Score Adjustment |
|---------|----------|---------|---------------|-----------------|
| Severe threshold (< −900) | `slashAmountConfig` VDKA | Yes | `lockDurationConfig` | Offending score → −300 |
| Mild threshold (< −300) | None | No | `lockDurationConfig` | None |
| Consistent degradation (25 entries) | `slashAmountConfig` VDKA | Yes | `lockDurationConfig` | History cleared |
| Manual block | None | Yes | Specified duration | None |

## Configurable Parameters

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `slashAmountConfig` | 0 VDKA | `setSlashAmount(uint256)` | Tokens deducted per slash event |
| `lockDurationConfig` | 24 hours | `setLockDuration(uint256)` | Duration oracles are locked after penalty |
| `severeThreshold` | −900 | `setSevereThreshold(int256)` | Score below which severe penalty applies |
| `mildThreshold` | −300 | `setMildThreshold(int256)` | Score below which mild penalty applies |
| `maxScoreHistory` | 25 | `setMaxScoreHistory(uint256)` | Rolling window size for trend detection |
| `maxScoreForSelection` | 6000 | `setMaxScoreForSelection(uint256)` | Score cap for selection weighting |
| `minScoreForSelection` | 60 | `setMinScoreForSelection(uint256)` | Score floor for selection weighting |

All setters are `onlyOwner`. Score deltas are configured on the ReputationAggregator via `setScoreDeltas()`.

## How Scores Affect Selection

Reputation scores feed into the [oracle selection algorithm](oracle-selection.md). The key formula:

```
weightedScore = ((1000 − alpha) × qualityScore + alpha × timelinessScore) / 1000
```

Where `alpha` (0–1000) is provided by the requester:
- `alpha = 0`: Selection based entirely on quality
- `alpha = 500`: Equal weight (default in DemoClient)
- `alpha = 1000`: Selection based entirely on timeliness

The weighted score is clamped to `[minScoreForSelection, maxScoreForSelection]` → `[60, 6000]`, then multiplied by a fee weighting factor to produce the final selection weight.

**Key implication**: Even oracles with negative scores receive the floor weight (`minScoreForSelection = 60`), ensuring they always have some probability of being selected. This prevents permanent exclusion and allows recovery.

For the complete selection algorithm, see [Oracle Selection](oracle-selection.md). For the fee mechanics that interact with scoring, see [Fee Mechanisms](fees.md).
