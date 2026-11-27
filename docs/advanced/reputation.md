# Reputation System

How arbiter reputation works in the v2 contracts: the two scores, the points each round's outcome is worth, how the aggregator reports outcomes to the keeper, the blocks, bans, decay and burns, and the liveness freeze.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) (`applyOutcomes`, `_block`, the health calls) and [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol) (`_settle`) on the `beacon` branch. The design and its simulation are TODO.md item 14 ("Reputation v2") and item 7 (the freeze). v1's rules (unbounded scores starting at 0, ±60/−20 deltas set on the aggregator, mild and severe thresholds, the 25-entry worsening check, `manualBlockOracle`, `resetAllReputations`) are gone.

## Overview

Each arbiter has two integer scores, **timeliness** and **quality**, from 0 to 1000. They change by fixed points per event, the same for every jury size, using only what the contracts see: whether a promoted arbiter delivered its reveal, whether a round failed, and how far each reveal was from the round's median. The scores set the arbiter's [selection weight](oracle-selection.md#weight); a score that reaches 0 blocks the arbiter for a while.

Being down is not scored at all: it is handled by the **freeze**, which makes an arbiter unselectable until it answers a health call.

Reputation lives in the [ReputationKeeper](../contracts/reputation-keeper.md). Only approved contracts (the aggregator) can report outcomes, with `applyOutcomes`, once per round at settlement.

## Starting Values and Range

| | Default | Setter |
|---|---|---|
| Start (a new arbiter, and a score after a block) | 500 | `setPoints(Points)` (`start`) |
| Maximum (scores are clamped) | 1000 | `setPoints` (`cap`) |

A returning arbiter (the same operator and job ID registering again after `completeExit`) keeps its scores and offenses; only a new key starts at 500.

## Table 1: Points per Round

Only the round's jurors are scored, once per jury slot. At settlement the aggregator reports one code per slot; the keeper maps it to points.

| Event in a round | Timeliness | Quality |
|---|---|---|
| Promoted, and its reveal arrived (even late, until the deadline) | **+20** (`gain`) | by distance from the median, below |
| … the reveal is **close** (within 1.5 spreads) | | **+20** (`gain`) |
| … **off** (1.5 to 3 spreads) | | **−50** (`minor`) |
| … **far** (more than 3 spreads) | | **−200** (`major`) |
| Promoted, no reveal, round still finished | **−200** (`major`) | |
| Promoted, no reveal, **round failed** | **−500** (`fail`) | |
| No commit (the slot was dispatched), and the **round failed for lack of commits** though at least half of M committed | **−400** (`nocommit`) | |
| Anything else: committing, speed, not being promoted | 0 | 0 |

The **spread** is `max(1.4826 × MAD, spreadFloor)`, where MAD is the median of each counted reveal's distance from the coordinate-wise median (for a vector, its largest coordinate deviation), and `spreadFloor` is 30,000 on the 0 to 1,000,000 scale (3 points). The median and spread are stored at finalization, so a late reveal is classed on arrival against the same median.

In a failed round a delivered reveal gets +20 timeliness and no quality points, since there is no median to judge it by.

Why these rules (TODO item 14 gives the simulations):

- **Commits never earn points.** A commit can't be checked unless it is promoted and revealed, so credit for committing would reward fake commits. A fake commit doesn't help either: if promoted it must be revealed, or it costs −200 or −500. Commits do earn ETH in one case: a round that had M commits but was never promoted shares its unspent prepay among the slots that committed (see [Fee Mechanisms](fees.md#refunds-and-the-arbiter-pool)). That pays the work done; it gives a committer no reason to block, since anyone may call `closeCommits` and `promote` and the `promote` caller is paid.
- **The −400 for not committing applies only when the round failed for lack of commits**, the attack where a cartel blocks by never committing. A round that had M commits but died because nobody called `closeCommits` charges nobody, and so does a round in which fewer than half of M committed: that failure is the request's (one every honest arbiter refuses or cannot fetch; a lone commit proves nothing, since a commit is never opened in that round) or a shared outage's, not the jurors'. A slot whose dispatch failed is never charged.
- **Rare bad luck can't block a good arbiter.** An arbiter in good standing survives any single event; two failed rounds in quick succession block it.
- **No round-size terms.** An honest arbiter nets on average about +18 timeliness and +10 quality per round it serves in, whatever the jury.

## Settlement Codes

`settle(aggId)` (or a new request settling due rounds) sends the keeper one byte per jury slot, `applyOutcomes(keys, codes, roundEnd)`:

| Bits | Meaning | Values |
|------|---------|--------|
| 0–3 | timeliness event | 0 none, 1 `T_DELIVERED`, 2 `T_MISS_FINISHED`, 3 `T_MISS_FAILED`, 4 `T_NOCOMMIT_FAILED` |
| 4–5 | quality class | 0 none, 1 close, 2 off, 3 far |
| 7 | `C_COMMITTED` (0x80): the arbiter committed in this round | |

How the aggregator assigns them:

| Round ended in phase | Slot | Code |
|---|---|---|
| 3 commit (failed) | no commit, and fewer than M commits arrived | 4 |
| 3 commit (failed) | otherwise | 0 |
| 4 closing (failed: never promoted) | any | 0 |
| 5 reveal (failed) | promoted, revealed | 1 |
| 5 reveal (failed) | promoted, no reveal | 3 |
| 6 final (finished) | promoted, revealed | 1 + its quality class |
| 6 final (finished) | promoted, no reveal | 2 |
| any | not promoted | 0 |

Every non-zero code of a slot that committed carries 0x80. Code 0 means no change. A repeated arbiter (in a thin pool) is scored once per slot.

The keeper skips a code when the arbiter is no longer registered or is banned, and when it was **frozen at the round's deadline** and the code lacks 0x80 (`OutcomeSkippedFrozen`). A commit proves the arbiter was up, so freezing itself cannot dodge the −500 for going silent after committing. The keeper judges the freeze at `roundEnd`, the deadline, not at settlement: an arbiter that recovers before settlement is not charged for the outage, and one that stays frozen gains nothing it would not have had at the deadline.

Settlement can lag. A new request settles due rounds in queue order until `settlePerRequest()` × its own K slots are spent (the last round may overshoot, so the first due round is always settled, whatever its size), and the walk stops at the first round not yet past its deadline, so rounds behind a long-timeout round wait for it; anyone may call `settle(aggId)`. An arbiter that finishes `completeExit` before its round is settled escapes that round's points, because `applyOutcomes` skips unregistered keys. Unbonding takes at least 2 days, which covers a round drawn up to a day after its request with its timeout, but not a round left unsettled longer than that.

## Table 2: What the Scores Do

| Score state | Effect |
|---|---|
| Any | selection weight = `1000 + rep × 1000 / cap`, with `rep = ((1000 − alpha) × quality + alpha × timeliness) / 1000`, so 1000 to 2000 (before the fee factor) |
| Either score reaches **0** | **blocked** for `lockDuration` × 2^offenses (24 h, 48 h, 96 h, …); the score that reached 0 restarts at `start`; offenses + 1 |
| The `maxOffenses`-th block (3rd by default) | **banned** for good. The key keeps its record, so it can never register again |
| A block | burns `burnPerBlock` × 2^offenses VDKA from the stake (default 0) |
| A ban | burns the whole remaining stake if `burnOnBan` (default off) |
| `decayPeriod` (90 days) without a block, counted from the end of the last one | one earlier offense is forgiven, again every 90 clean days (applied lazily at the next block) |
| A score reaches 0 while already blocked | restarts at `start`, but adds no offense and burns nothing: several in-flight rounds failing together count as one incident |

A blocked arbiter is not eligible until `blockedUntil`, and it cannot complete an exit while blocked (`Blocked()`). An arbiter whose stake falls below `stakeRequirement` after a burn is not eligible until it tops up (`topUpStake`). Exiting does not help an arbiter escape a block: `requestExit` starts a 2-day unbonding during which blocks and bans still apply.

The arbiter pool's payouts (an eighth of the pool at each jury draw, at most that draw's base fees, to one registered arbiter picked from the draw's seed) use the keeper's flags, not the scores: an arbiter that is paused, banned, exiting or understaked is skipped, and one that has completed its exit is no longer in the registry. Blocks and the liveness freeze are not checked, so a blocked or frozen arbiter that is otherwise in good standing can still be paid from the pool.

## The Liveness Freeze

The keeper checks liveness with hash-chain health calls (TODO items 6 and 7). Each arbiter registers the head `H^n(seed)` of a hash chain (`registerArbiter(..., chainHead)`). A health call (`HealthCall(key, sentAt)`) is answered by revealing the next preimage, `answerHealthCall(key, preimage)` or `rotateChain(key, preimage, newHead)`, from the operator's owner or an authorized sender of the operator.

- **Who calls.** Every juror gets a call at the draw, and so do 3 random other shortlisted arbiters (`liveRandom`), and every beacon. The owner can call many at once (`sendHealthCalls`), and an arbiter's owner or node can ask for one itself (`requestHealthCall`).
- **Freeze.** A call unanswered for more than `callDeadline` (60 s) freezes the arbiter: it is not eligible, and it is not scored (unless it committed). Answering at any time unfreezes it. `isFrozen(key)` reports it, and `healthState(key)` returns what the node needs: whether a call is pending, when it was sent, and the current head.
- **No points either way.** Being down is not misbehaviour, so nothing is burned or deducted for a freeze.
- **Re-sync.** An answer whose value does not hash to the head re-syncs the chain instead of reverting: the value becomes the new head, `ChainResynced(key)` is emitted, and the arbiter is frozen until it answers a call sent after the re-sync. The node's health job recovers by itself: re-sync, answer (which sends that call), answer (which unfreezes). A head of 0 at registration starts the arbiter in this state. See [Security Model](security.md#hash-chains-and-the-re-sync) for why this cannot be used to pick a beacon value.

A known gap (TODO item 14, "the abstain dodge"): a cartel member that blocks by never committing and also ignores its health call is frozen at the deadline, so it escapes the −400; being frozen costs it only being unselectable until it answers.

## Configurable Parameters

All are owner-only on the keeper.

| Parameter | Default | Setter | Description |
|-----------|---------|--------|-------------|
| `points` | gain 20, minor 50, major 200, fail 500, nocommit 400, start 500, cap 1000 | `setPoints(Points)` | Table 1 and the range (`start ≤ cap`, both non-zero) |
| `lockDuration` | 24 h | `setTiming(lock, decay, callDeadline, unbonding)` | Base block length, doubled per offense |
| `decayPeriod` | 90 days | `setTiming(...)` | Clean time that forgives one offense |
| `callDeadline` | 60 s | `setTiming(...)` | Time to answer a health call |
| `unbondingPeriod` | 2 days | `setTiming(...)` | At least `MIN_UNBONDING` (2 days) |
| `maxOffenses` | 3 | `setPenalties(maxOffenses, burnPerBlock, burnOnBan)` | Blocks before a ban (1 to 16) |
| `burnPerBlock` | 0 | `setPenalties(...)` | VDKA burned per block, doubled per offense |
| `burnOnBan` | false | `setPenalties(...)` | Burn the whole stake on a ban |

`spreadFloor` (30,000) is the aggregator's, set with `setParams`.

## Reading an Arbiter's Reputation

`getArbiter(key)` returns the oracle, `quality`, `timeliness`, `offenses`, `flags` (1 registered, 2 paused, 4 banned, 8 exiting, 16 call pending, 32 under-staked, 64 re-syncing), `blockedUntil`, `fee`, `callSentAt`, `callAnsweredAt`, `stake`, the number of checkpoints and `exitAt`. The key is `keyOf(operator, jobId)`. `ScoresUpdated(key, quality, timeliness)`, `ArbiterBlocked`, `ArbiterBanned` and `OutcomeSkippedFrozen` record every change; see the [Events Reference](../api/events.md).

For the selection algorithm see [Oracle Selection](oracle-selection.md); for the fee mechanics, [Fee Mechanisms](fees.md).
