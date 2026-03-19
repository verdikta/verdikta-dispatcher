# Oracle Selection Algorithm

Complete explanation of how oracles are selected for evaluation requests, including eligibility criteria, randomness sources, and the reputation/fee weighting system.

## Overview

Oracle selection is performed by `ReputationKeeper.selectOracles()` and follows a three-stage pipeline:

1. **Eligibility filtering** — remove oracles that cannot serve this request
2. **Shortlisting** — if too many eligible oracles, randomly subsample
3. **Weighted selection** — draw the requested number of oracles using reputation-weighted random selection

Only contracts approved via `approveContract()` can call `selectOracles()`.

## Stage 1: Eligibility Filtering

Every registered oracle is checked against four conditions. An oracle is eligible if **all** are true:

| Condition | Check | Rationale |
|-----------|-------|-----------|
| Active | `isActive == true` | Paused oracles (via `setOracleActive`) are excluded |
| Fee within budget | `fee <= maxFee` | Oracle's registered LINK fee must not exceed the caller's limit |
| Not blocked | `!(blocked && block.timestamp < lockedUntil)` | Oracles under active penalty lock are excluded. Oracles whose lock has expired are eligible even if `blocked` is still true (they get auto-unblocked on next score update). |
| Supports class | `_hasClass(classes, requestedClass)` | Oracle must list the requested evaluation class in its registered `classes` array (up to 5 classes per oracle) |

If zero oracles pass filtering, the transaction reverts with `"No active oracles available with fee <= maxFee and requested class"`.

## Stage 2: Shortlisting

If the number of eligible oracles exceeds `shortlistSize` (default: **20**), a random subset is drawn using a partial Fisher-Yates shuffle:

```solidity
for i in 0..shortlistSize:
    randIndex = i + (keccak256(block.timestamp, block.prevrandao, i) % (eligibleCount - i))
    swap(eligible[i], eligible[randIndex])
    shortlist[i] = eligible[i]
```

If the eligible count is at or below `shortlistSize`, all eligible oracles proceed directly to weighted selection.

**Purpose:** Bounds gas costs for the weighted selection loop while maintaining fairness across a large oracle pool. The shuffle randomness prevents systematic bias toward oracles registered earlier.

## Stage 3: Weighted Selection

The final selection uses reputation-weighted random drawing without replacement (when possible).

### Selection Score Calculation

For each oracle in the shortlist, `getSelectionScore()` computes a final weight:

#### Step 1: Reputation Weighting

```
weightedScore = ((1000 − alpha) × qualityScore + alpha × timelinessScore) / 1000
```

Where `alpha` is a caller-provided parameter (0–1000):
- `alpha = 0`: Selection based entirely on quality score
- `alpha = 500`: Equal weight on quality and timeliness
- `alpha = 1000`: Selection based entirely on timeliness score

The weighted score is then clamped:

```
if weightedScore < minScoreForSelection (60):  weightedScore = 60
if weightedScore > maxScoreForSelection (6000): weightedScore = 6000
```

The floor of 60 ensures every eligible oracle has a non-zero selection probability, preventing permanent exclusion of low-reputation oracles.

#### Step 2: Fee Weighting Factor

The clamped score is multiplied by a fee weighting factor that favors cheaper oracles:

```
if oracleFee > estimatedBaseCost AND maxFee > estimatedBaseCost:
    ratio = (maxFee − estimatedBaseCost) × 1e18 / (oracleFee − estimatedBaseCost)
    feeWeightingFactor = clamp(ratio, 1e18, maxFeeBasedScalingFactor × 1e18)
else:
    feeWeightingFactor = 1e18  (no adjustment)

finalScore = weightedScore × feeWeightingFactor / 1e18
```

**Effect:** An oracle charging fees close to `estimatedBaseCost` gets a higher scaling factor (up to `maxFeeBasedScalingFactor`), while an oracle at `maxFee` gets a factor of 1.0×. This makes cheaper oracles more likely to be selected without excluding expensive ones entirely.

**Example:** With `maxFee = 0.05 LINK`, `estimatedBaseCost = 0.0005 LINK`, `maxFeeBasedScalingFactor = 5`:
- Oracle at 0.001 LINK fee → factor ≈ 5× (capped at max)
- Oracle at 0.025 LINK fee → factor ≈ 2×
- Oracle at 0.05 LINK fee → factor = 1×

### Entropy Source

The randomness seed for selection combines multiple sources to resist manipulation:

```solidity
seed = keccak256(chosenEntropy, block.prevrandao, block.timestamp, selectionCounter, k)
```

Where `chosenEntropy` is drawn from the ReputationKeeper's two-slot entropy buffer:

