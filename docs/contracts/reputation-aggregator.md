# ReputationAggregator Contract

The ReputationAggregator runs Verdikta's multi-arbiter evaluations: it escrows the requester's ETH, draws a jury from the ReputationKeeper, collects commits and reveals from the arbiters, clusters the answers, pays the arbiters and reports every arbiter's outcome back to the keeper. This page describes **v2**, a breaking redeploy of v1.

!!! note "Checked against the code"
    Revised on 2026-11-25 against v2's [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol), [`AggregatorLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/AggregatorLib.sol), [`ScoringLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ScoringLib.sol) and [`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md) on the `beacon` branch. v2 is not deployed yet, so no v2 address is given: the addresses are set at the v2 deployment. Fees are paid in ETH: the requester needs no LINK and approves no token. Every number below is a default that the owner can change, and each is given with the function that returns the current value. Measured gas figures on this page were taken with optimizer runs 200; since 2026-11-25 the contracts build with 20 runs to fit the size limit, which can cost somewhat more gas per call, so re-measure before relying on a tight figure. The test suite's gas budgets still pass. "Item n" refers to the numbered design notes in [`TODO.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/TODO.md).

!!! warning "v1"
    The v1 aggregator (tag `aggregator-v0.1.0`) is the one deployed today, on Base mainnet at `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` and on Base Sepolia at `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4`. Its 7-argument request, `maxTotalFee(maxFee)`, `K()`/`M()`/`N()`/`P()`, `setConfig`, `responseTimeoutSeconds()`, `getAggregationStatus` and `finalizeEvaluationTimeout` do not exist in v2. [`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md) maps each v1 call to its v2 replacement.

## Overview

One v2 aggregator serves every size of question, because **each request carries its own jury**:

```solidity
struct Jury {
    uint8 K;        // arbiters drawn, each sent a commit request
    uint8 M;        // commits promoted to reveal
    uint8 N;        // reveals counted: the N-th counted reveal finalizes the round
    uint8 P;        // cluster size: the P clustered reveals are averaged and paid a bonus
    uint40 timeout; // seconds, counted from the draw (not from the request)
}
```

A round goes through these steps, each started by a transaction that anyone may send:

1. **Request** (block B). `requestAIEvaluationWithApproval` checks the jury, escrows the ETH and records the query. No arbiter is chosen yet.
2. **Draw** (from block B+2). `drawJury(aggId)` draws K arbiters with the seed `keccak256(aggId, blockhash(B+1))` and the keeper's state as of block B, so nobody can predict or re-roll the jury when the request is signed (item 9). It sends each arbiter a commit request and credits its base fee. With beacons, the first `drawJury` starts the beacon stage and a second one draws the jury once the beacon values are in (see [JuryBeacons](jury-beacons.md)).
3. **Commit.** Each arbiter returns a commit hash. The commit phase closes at the M+-th commit, where M+ = M + ceil((K − M) / 2), or at the first commit after T+ (`tPlus()`, 155 s after the draw) once at least M commits are in. If no commit arrives after T+, `closeCommits(aggId)` closes it (item 14).
4. **Promote** (from block C+2, where C is the block that closed the commit phase). `promote(aggId)` picks M of all commits at random with `keccak256(aggId, "promote", blockhash(C+1))` and sends those arbiters reveal requests. Answering early earns nothing, and the arbiter that closes the phase cannot predict the draw.
5. **Reveal.** The N-th counted reveal finalizes the round: the counted reveals are clustered, the P clustered reveals are averaged into the result, the clustered arbiters are paid a bonus, and the unspent prepay is credited back to the requester.
6. **Settle** (after the round's deadline). `settle(aggId)`, or any later request, reports every slot's outcome to the keeper in one call. Promoted arbiters may still reveal until the deadline, also after finalization; such late reveals are scored but do not change the result.

### Round phases

`getRoundInfo(aggId)` returns the phase as a number:

| Phase | Name | Meaning | Next step |
|-------|------|---------|-----------|
| 0 | none | No such round | |
| 1 | draw | Escrowed, awaiting the jury draw | `drawJury` from block B+2 |
| 2 | beacons | Beacon stage started, awaiting the beacon values | `drawJury` again once the quorum is in or the beacon deadline has passed |
| 3 | commit | Jury drawn, commit requests sent | commits; `closeCommits` after T+ |
| 4 | closing | Commit phase closed, awaiting the promotion draw | `promote` from block C+2 |
| 5 | reveal | Reveal requests sent | reveals; the N-th finalizes |
| 6 | final | Result available, awaiting settlement | `settle` after the deadline |
| 7 | settled | Finished and settled | |
| 8 | failed | Failed, and settled where there was a jury to score | |
| 9 | cancelled | Never drawable: the whole prepay went to the arbiter pool | |

### Defaults

The constructor sets these values, and [`deploy/03_config.js`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/deploy/03_config.js) sets the same ones again.

| Setting | Default | Read it with | Set it with |
|---------|---------|--------------|-------------|
| Largest K a request may ask for | 50 | `maxJury()` | `setLimits` |
| Longest round timeout a request may ask for (a timeout above 1 day is refused even if this allows it) | 3,600 s | `maxTimeout()` | `setLimits` |
| T+, the commit window after the draw; every timeout must exceed it, and a round keeps the T+ of its request | 155 s | `tPlus()` | `setLimits` |
| Bonus multiplier B (bonus = B × the juror's fee) | 3 | `bonusMultiplier()` | `setParams` |
| Highest per-arbiter fee a request can offer (the fee ceiling) | 0.0004 ETH | `maxOracleFee()` | `setParams` |
| Spread floor for the quality classes, on the 0..1,000,000 score scale | 30,000 | `spreadFloor()` | `setParams` |
| Gas stipend per arbiter request | 250,000 | `dispatchGas()` | `setParams` |
| Rounds settled per request, as a multiple of its K | 2 | `settlePerRequest()` | `setParams` |
| Draw reward, in fees | 2 | `drawRewardFees()` | `setRewards` |
| Promote reward, in fees | 1 | `promoteRewardFees()` | `setRewards` |
| Time in which only the requester earns the draw reward | 30 s | `requesterDrawPriority()` | `setRewards` |
| Reveal time guaranteed after `promote` | 120 s | `revealWindow()` | `setRewards` |

There is no treasury setting: v2 has no `treasury()`. Prepay that is not refunded goes to the round's committers or to the [arbiter pool](#the-arbiter-pool), which no address controls.

The keeper's shortlist (`shortlistSize()` on the keeper, 60) also bounds K. Fixed in the code: at most 10 CIDs of at most 100 bytes each, an addendum of at most 1,000 bytes, reveals of 1 to 20 values, each value capped at 1e34, no draw more than 1 day after the request, and a promote grace of 30 s after a late close.

### The jury is the requester's

K, M, N, P and the timeout are not protocol constants. The class presets that Verdikta's applications use (the bounty site and API in `example-bounty-program/shared/classPresets.js`, and the stake-attestation listings) are:

| Preset | K | M | N | P | Timeout | Beacons |
|--------|---|---|---|---|---------|---------|
| Small | 6 | 5 | 4 | 3 | 300 s | no |
| Medium | 8 | 5 | 4 | 3 | 300 s | no |
| Large | 21 | 16 | 13 | 10 | 300 s | no |
| Jumbo | 50 | 38 | 27 | 17 | 600 s | yes |

They are application settings, and any jury that passes the check below is accepted.

## Key Features

- **Per-request jury**: one deployment serves every class of question
- **Unpredictable jury**: drawn from a block hash that did not exist when the request was signed, against the keeper's state at the request block (item 9)
- **Optional jury beacons**: for the largest rounds, the seed also mixes in hash-chain values revealed by beacon arbiters ([JuryBeacons](jury-beacons.md))
- **M+ / T+ promotion**: the reveal set is a random draw from all commits, so a fast arbiter gains nothing (item 14)
- **Commits bound to the round**: `keccak256(abi.encode(aggId, operator, response, salt))`, all 32 bytes, with a 128-bit salt (items 4 and 5)
- **Exact one-number clustering**: a question that asks for one number is clustered exactly; vectors use the nearest-neighbour rule (item 10)
- **Fee floor**: a requester can make every juror cost at least `minFee`, so a re-run cannot be bought cheaply (item 8)
- **ETH escrow with refunds**: the requester prepays the worst case and gets back what the round did not spend, except where a refund would be a free re-roll
- **Settlement without a bot**: new requests settle due rounds within a budget (see [the settlement queue](#driving-a-round)), and anyone may call `settle`
- **Per-arbiter scores**: `getOutcomeScores` returns every counted reveal's score for one outcome, so a consumer can apply its own Q-of-N rule (items 11 and 12)

## Contract Interface

### Request

```solidity
function requestAIEvaluationWithApproval(
    string[] memory cids,
    string memory addendumText,
    uint256 alpha,
    uint256 maxFee,
    uint256 minFee,
    uint256 estimatedBaseCost,
    uint256 maxFeeBasedScalingFactor,
    uint64 requestedClass,
    bool withBeacons,
    Jury calldata j
) external payable nonReentrant whenNotPaused returns (bytes32 aggId)
```

The function keeps its historical name. It is `payable`: the ETH travels with the call and there is no token approval.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cids` | `string[]` | IPFS CIDs of the query package(s): 1 to 10 entries, each at most 100 bytes |
| `addendumText` | `string` | Extra text appended to the query, at most 1,000 bytes. Empty for none |
| `alpha` | `uint256` | Reputation weight, 0 to 1,000: 0 weighs only the quality score, 1,000 only the timeliness score |
| `maxFee` | `uint256` | Fee ceiling, in wei of ETH: the highest per-arbiter fee you accept. Arbiters whose posted fee is above it are not eligible. A value above `maxOracleFee()` is lowered to it; the result is called `eff` below |
| `minFee` | `uint256` | Fee floor, in wei of ETH (item 8). Every juror and every used beacon is paid at least this. 0 for none. It may exceed the ceiling: the ceiling decides who is eligible, the floor what you pay |
| `estimatedBaseCost` | `uint256` | Base cost for the fee weighting, in wei of ETH. Must be below `eff` |
| `maxFeeBasedScalingFactor` | `uint256` | Largest weight boost a cheap arbiter can get from its fee, 1 to 65,535 |
| `requestedClass` | `uint64` | Arbiter class. Only arbiters registered in this class are drawn |
| `withBeacons` | `bool` | Mix jury beacons into the draw seed (the Jumbo preset uses them). Requires a beacon contract (`beacons()` not zero) |
| `j` | `Jury` | The jury: `(K, M, N, P, timeout)`, see below |

#### The jury check

The request reverts with `BadJury()` (from `AggregatorLib.checkJury`) unless all of these hold:

- K ≥ M ≥ N ≥ P ≥ 1;
- N ≤ 40 (the N-th reveal pays for clustering; at 20 outcomes, 40 reveals cost about 8M gas, measured at optimizer runs 200);
- P ≥ 2, unless N = 1 (a cluster holds at least the closest pair);
- K ≤ `maxJury()` (50) and K ≤ the keeper's `shortlistSize()` (60);
- `tPlus()` < timeout ≤ `maxTimeout()` (155 s < timeout ≤ 3,600 s);
- timeout ≤ 1 day (86,400 s, `AggregatorLib.MAX_TIMEOUT`), whatever `maxTimeout()` says: the keeper's unbonding period (at least 2 days) assumes a round settles within a day of its draw.

The round keeps the T+ its timeout was checked against: a later `setLimits` that changes T+ does not change this round's commit window.

The other checks: `KeeperNotSet()` if no keeper is set; `BadInput()` for no CIDs, more than 10, a CID over 100 bytes, an addendum over 1,000 bytes, `estimatedBaseCost >= eff`, `alpha > 1000`, a scaling factor outside 1..65,535, or a prepay above 2^88 − 1 wei; `InsufficientPayment()` if `msg.value` plus your credit is below the prepay; `EnforcedPause()` while paused. A request with `withBeacons` while `beacons()` is zero reverts without an error message.

#### ETH to send

The call must be funded with `maxTotalFee(maxFee, minFee, withBeacons, j.K, j.P)` (see [Fee Structure](#fee-structure)). Credit in `ethOwed(caller)` covers only what `msg.value` does not: sending exactly the prepay leaves your credit untouched, and any ETH above it is added to your credit. The escrow is always exactly the prepay. `RequestFunded` records how much came from credit and how much from `msg.value`.

Before it escrows, the request settles due rounds from the settlement queue until `settlePerRequest() × K` slots are spent (see [the settlement queue](#driving-a-round)), so its gas use depends a little on other rounds.

#### Returns

`aggId`: the round's identifier, `bytes32(roundId)`. Round ids are sequential from 1 (`roundCount()` is the latest). The same value is the indexed first argument of `RequestAIEvaluation` and `RequestFunded`, and it is sent to each arbiter as the `aggId` request parameter (`0x` and 64 lowercase hex digits).

### Driving a round

All of these may be called by anyone.

```solidity
// Draw the jury and send the commit requests (from block B+2, at most 1 day after the request).
// With beacons: the first call starts the beacon stage, a second call draws.
function drawJury(bytes32 aggId) external

// Store blockhash(B+1) while it is still readable (about 30k gas). drawJury seals it too,
// so this is needed only if the draw will come more than 8,191 blocks (about 27 min) after B+1
function sealSeed(bytes32 aggId) external

// Close the commit phase once T+ has passed with at least M commits, before the deadline
function closeCommits(bytes32 aggId) external

// Draw the M promoted commits and send the reveal requests (from block C+2, before the deadline)
function promote(bytes32 aggId) external

// Settle a round in phase 3 to 6 once its deadline has passed
function settle(bytes32 aggId) external

// Send a round that can never be drawn to the arbiter pool: unsealed once blockhash(B+1) has left
// the 8,191-block history, or sealed but undrawn 1 day after the request
function cancelUnsealed(bytes32 aggId) external
```

**`drawJury`.**

- Reverts with:
    - `WrongPhase()` outside phases 1 and 2;
    - `DrawExpired()` more than 1 day after the request;
    - `TooEarly()` before block B+2, or in the beacon stage while the beacons are still pending;
    - `SeedExpired()` if the seed was never sealed and blockhash(B+1) is no longer readable;
    - `OutOfGas()` if the caller sent too little gas for the keeper call.
- It reads block hashes with `BLOCKHASH` for 256 blocks and then from the EIP-2935 history contract for up to 8,191 blocks.
- On success the phase becomes 3 (commit). The deadline is set to `now + timeout` and the commit window to `now +` the T+ in force at the request (`windowEnd`), which a later `setLimits` does not change. The keeper sends a health call to every juror and to 3 other shortlisted arbiters.
- **Repeats.** When the keeper's shortlist ends up with m < K arbiters, the jury fills with repeats: slot k holds pick k mod m. This happens:
    - when fewer than K arbiters are eligible;
    - when `shortlistSize()` was lowered below K after the request (selection reads the current value);
    - when the walk stops at `maxScan()` (400) entries before it has found K eligible ones, though the class holds more.

    One operator can then hold several slots, or every slot. Each slot is paid, committed, revealed and scored separately, and a Q-of-N rule over `getOutcomeScores` counts slots, not distinct arbiters. Selection fails (`NoEligibleArbiters`) only when it finds none.
- If the keeper finds no eligible arbiter, the round fails (phase 8, `EvaluationFailed(aggId, 1)`). The prepay is refunded, since no jury could be drawn and so the refund is no re-roll.
    - After a beacon stage, the refund goes to the requester only if the selection walk covers the whole class list (`keeper.scansAll(cls)`). Otherwise it goes to the arbiter pool, because the failure could depend on the beacon seed.
- If the beacon stage finds fewer beacon candidates than the quorum, the round fails at the first call and is refunded.
- **Arbiter pool payout:** a call that draws a jury also pays an eighth of the [arbiter pool](#the-arbiter-pool), at most that draw's base fees, to one registered arbiter's payee (`PoolPayment`). The first call of a beacon round and a failed draw pay nothing from the pool.
- **Draw reward:** `eff × drawRewardFees()` (2 fees) is credited to the caller. Within `requesterDrawPriority()` (30 s) of the request, or of the quorum-th beacon value, only the requester earns it; a third party that draws in that time earns nothing. After it, whoever draws earns it. The first call of a beacon round earns no reward.
- **Second call of a beacon round:**
    - Each used beacon value is paid `max(eff, minFee)` to the beacon's operator owner (`BeaconPayment`).
    - If the quorum was missed by the beacon deadline, the round ends with no result (phase 8, `EvaluationFailed(aggId, 2)`), and the unspent prepay goes to the arbiter pool.

**Commits** arrive through `fulfill` (below). A commit closes the phase when it is the M+-th, or when it arrives after T+ with at least M commits in. Closing records block C and makes sure the deadline is at least 30 s away, so `promote` still fits.

**`promote`.**

- Reverts with:
    - `WrongPhase()` outside phase 4, or after the deadline;
    - `TooEarly()` before block C+2;
    - `SeedExpired()` if blockhash(C+1) is unreadable.
- It sends each promoted arbiter a reveal request `2:<commit hash as 64 lowercase hex>`.
- It extends the deadline to at least `now + revealWindow()` (120 s).
- It credits the caller `eff × promoteRewardFees()` (1 fee). No event records this reward; it is counted in `rewards` of `getRoundInfo`.

**`settle`** reverts with `WrongPhase()` outside phases 3 to 6 and `NotDue()` until the deadline has passed. A round that never finalized is failed here, with `EvaluationFailed(aggId, phase)` for phase 3, 4 or 5. If such a round had at least M commits but was never promoted (phase 4, or phase 3 with at least M commits), its unspent prepay is shared equally by the slots that committed (`CommitPayment` per slot, to the slot's payee); the indivisible remainder goes to the arbiter pool. Then one call to the keeper's `applyOutcomes` carries every slot's outcome code (see [Settlement](#settlement)).

**The settlement queue.** Every drawn round joins a queue. Each new request walks the queue in order, settling due rounds until `settlePerRequest() × K` slots are spent, where K is the new request's. The last round settled may overshoot the budget by at most its own K, so the first due round is always settled, whatever its size: a big round at the head cannot stall the queue. The walk stops at the first unsettled round whose deadline has not passed. Rounds behind it wait as well, even if they are due, until it is due or anyone calls `settle`, so a long-timeout round at the head holds back shorter ones. The walk takes at most `settlePerRequest() × 8` queue entries per request. `setParams` accepts `settlePerRequest = 0`, which turns settlement by requests off: then only `settle` settles. Until a round settles, its scores and penalties (and a failed round's refund) wait, and an arbiter that completes its exit first escapes them; a result is readable from finalization.

**`cancelUnsealed`** reverts with `WrongPhase()` outside phases 1 and 2 and `TooEarly()` before its time. It credits the whole prepay to the arbiter pool (phase 9, `RoundCancelled(aggId, toPool)`). An undrawn round never times out on its own: only this call ends it.

### Arbiter callback

```solidity
// Called by the arbiter's operator contract, for commits and reveals alike
function fulfill(bytes32 requestId, uint256[] memory response, string memory cid) public
```

| Request | Payload sent (`cid` parameter) | Answer expected |
|---------|-------------------------------|-----------------|
| Commit | `1:<cid>,<cid>,...[:<addendum>]` | `response = [commit hash]`, `cid = ""` |
| Reveal | `2:<64 lowercase hex>`, the slot's commit hash | `response` = the committed scores (1 to 20 values), `cid = "<justification cid>:<32 hex salt>"` |

- The commit hash is `keccak256(abi.encode(bytes32 aggId, address operator, uint256[] response, uint256 salt))`, where `operator` is the operator contract that calls `fulfill`. The salt is 128 bits, sent as 32 hex digits in either case. The reveal's `cid` is at most 133 bytes.
- Anything that does not fit is ignored without a revert, and the request is used up: there is no retry. This covers:
    - a commit outside phase 3, a zero hash, or a second commit;
    - a reveal from a slot that was not promoted or already revealed;
    - a reveal with the wrong length or a malformed salt;
    - a reveal that does not match the commit.
- After the deadline every answer is ignored.
- Reveal values above 1e34 are cut to 1e34. Arbiters answer on a 0..1,000,000 scale.
- The N-th counted reveal pays for clustering. At Jumbo that is 1.3M gas with one-number answers, 2.6M with two outcomes and 6.9M at 20 outcomes (measured at optimizer runs 200; the contracts now build with 20 runs, see the note at the top). The arbiter's job gas limit must cover it.

### View Functions

```solidity
// Result. valid is true from finalization (phase 6) on, also after settlement (phase 7)
function getEvaluation(bytes32 aggId)
    external view returns (uint256[] memory aggregated, string memory justifications, bool valid)
// justifications: the clustered arbiters' justification CIDs, comma-separated

// Every counted reveal's raw score for one outcome, in reveal order (0 where a reveal was short).
// valid is false until finalization, for a failed round, and for an outcome past the result's length
function getOutcomeScores(bytes32 aggId, uint256 outcome)
    external view returns (uint256[] memory scores, bool valid)

// Phase, draw blocks, the escrow and the round's timing
function getRoundInfo(bytes32 aggId)
    external view returns (
        uint8 phase,          // 1 draw ... 9 cancelled (table above)
        uint256 requestBlock, // B
        bytes32 sealedHash,   // blockhash(B+1), 0 until sealed
        uint256 closeBlock,   // C, 0 until the commit phase closes
        uint256 received,     // the prepay held for the round (wei)
        uint256 baseFees,     // base fees credited at the draw
        uint256 bonuses,      // bonuses credited at finalization
        uint256 rewards,      // draw and promote rewards, beacon payments, committers' shares
        uint256 deadline,     // 0 until the draw; settle is due after it
        uint256 windowEnd,    // 0 until the draw, then the draw time + the request's T+
        uint256 commits,      // commits received
        uint256 requestTime   // drawJury's 1-day limit and cancelUnsealed run from it
    )

// The jury the round was requested with (zeros for an unknown round)
function getJury(bytes32 aggId)
    external view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)

// True only in phase 8. A cancelled round (phase 9) is not "failed": read the phase
function isFailed(bytes32 aggId) external view returns (bool)

// One slot of the jury
function getSlot(bytes32 aggId, uint256 i) external view returns (Slot memory)
// Slot: oracle (read from the keeper by key), fee (paid: max(posted fee at B, minFee)), key (keeper key),
//       payee (operator owner), committedAt (always 0: the time is in CommitReceived's block),
//       flags (1 dispatched, 2 committed, 4 promoted, 8 revealed, 16 counted),
//       qcode (quality class: 1 close, 2 off, 3 far), commitHash

// The prepay for a request, in wei (see Fee Structure)
function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P)
    public view returns (uint256)

// ETH (wei) held for an address: arbiter earnings, rewards, refunds, overpayments.
// ethOwed(address(0)) is the arbiter pool
function ethOwed(address payee) external view returns (uint256)

// Chainlink request id => operator << 96 | roundId << 8 | slot, until the request is answered; 0 after
function requestRef(bytes32 requestId) external view returns (uint256)

function roundCount() external view returns (uint256)
function settleQueue(uint256 i) external view returns (uint256)   // round ids, in draw order
function settleHead() external view returns (uint256)             // next queue entry to settle
function keeper() external view returns (address)
function beacons() external view returns (address)                // 0 = beacons off
```

The settings in the [Defaults](#defaults) table have getters of the same name.

### Withdrawals

```solidity
// Send the caller's whole ethOwed balance to the caller
function withdrawEth() external

// Send payee's whole ethOwed balance to payee. Callable by payee or by the contract owner.
// Reverts NotAuthorized() for payee = address(0), the arbiter pool
function withdrawEthFor(address payee) external
```

The owner has no function that takes ETH out of the contract. The only code that sends ETH is the internal `_withdrawTo(payee)`, reached through these two functions, and it always pays the address the ETH is credited to. Nobody can withdraw the arbiter pool: `withdrawEthFor(address(0))` reverts, and `msg.sender` is never address(0). The pool leaves the contract only through its payouts to arbiters, who then withdraw like any payee.

### Configuration Functions (Owner Only)

```solidity
// Bounds on a request's jury: largest K, longest timeout, and T+ (seconds).
// Reverts InvalidConfig() if maxJury_ == 0, tPlus_ == 0 or maxTimeout_ <= tPlus_.
// A maxTimeout_ above one day is accepted, but checkJury caps every request's timeout at
// one day (AggregatorLib.MAX_TIMEOUT), so no request can use more
function setLimits(uint8 maxJury_, uint40 maxTimeout_, uint40 tPlus_) external onlyOwner

// Bonus multiplier (at most 20), rounds settled per request (any value; 0 turns settlement by
// requests off), the dispatch stipend (100,000 to 2,000,000 gas), the spread floor (at most 1e34)
// and the fee ceiling (wei). Else InvalidConfig()
function setParams(uint8 bonusMult, uint8 settlePerReq, uint32 dispatchGas_,
                   uint256 spreadFloor_, uint256 maxOracleFee_) external onlyOwner

// Draw reward (fees), the requester's draw priority (s), promote reward (fees) and the reveal
// window (s, not 0, else InvalidConfig())
function setRewards(uint8 drawFees_, uint40 priority, uint8 promoteFees_, uint40 revealWindow_) external onlyOwner

// Keeper and beacon contract (0 = beacons off). The keeper must not be 0, else InvalidConfig().
// Rounds in flight call the new contracts: change the keeper only when no round awaits settlement,
// and the beacon contract only when no round is in its beacon stage
function setContracts(address keeper_, address beacons_) external onlyOwner

// Stop and resume new requests. Draws, commits, reveals, settlement, cancellation and
// withdrawals keep working while paused
function pause() external onlyOwner
function unpause() external onlyOwner
```

The bonus multiplier, the draw and promote rewards and the beacon quorum are fixed in each round at its request, since its escrow was sized on them. The spread floor, the dispatch stipend, the draw priority and the reveal window apply to rounds in flight. A round keeps the T+ of its request: `checkJury` checks the timeout against it, the round holds it in `windowEnd` until the draw, and the draw adds the draw time. A T+ changed in between does not reach that round, so it can never push the commit window past the deadline. The `maxTimeout` in force at the request applies, and no timeout may exceed one day whatever it says. The shortlist that bounds K is read at the request, and again by the keeper at the draw. Ownership uses OpenZeppelin `Ownable` (`owner()`, `transferOwnership`, `renounceOwnership`).

**How requests go out.** The aggregator does not use Chainlink's `ChainlinkClient`. It builds one request per round as calldata for LINK's `transferAndCall(operator, 0, operatorRequest(...))`, byte for byte what `ChainlinkClient` would send (CBOR parameters `cid` and `aggId`, data version 2, callback `fulfill`), and writes in each slot's operator, job id and nonce. Each call gets the `dispatchGas` stipend; a slot whose operator reverts, burns the stipend or makes LINK return false is skipped (`SlotSkipped`). The nonce is `(roundId << 8 | slot) << 1 | r`, with `r` 0 for the commit request and 1 for the reveal, so a request id can be computed off-chain: `keccak256(abi.encodePacked(aggregator, nonce))`, as the operator computes it. `fulfill` accepts an answer only from the operator the request went to, and only once (`UnknownRequest()` otherwise).

## Events

Amounts are in wei of ETH. A payment is a credit in `ethOwed`, collected with `withdrawEth()`.

```solidity
event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);
event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash);
event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons);
event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
event PoolPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);   // emitted by AggregatorLib, in the aggregator's context
event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward);
event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash);
event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock);
event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted);
event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode);
event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);   // requester 0 = the arbiter pool
event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase);
event RoundSettled(bytes32 indexed aggRequestId, bool failed);
event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool);
event SlotSkipped(bytes32 indexed aggRequestId, uint256 pollIndex, uint8 reason);
event EthWithdrawn(address indexed payee, uint256 amount);
```

v2 has no diagnostic events for rejected reveals: a bad reveal is ignored, and only `RevealReceived` is emitted for good ones. The [Events Reference](../api/events.md) gives each event's fields and when it fires.

## Usage Examples

### Basic Integration

This contract passes on the ETH it is called with, so it does not have to be funded in advance. Because it is the requester, it should also pass `drawJury` through: within 30 s of the request only the requester earns the draw reward.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IReputationAggregator {
    struct Jury { uint8 K; uint8 M; uint8 N; uint8 P; uint40 timeout; }

    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxFee,
        uint256 minFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass,
        bool withBeacons,
        Jury calldata j
    ) external payable returns (bytes32);

    function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P)
        external view returns (uint256);
    function drawJury(bytes32 aggId) external;
    function getEvaluation(bytes32 aggId) external view returns (uint256[] memory, string memory, bool);
    // getRoundInfo returns 12 values; only the first, the phase, is declared here.
    // The decoder ignores the rest, and the full tuple would not fit on the stack
    function getRoundInfo(bytes32 aggId) external view returns (uint8 phase);
    function withdrawEth() external;
}

contract EvaluationClient {
    IReputationAggregator public immutable aggregator;
    address public immutable owner;

    uint256 public constant MAX_FEE   = 15e13;   // fee ceiling: 0.00015 ETH per arbiter
    uint256 public constant MIN_FEE   = 0;       // no fee floor
    uint256 public constant BASE_COST = 8e9;     // below MAX_FEE
    uint64  public constant CLASS     = 128;

    // The Small preset: 6 drawn, 5 promoted, 4 counted, 3 clustered, 300 s from the draw
    uint8  public constant K = 6;
    uint8  public constant M = 5;
    uint8  public constant N = 4;
    uint8  public constant P = 3;
    uint40 public constant TIMEOUT = 300;

    mapping(bytes32 => address) public requesterOf;

    event Requested(bytes32 indexed aggId, address indexed requester);
    event Resolved(bytes32 indexed aggId, uint256[] scores, string justifications);
    event Failed(bytes32 indexed aggId, uint8 phase);

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
        owner = msg.sender;
    }

    // ETH to send with requestEvaluation()
    function quote() public view returns (uint256) {
        return aggregator.maxTotalFee(MAX_FEE, MIN_FEE, false, K, P);
    }

    // memory, not calldata, parameters: with calldata ones the 10-argument call is
    // "stack too deep" unless the contract is compiled with viaIR
    function requestEvaluation(string[] memory evidenceCIDs, string memory description)
        external payable returns (bytes32 aggId)
    {
        // Send quote(): the aggregator takes any shortfall from this contract's credit
        // there, or reverts with InsufficientPayment()
        aggId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidenceCIDs,
            description,
            500,              // equal weight on timeliness and quality
            MAX_FEE,
            MIN_FEE,
            BASE_COST,
            5,                // up to 5x weight for a cheap arbiter
            CLASS,
            false,            // no beacons
            IReputationAggregator.Jury(K, M, N, P, TIMEOUT)
        );
        requesterOf[aggId] = msg.sender;
        emit Requested(aggId, msg.sender);
    }

    // Call from block B+2 on. As the requester, this contract earns the draw reward
    // (2 x MAX_FEE, credited to it in the aggregator) if it draws within 30 s
    function draw(bytes32 aggId) external {
        require(requesterOf[aggId] != address(0), "Unknown request");
        aggregator.drawJury(aggId);
    }

    function resolve(bytes32 aggId) external {
        require(requesterOf[aggId] != address(0), "Unknown request");
        (uint256[] memory scores, string memory justifications, bool valid) = aggregator.getEvaluation(aggId);
        if (valid) {
            delete requesterOf[aggId];
            emit Resolved(aggId, scores, justifications);
            return;
        }
        uint8 phase = aggregator.getRoundInfo(aggId);
        // 8 = failed, 9 = cancelled. A round that is still running is not settled
        // automatically: anyone may call settle(aggId) on the aggregator after its deadline
        require(phase == 8 || phase == 9, "Evaluation not complete");
        delete requesterOf[aggId];
        emit Failed(aggId, phase);
    }

    // Refunds and draw rewards are credited to this contract in the aggregator
    function reclaim() external {
        require(msg.sender == owner, "Not owner");
        aggregator.withdrawEth();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "Transfer failed");
    }

    receive() external payable {}
}
```