| Condition | Entropy Used | Rationale |
|-----------|-------------|-----------|
| `block.number == entropyBlock` (same block as last push) | `entropyBuf[1]` (previous block's entropy) | Prevents same-block manipulation by aggregators |
| `block.number != entropyBlock` (different block) | `entropyBuf[0]` (latest entropy) | Uses the freshest available entropy |

#### Entropy Pipeline

The entropy buffer is fed by approved aggregator contracts via `pushEntropy()`:

1. During the reveal phase, each oracle provides a random salt in its response
2. The ReputationAggregator mixes this salt into `rollingEntropy`:
   ```solidity
   rollingEntropy = bytes16(keccak256(rollingEntropy, salt10, blockhash(block.number − 1)))
   ```
3. Once per block, `rollingEntropy` is pushed to the ReputationKeeper
4. The keeper maintains a 2-slot buffer: `entropyBuf[0]` (newest) and `entropyBuf[1]` (previous)

This means oracle selection randomness incorporates secrets contributed by previous evaluation rounds' oracles — values that are not known to validators at block production time.

### Drawing Algorithm

#### First Pass: Unique Selections (No Duplicates)

```
for k in 0..min(count, shortlistSize):
    seed = keccak256(entropy, prevrandao, timestamp, selectionCounter, k)
    pivot = seed % totalWeight

    accumulator = 0
    for j in shortlist:
        if taken[j]: continue
        accumulator += weights[j]
        if accumulator > pivot:
            selected[k] = shortlist[j]
            taken[j] = true
            totalWeight -= weights[j]   // remove from future draws
            break
```

Each draw removes the selected oracle's weight from the total, ensuring no duplicates in the first pass.

#### Second Pass: Duplicates Allowed

If more oracles are requested than available in the shortlist (`count > n`), additional draws use the **full** original weight distribution and allow duplicates:

```
for k in uniqueDraws..count:
    seed = keccak256(entropy, prevrandao, timestamp, k)
    pivot = seed % fullWeight          // uses original total, not reduced

    accumulator = 0
    for j in shortlist:
        accumulator += weights[j]
        if accumulator > pivot:
            selected[k] = shortlist[j]
            break
```

This is a fallback for when K exceeds the number of available oracles.

### Counter Increment

`selectionCounter` is incremented once per `selectOracles()` call. This provides additional entropy mixing across sequential requests within the same block, preventing identical selections for back-to-back requests.

## Parameters Reference

### Caller-Provided Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `count` | `uint256` | Number of oracles to select (K for ReputationAggregator, 1 for ReputationSingleton) |
| `alpha` | `uint256` | Reputation weight factor (0–1000). Higher values weight timeliness more heavily. |
| `maxFee` | `uint256` | Maximum LINK fee per oracle. Oracles above this are filtered out in Stage 1. |
| `estimatedBaseCost` | `uint256` | Base cost estimate for fee weighting calculation. Must be < `maxFee`. |
| `maxFeeBasedScalingFactor` | `uint256` | Cap on the fee advantage for cheap oracles (must be ≥ 1) |
| `requestedClass` | `uint64` | Evaluation class the oracle must support |

### System Parameters (Owner-Configurable)

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `shortlistSize` | 20 | `setShortlistSize(uint256)` | Maximum oracles carried into weighted selection |
| `maxScoreForSelection` | 6000 | `setMaxScoreForSelection(uint256)` | Upper clamp on weighted reputation score |
| `minScoreForSelection` | 60 | `setMinScoreForSelection(uint256)` | Lower clamp (ensures all oracles have some selection chance) |

## Selection Across Contract Types

| Contract | Oracles Selected | Selection Method |
|----------|-----------------|-----------------|
| ReputationAggregator | K (default 6) | `selectOracles(K, alpha, maxFee, ...)` via ReputationKeeper |
| ReputationSingleton | 1 | `selectOracles(1, alpha, maxFee, ...)` via ReputationKeeper |
| SimpleContract | 0 (pre-configured) | Fixed oracle set at deployment; no dynamic selection |

## Practical Guidance

### Alpha Values

| Alpha | Behavior | Recommended For |
|-------|----------|-----------------|
| 0–200 | Strongly favor quality-scored oracles | High-stakes evaluations where accuracy matters most |
| 300–700 | Balanced selection | General-purpose use (DemoClient uses 500) |
| 800–1000 | Strongly favor timely oracles | Time-sensitive requests |

### Fee Parameters

- Set `maxFee` to the most you are willing to pay per oracle. Higher values increase the eligible oracle pool but cost more.
- Set `estimatedBaseCost` to a small fraction of `maxFee` (e.g., 1%). This serves as a floor for the fee weighting curve.
- Set `maxFeeBasedScalingFactor` to control how much cheaper oracles are preferred (typical: 5–10). A value of 1 disables fee-based preference.

For the full fee mechanics, see [Fee Mechanisms](fees.md). For how scores are computed and updated, see [Reputation System](reputation.md).