### Frontend Integration

```javascript
import { ethers } from 'ethers';

const JURY = '(uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)';
const REPUTATION_AGGREGATOR_ABI = [
    `function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons, ${JURY} j) payable returns (bytes32)`,
    'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
    'function ethOwed(address payee) view returns (uint256)',
    'function drawJury(bytes32 aggId)',
    'function closeCommits(bytes32 aggId)',
    'function promote(bytes32 aggId)',
    'function settle(bytes32 aggId)',
    'function getEvaluation(bytes32 aggId) view returns (uint256[] aggregated, string justifications, bool valid)',
    'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
    'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
    'function withdrawEth()',
    'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
    'event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward)',
    'event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash)',
    'event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock)',
    'event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted)',
    'event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode)',
    'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
    'event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase)'
];

const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
const PHASE = ['none', 'draw', 'beacons', 'commit', 'closing', 'reveal', 'final', 'settled', 'failed', 'cancelled'];

class VerdiktaDispatcher {
    constructor(contractAddress, signer) {
        this.signer = signer;
        this.contract = new ethers.Contract(contractAddress, REPUTATION_AGGREGATOR_ABI, signer);
    }

    // cids: IPFS CIDs of the query package(s) to evaluate
    async submitRequest(cids, description, options = {}) {
        const maxFee = options.maxFee ?? ethers.parseEther('0.00015');   // fee ceiling
        const minFee = options.minFee ?? 0n;                              // fee floor
        const baseCost = options.baseCost ?? 8_000_000_000n;
        const withBeacons = options.withBeacons ?? false;
        const jury = options.jury ?? SMALL;

        // The prepay. Credit in the aggregator covers only what msg.value does not
        const required = await this.contract.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P);
        const credit = await this.contract.ethOwed(await this.signer.getAddress());
        const value = required > credit ? required - credit : 0n;

        const args = [cids, description, options.alpha ?? 500, maxFee, minFee, baseCost,
                      options.scalingFactor ?? 5, options.oracleClass ?? 128, withBeacons, jury];

        // The request settles due rounds first, so its gas varies: add headroom
        const estimate = await this.contract.requestAIEvaluationWithApproval.estimateGas(...args, { value });
        const tx = await this.contract.requestAIEvaluationWithApproval(...args, { value, gasLimit: estimate * 150n / 100n });
        const receipt = await tx.wait();

        const topic = this.contract.interface.getEvent('RequestAIEvaluation').topicHash;
        const log = receipt.logs.find(l => l.address.toLowerCase() === this.contract.target.toLowerCase()
                                        && l.topics[0] === topic);
        return { aggregatorId: log.topics[1], blockNumber: receipt.blockNumber, valueSent: value };
    }

    // From block B+2. Twice for a beacon round: once to start the stage,
    // again once the beacon values are in (drawJury reverts TooEarly() while they are pending)
    async draw(aggregatorId) {
        const info = await this.contract.getRoundInfo(aggregatorId);
        const provider = this.signer.provider;
        while (BigInt(await provider.getBlockNumber()) < info.requestBlock + 2n) {
            await new Promise(r => setTimeout(r, 1000));
        }
        const estimate = await this.contract.drawJury.estimateGas(aggregatorId);
        return (await this.contract.drawJury(aggregatorId, { gasLimit: estimate * 150n / 100n })).wait();
    }

    // Moves a round on when nobody else does: close the commit phase after T+,
    // promote from block C+2, settle after the deadline. Anyone may call these
    async nudge(aggregatorId) {
        const info = await this.contract.getRoundInfo(aggregatorId);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const phase = Number(info.phase);
        if (phase === 3 && now > info.windowEnd && now <= info.deadline) {
            const { M } = await this.contract.getJury(aggregatorId);
            if (info.commits >= M) return (await this.contract.closeCommits(aggregatorId)).wait();
        }
        if (phase === 4) return (await this.contract.promote(aggregatorId)).wait();
        if (phase >= 3 && phase <= 6 && info.deadline > 0n && now > info.deadline) {
            return (await this.contract.settle(aggregatorId)).wait();
        }
    }

    async getResult(aggregatorId) {
        const [aggregated, justifications, valid] = await this.contract.getEvaluation(aggregatorId);
        if (valid) {
            return {
                status: 'complete',
                scores: aggregated.map(s => Number(s)),            // 0..1,000,000 scale
                justificationCIDs: justifications.split(',')        // one per clustered arbiter
            };
        }
        const info = await this.contract.getRoundInfo(aggregatorId);
        return { status: PHASE[Number(info.phase)], deadline: Number(info.deadline) };
    }

    // Take the caller's credit (refunds, rewards) out of the aggregator
    async withdrawCredit() {
        return (await this.contract.withdrawEth()).wait();
    }

    // With a filter object, ethers v6 passes one argument, the event; the values are in event.args
    watchProgress(aggregatorId, callbacks = {}) {
        const filters = {
            drawn: this.contract.filters.JuryDrawn(aggregatorId),
            commitReceived: this.contract.filters.CommitReceived(aggregatorId),
            commitClosed: this.contract.filters.CommitWindowClosed(aggregatorId),
            promoted: this.contract.filters.CommitPhaseComplete(aggregatorId),
            revealReceived: this.contract.filters.RevealReceived(aggregatorId),
            fulfilled: this.contract.filters.FulfillAIEvaluation(aggregatorId),
            failed: this.contract.filters.EvaluationFailed(aggregatorId)
        };
        Object.entries(filters).forEach(([name, filter]) => {
            if (callbacks[name]) this.contract.on(filter, callbacks[name]);
        });
        return () => Object.values(filters).forEach(filter => this.contract.off(filter));
    }
}
```

The repository's scripts that drive a v2 round, such as `single-query.js` and `refund.js`, are still being ported: [`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md#scripts-in-this-folder) lists each one and its v2 calls. The tests in `reputationBasedAggregator/test/` (`round.js` and `aggregator.flow.test.js`) drive full rounds.

## Scoring and Aggregation

- **Normalization.** The counted reveals are resized to their most common length, truncating or zero-filling. On a tie the longer length wins.
- **One-number answers.** When single values are the most common length, the cluster is exact: the P consecutive values, in sorted order, with the smallest sum of pairwise squared differences. Longer reveals are cut to their first value.
- **Vectors.** For each counted reveal, its group is the reveal and its P − 1 nearest by squared Euclidean distance. The cluster is the group with the smallest sum of pairwise distances (item 10).
- **Ties** go by `keccak256(sealed hash, slot)`, not by reveal order.
- **Result.** The result is the cluster's coordinate-wise mean. `justifications` lists the clustered reveals' CIDs.
- **Quality classes.** Each counted reveal's distance is d = max over outcomes of |score − median|, against the coordinate-wise median of the counted reveals. The spread is max(1.4826 × the median of d, `spreadFloor()`). A reveal is:
    - close if d ≤ 1.5 × spread;
    - off if d ≤ 3 × spread;
    - far otherwise.

    A late reveal is classified on arrival against the stored median and spread.

## Settlement

At settlement each slot gets an outcome code for the keeper:

- the low nibble is the timeliness event;
- bits 4 and 5 are the quality class;
- bit 7 (`0x80`) means the arbiter committed in this round, so it is scored even if it was frozen at the round's end.

| Round ended in | Slot | Code | Keeper points (defaults) |
|----------------|------|------|--------------------------|
| Final (6) | promoted, revealed (counted or late) | 1 + quality class | timeliness +20; quality +20 close, −50 off, −200 far |
| Final (6) | promoted, no reveal | 2 | timeliness −200 |
| Reveal (5): fewer than N reveals | promoted, revealed | 1 | timeliness +20 |
| Reveal (5) | promoted, no reveal | 3 | timeliness −500 |
| Commit (3), 1 to M − 1 commits | no commit | 4 | timeliness −400 |
| Commit (3) with no commit at all | any | 0 | none: the failure is the request's (one every honest arbiter refuses) or a shared outage's |
| Commit (3) with M commits, or closing (4) | any | 0 | none: nobody failed to deliver |
| any | not promoted | 0 | none |

The keeper turns the codes into points and consequences: see [ReputationKeeper](reputation-keeper.md#reputation-points). If the keeper call fails, the round is still settled and `SlotSkipped(aggId, type(uint256).max, 4)` is emitted. A caller that sends too little gas gets `OutOfGas()` instead, so it cannot skip the scores on purpose.

## Security Considerations

### Commit-Reveal Protection

- **Bound commits**: the commit covers the round (`aggId`), the operator and a 128-bit salt, and uses all 32 bytes of Keccak-256. A collision would take about 2^128 work and could serve one round only.
- **Random promotion**: the M revealers are drawn from all commits after the window closes, with a block hash nobody knew when it closed.
- **One answer per request**: a malformed reveal uses up the request.

### Draw Integrity

- **Unpredictable seed**: the jury depends only on blockhash(B+1) (and, with beacons, the beacon values) and on the keeper's state as of block B. The result is the same whoever draws and whenever.
- **No free re-roll**: refunds are given only where the requester could not have chosen the outcome. A round with M commits that was never promoted pays its unspent prepay to the slots that committed. These rounds send it to the arbiter pool:
    - a missed beacon quorum;
    - a cancelled round;
    - a draw that fails after a beacon stage when the walk does not cover the class list.
- **The pool cannot be steered**: each pool payout is picked from the draw's seed, which a block hash fixes after the request and which is the same whoever draws. A forfeiting round never picks its own winner, and paying an eighth per draw, at most the draw's own base fees, makes grinding with many requests cost more than it wins.

### Economic Security

- **Stake**: arbiters stake 100 VDKA (the keeper's `stakeRequirement()`) and can lose it to burns and bans. See [ReputationKeeper](reputation-keeper.md).
- **Fee floor**: with `minFee`, every attempt costs at least K × `minFee`, or (K + 2) × `minFee` with beacons.
- **Bonus alignment**: only the P clustered reveals earn the B × fee bonus.

### Operational Security

- **Gas stipends**: calls to arbiter contracts get a fixed stipend (`dispatchGas()` for requests, 30,000 for `owner()`), and each tolerated call first checks that the stipend is really available. Neither a gas-burning operator nor a caller's gas limit can drop a slot or the scores. A skipped slot emits `SlotSkipped`:
    - reason 1: `owner()` unreadable;
    - reason 2: the commit dispatch reverted;
    - reason 3: the reveal dispatch reverted.
- **Access control**: anyone can request by paying. The layer below is restricted: only contracts approved in the keeper (`setApproved`) can select arbiters and report outcomes. An ArbiterOperator with a keeper list accepts requests only from contracts that one of those keepers approves (`isContractApproved`).
- **Pause**: `pause()` stops new requests only.

## Fee Structure

**Prepay**, returned by `maxTotalFee(maxFee, minFee, withBeacons, K, P)`:

```
eff     = min(maxFee, maxOracleFee())          the fee ceiling
juror   = max(eff, minFee)                     the most a juror or beacon is paid
prepay  = juror × (K + bonusMultiplier() × P + [beacon quorum, if withBeacons])
        + eff × (drawRewardFees() + promoteRewardFees())
```

With the defaults (bonus 3, draw 2, promote 1, quorum 2) that is `juror × (K + 3P [+ 2]) + eff × 3`. At the ceiling of 0.0004 ETH and no floor:

| Preset | Prepay |
|--------|--------|
| Small (K 6, P 3) | 0.0004 × (6 + 9 + 3) = 0.0072 ETH |
| Large (K 21, P 10) | 0.0004 × (21 + 30 + 3) = 0.0216 ETH |
| Jumbo with beacons (K 50, P 17) | 0.0004 × (50 + 51 + 2 + 3) = 0.0424 ETH |

**What a round spends:**

1. **Base fees**, at the draw: each dispatched slot's payee (the operator's `owner()`) is credited the slot's fee, `max(posted fee as of B, minFee)` (`BasePayment`). A skipped slot is not credited.
2. **Draw reward**, at the draw: `eff × 2` to the drawer, if it earned it (`JuryDrawn`).
3. **Beacon payments**: `juror` per used beacon value (`BeaconPayment`).
4. **Promote reward**: `eff × 1` to the caller of `promote`.
5. **Bonuses**, at finalization: `bonusMultiplier × fee` to each clustered slot's payee (`BonusPayment`).
6. **The rest**, at the end:

| How the round ended | Unspent prepay goes to | When |
|---------------------|------------------------|------|
| Finalized | the requester | at finalization |
| No eligible arbiter, or fewer beacon candidates than the quorum | the requester | at the draw |
| Draw failed after a beacon stage, and `keeper.scansAll(cls)` is false | the arbiter pool | at the draw |
| Beacon quorum missed | the arbiter pool | at the second `drawJury` |
| Commit phase with fewer than M commits | the requester | at settlement |
| M commits but never promoted (closed and not promoted, or not closed after T+) | the slots that committed, in equal shares (`CommitPayment`); the remainder of under one wei per committer to the arbiter pool | at settlement |
| Reveal phase with fewer than N counted reveals | the requester | at settlement |
| Cancelled (`cancelUnsealed`) | the arbiter pool: the whole prepay | at cancellation |

Each credit of the rest emits `RequesterRefunded(aggId, to, amount)` when the amount is not zero, where `to` is the requester or address(0) for the arbiter pool. A cancellation emits `RoundCancelled` instead. The committers' shares are counted in `rewards`.

### The arbiter pool

The pool replaces the treasury of earlier v2 drafts (v1 had neither). It is the ledger entry `ethOwed(address(0))`, and no address can withdraw it. It is paid out at draws:

- every `drawJury` that draws a jury pays `min(ethOwed(address(0)) / 8, the draw's base fees)` to one registered arbiter (`PoolPayment(aggId, payee, amount)`);
- the keeper's `poolPayee(seed)` picks the arbiter uniformly from the draw's seed and returns its payee, its operator's `owner()`;
- it makes at most two picks and skips arbiters that are paused, banned, exiting or understaked; if both miss, nobody is paid and the pool waits for the next draw;
- the keeper call is capped at 80,000 gas and its failure is caught, so it can never make the draw fail.

A requester that draws its own round within 30 s gets the draw reward back, and one that calls `promote` gets the promote reward back. Both are paid on the ceiling, so none of the floor comes back this way. Network gas comes on top. All credits are entries in `ethOwed`. A requester's credit pays for its next request, or `withdrawEth()` takes it out. Arbiter owners collect their earnings the same way.

For the full accounting see [Fee Mechanisms](../advanced/fees.md).

## Troubleshooting

### Common Issues

**`BadJury()`**: check K ≥ M ≥ N ≥ P ≥ 1, N ≤ 40, P ≥ 2 unless N = 1, K ≤ `maxJury()` and ≤ the keeper's `shortlistSize()`, and `tPlus()` < timeout ≤ `maxTimeout()` and ≤ 1 day (86,400 s).

**`InsufficientPayment()`**
```javascript
const required = await contract.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P);
const credit = await contract.ethOwed(await signer.getAddress());
const value = required > credit ? required - credit : 0n;
await contract.requestAIEvaluationWithApproval(/* ... */, { value });
```

**`BadInput()`**: check the CID and addendum limits, `estimatedBaseCost < min(maxFee, maxOracleFee())`, `alpha ≤ 1000` and a scaling factor from 1 to 65,535.

**The round stays in phase 1 (draw)**: nobody has called `drawJury`. An undrawn round never times out. Call `drawJury` from block B+2. After a day it can only be cancelled to the arbiter pool.

**`drawJury` reverts with `TooEarly()` in phase 2**: the beacon values are not in yet. Try again; the stage ends at the beacon deadline (`timeout()` on JuryBeacons, 120 s), ready or expired.

**The round stays in phase 3 or 4**: if T+ has passed with at least M commits, call `closeCommits`. In phase 4, call `promote` from block C+2.

**The round failed with no refund**: see the table under [Fee Structure](#fee-structure). Rounds that could be a free re-roll are not refunded.

**The result is in but the round stays in phase 6**: that is normal until the deadline. Settlement only reports the scores to the keeper; the result is valid from phase 6. Call `settle(aggId)` after the deadline if no new request has settled it.

### Error Codes

| Error | Cause | Solution |
|-------|-------|----------|
| `BadJury()` | The jury fails the check above | Fix K/M/N/P or the timeout |
| `BadInput()` | Malformed request (CIDs, addendum, base cost, alpha, scaling, prepay size) | Fix the parameter |
| `KeeperNotSet()` | No keeper configured | Owner: `setContracts` |
| `InsufficientPayment()` | `msg.value` plus credit is below the prepay | Send the missing ETH |
| `EnforcedPause()` | New requests are paused | Wait for `unpause()` |
| `WrongPhase()` | The call does not fit the round's phase or deadline | Read `getRoundInfo` |
| `TooEarly()` | Before B+2, before C+2, beacons pending, or too early to cancel | Wait |
| `SeedExpired()` | blockhash(B+1) or blockhash(C+1) is no longer readable (older than 8,191 blocks) | Unsealed B+1: `cancelUnsealed`, and draw or `sealSeed` sooner next time. C+1: the round can only be settled after its deadline |
| `DrawExpired()` | `drawJury` more than 1 day after the request | `cancelUnsealed` |
| `NotDue()` | `settle` before the deadline | Wait for the deadline |
| `OutOfGas()` | Too little gas for a tolerated call or for settlement | Raise the gas limit |
| `NothingOwed()` | Withdrawal with no credit | Nothing to withdraw |

The [Error Reference](../api/errors.md) lists every error of the v2 contracts.

## Best Practices

1. **Quote with `maxTotalFee(maxFee, minFee, withBeacons, K, P)`** for the jury you will send, and count your `ethOwed` credit.
2. **Draw your own rounds** from block B+2: you get the draw reward back, and an undrawn round never ends by itself.
3. **Keep the round moving**: `closeCommits` after T+, `promote` from C+2, `settle` after the deadline. Anyone may call them.
4. **Read the phase, not just `isFailed`**: a cancelled round is phase 9 and `isFailed` is false for it.
5. **Ask one-number questions for one number**: arbiters then return `[score]`, which is clustered exactly. Read the per-arbiter scores with `getOutcomeScores(aggId, 0)`.
6. **Set a fee floor** for valuable questions, so a re-run costs at least K × `minFee`.
7. **Withdraw or reuse your credit**: refunds and rewards stay in the contract until `withdrawEth()` or your next request.
