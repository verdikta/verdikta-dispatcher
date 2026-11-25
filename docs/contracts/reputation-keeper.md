# ReputationKeeper Contract

The ReputationKeeper is the registry and reputation system for Verdikta arbiters. It holds each arbiter's stake and two scores, checks that arbiters are alive with hash-chain health calls, draws juries for the aggregator, and turns each round's outcomes into points, blocks and bans. This page describes **v2**, a breaking redeploy of v1: every arbiter registers again.

!!! note "Checked against the code"
    Revised on 2026-11-25 against v2's [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) and [`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md) on the `beacon` branch. v2 is not deployed yet, so no v2 address is given: the addresses are set at the v2 deployment. Every number below is a default that the owner can change, given with the function that returns it. "Item n" refers to the numbered design notes in [`TODO.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/TODO.md).

!!! warning "v1"
    The v1 keeper (tag `aggregator-v0.1.0`) is the one deployed today. Its `registerOracle`, `deregisterOracle`, `setOracleActive`, `updateScores`, `selectOracles`, `getOracleInfo`, `approveContract`/`removeContract`, `recordUsedOracles`, `pushEntropy`, `manualBlockOracle`, `resetAllReputations`, the mild/severe thresholds and `slashAmountConfig` do not exist in v2. [`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md) maps each one to its v2 replacement.

## Overview

The ReputationKeeper serves the network by:

- **Registry**: each arbiter is an `(operator, jobId)` pair, registered in 1 to 5 classes
- **Stake and unbonding**: 100 VDKA to register; the stake comes back after an exit and an unbonding period of at least 2 days
- **Two scores**: quality and timeliness, integers from 0 to 1,000, both starting at 500
- **Liveness**: health calls answered with the next value of the arbiter's hash chain; an arbiter that misses one is frozen until it answers (items 6 and 7)
- **Selection**: a reputation- and fee-weighted draw of a jury, reproducible from a seed and the state as of the request block (item 9)
- **Consequences**: a score that reaches 0 blocks the arbiter for a time that doubles with each offense; the third block is a permanent ban (Table 2 of item 14)
- **Access control**: only approved contracts (the aggregator and JuryBeacons) can select arbiters and report outcomes; every ArbiterOperator asks the keeper whether a requester is approved

## Key Features

### Composite Arbiter Identity

An arbiter is identified by its key, `keyOf(oracle, jobId) = keccak256(abi.encodePacked(oracle, jobId))`, so one operator contract can run several jobs. Every function after registration takes the key.

### Checkpointed State

Everything selection reads is stored as a checkpoint by block number: scores, flags, block time, fee and health-call times. Class lists have checkpointed lengths, so a draw sees the state as of the request block B, and nothing that changes after B can shift it.

### Flags

`getArbiter(key).flags` is a bit set:

| Bit | Flag | Meaning |
|-----|------|---------|
| 1 | registered | |
| 2 | paused | Set with `setPaused`. Not selected |
| 4 | banned | Permanent. Not selected or scored, and the key can never register again |
| 8 | exiting | After `requestExit`. Not selected; blocks and bans still apply |
| 16 | call pending | A health call is outstanding |
| 32 | understaked | Stake below the requirement. Not selected |
| 64 | re-sync | The chain was re-synced: frozen until a call sent after the re-sync is answered |

## Contract Interface

### Registration

```solidity
function registerArbiter(
    address oracle,
    bytes32 jobId,
    uint64 fee,
    uint64[] calldata classes,
    bytes32 chainHead
) external
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `oracle` | `address` | The arbiter's ArbiterOperator contract. It must have code and an `owner()` |
| `jobId` | `bytes32` | The Chainlink job on that operator |
| `fee` | `uint64` | Posted fee per request, in wei of ETH as the aggregator reads it. Must be above 0 |
| `classes` | `uint64[]` | 1 to 5 classes. A repeated class is ignored |
| `chainHead` | `bytes32` | Head of the arbiter's hash chain, H^n(seed), with v_{i−1} = keccak256(v_i). Each health answer reveals the next preimage. 0 is allowed, see below |

#### Requirements

- The caller is the keeper's owner or the operator's `owner()`, else `NotArbiterOwner()`.
- The key is not registered, else `AlreadyRegistered()`.
- The caller has approved the keeper for `stakeRequirement()` VDKA (100e18). The keeper pulls it with `transferFrom(msg.sender, ...)`, so the stake comes from the caller, also when the caller is the keeper's owner. A transfer that returns false gives `TransferFailed()`.
- `BadParams()` if the operator has no code or `fee` is 0. `BadClasses()` for 0 or more than 5 classes.

v2 does not check the operator's ERC-165 interface or its keeper list at registration. But the operator must list this keeper (`addReputationKeeper`), or every request to it reverts and the aggregator skips its slots. See [ArbiterOperator](arbiter-operator.md).

**A head of 0** is for registration from a browser, which cannot hold the chain. The arbiter starts frozen in re-sync (flags 16 and 64), and its node's health job sets the chain with its first answer (see [Health Calls](#health-calls)).

**A new key** starts with both scores at `points().start` (500). **A returning key** (after `completeExit`) keeps its scores and offenses, and takes its classes from the new registration. Each class takes a slot freed by an earlier exit before the list grows.

Emits `ArbiterRegistered(key, oracle, jobId, fee)`.

### Arbiter Management

All of these take the key and may be called by the operator's `owner()` or the keeper's owner (else `NotArbiterOwner()`), for a registered key (else `NotRegistered()`).

```solidity
// Pause or resume selection. No event
function setPaused(bytes32 key, bool paused) external

// Change the posted fee (wei of ETH, above 0). No event
function setFee(bytes32 key, uint64 fee) external

// Add stake, pulled from the caller. Re-applies the current stakeRequirement (the understaked flag)
function topUpStake(bytes32 key, uint96 amount) external

// Start unbonding: no longer selected. A second call reverts AlreadyExiting()
function requestExit(bytes32 key) external

// After the unbonding period: refund the remaining stake to the operator's owner and free the slots
function completeExit(bytes32 key) external
```

**Exit.**

- `requestExit` sets `exitAt = now + unbondingPeriod()` (2 days by default, never below `MIN_UNBONDING`, 2 days) and emits `ExitRequested(key, exitAt)`.
- `completeExit` reverts with:
    - `StillBonded()` if no exit was requested or `exitAt` has not passed;
    - `Blocked()` while the arbiter is blocked.
- The stake left after any burns goes to the operator's `owner()`, not to the caller. `ArbiterRemoved(key, refunded)` is emitted.
- The arbiter's slot in each class is freed for the next registration, and `arbiterClasses(key)` becomes empty.
- The arbiter leaves the registry of registered arbiters (`registryLength()` drops by one), so it can no longer win an [arbiter pool](#the-arbiter-pool-draw) payout.
- Both calls also work for a frozen arbiter: a freeze exists to get a broken arbiter fixed or removed.
- A banned key keeps its record (a tombstone) and can never register again.
- `requestExit` and `completeExit` replace v1's `deregisterOracle`, and `setPaused` replaces `setOracleActive`.

Why 2 days: a draw can read a request block up to 1 day old (`MAX_DRAW_AGE`), and that round needs up to another day to finish and settle. So its penalties land before the stake is refunded.

### Health Calls

A health call asks the arbiter to reveal the next value of its hash chain. The keeper sends one to:

- every juror at selection;
- 3 other shortlisted arbiters (`liveRandom()`);
- every beacon candidate;
- any key on request.

The call is the event `HealthCall(key, sentAt)`. An arbiter whose call is older than `callDeadline()` (60 s) and unanswered is **frozen**. A frozen arbiter is not selected, and it is not scored for a round unless it committed in that round. It stays frozen until it answers.

```solidity
// Reveal the next preimage of the head. Ends an outstanding call and unfreezes
function answerHealthCall(bytes32 key, bytes32 preimage) external

// Answer and replace the chain in one transaction, before the current one runs out.
// The answer comes from the old chain; the new head applies to later calls only.
// With newHead == preimage it is exactly answerHealthCall (the node's health job always sends this)
function rotateChain(bytes32 key, bytes32 preimage, bytes32 newHead) external

// Ask for a call: to end a re-sync, or after a restart
function requestHealthCall(bytes32 key) external

// What a node needs, in one eth_call: whether a call is pending, when it was sent, the current head
function healthState(bytes32 key) external view returns (bool pending, uint256 sentAt, bytes32 head)

// Owner: send health calls to many arbiters at once (for example after a wide outage)
function sendHealthCalls(bytes32[] calldata keys) external onlyOwner
```

**Who may answer.** The answer, the rotation and `requestHealthCall` must come from the operator's `owner()` or from an address for which the operator's `isAuthorizedSender(sender)` is true. Otherwise they revert with `NotAuthorizedResponder()`. The arbiter's node answers from its Chainlink node key, which is an authorized sender (item 16; the arbiter's `beacon` branch has the health job in `chainlink-node/healthJobSpec` and the adapter side in `external-adapter/src/health/`).

**A valid answer** is a value whose keccak256 is the current head. It becomes the new head and emits `HealthAnswered(key, answeredAt)`. It ends the pending call, if there is one. It can also be sent with no call pending: the value is then revealed early, and JuryBeacons reads the first value revealed after a block.

**Re-sync.** An answer whose value does not hash to the head does not revert:

- `answerHealthCall(key, v)`, or `rotateChain(key, v, v)`, makes `v` the head, emits `ChainResynced(key)`, sets flags 16 and 64, and freezes the arbiter at once.
- The arbiter stays frozen until it answers a call sent after the re-sync. That call comes from one of:
    - selection;
    - the owner's `sendHealthCalls`;
    - `requestHealthCall(key)`;
    - the arbiter's own first valid answer after the re-sync, which sends it.

    So the health job alone recovers: re-sync, answer (which sends the call), answer (which unfreezes).
- `healthState` reports `pending = true` throughout.
- A rotation to a different head (`newHead != preimage`) still needs a valid preimage, else `BadPreimage()`.
- A re-synced value is never a beacon value. A re-sync is not retroactive: a round that ended before it is judged as it was.
- A node should re-sync onto a fresh chain, never onto one whose values were already revealed, or its beacon values become predictable.

`isFrozen(key)` tells whether the arbiter is frozen now. `revealAfter(key, b)` returns the arbiter's first chain value revealed after block `b`, with its block, time and operator, or zeros. JuryBeacons uses it with `b` = B+1.

### Selection (approved contracts only)

```solidity
struct SelectParams {
    uint256 count;                     // jury size K
    uint256 alpha;                     // 0..1000: weight of timeliness against quality
    uint256 maxFee;                    // fee ceiling (wei): arbiters above it are not eligible
    uint256 minFee;                    // the round's fee floor (wei)
    uint256 estimatedBaseCost;         // below maxFee
    uint256 maxFeeBasedScalingFactor;  // at least 1
    uint64 requestedClass;
}

struct Selected { address oracle; bytes32 key; uint256 fee; }   // fee: posted fee as of atBlock

function selectArbiters(SelectParams calldata sp, bytes32 seed, uint256 atBlock, uint256 atTime)
    external returns (Selected[] memory)

function pickBeacons(bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint256 count)
    external returns (bytes32[] memory keys)
```

Both revert with `NotApproved()` for a caller that `setApproved` has not approved, `FutureBlock()` if `atBlock` is not in the past, and `StaleBlock()` if `atTime` is more than `MAX_DRAW_AGE` (1 day) old. `selectArbiters` also reverts with `BadParams()` (alpha above 1,000, count 0, base cost not below `maxFee`, scaling factor 0) and `NoEligibleArbiters()`.

#### Selection Algorithm

1. **Eligible** as of `atBlock`, at time `atTime`:
    - registered, and not paused, banned, exiting or understaked;
    - not blocked and not frozen;
    - posted fee at most `maxFee`.
2. **Walk**: the class list as of `atBlock` is visited in a random order derived from the seed, without repeats. The walk stops when the shortlist is full (`shortlistSize()`, 60) or after `maxScan()` (400) entries. After 2 × min(n, `maxScan`) random draws it finishes with a sweep over the entries not yet visited, so it can reach every entry. Where an arbiter sits in the list does not matter. `scansAll(cls)` is true when the list is no longer than `maxScan`.
3. **Weight** of each shortlisted arbiter:

    ```
    rep    = ((1000 - alpha) × quality + alpha × timeliness) / 1000        0..cap
    w      = 1000 + rep × 1000 / cap                                       1000..2000
    fee'   = max(posted fee, minFee)
    ratio  = (maxFee - baseCost) / (fee' - baseCost)   if fee' > baseCost
           = maxFeeBasedScalingFactor                  otherwise
    ratio  = min(ratio, maxFeeBasedScalingFactor)
    weight = w × ratio                                 if ratio > 1, else w
    ```

    Below the floor every arbiter costs the requester the same, so a near-zero posted fee gains no weight (item 8).
4. **Draw**: `count` weighted picks without replacement, each from `keccak256(seed, k)`. **Repeats**: when the shortlist holds m < `count` arbiters, slot k holds pick k mod m. That happens when fewer than `count` are eligible, when `shortlistSize` is below `count` (it is read at selection, so lowering it after a request applies to that request's draw), and when the walk stops at `maxScan` entries before it has found `count` eligible ones though the class holds more. One operator can then hold several slots, or every slot; each slot is paid, committed, revealed and scored separately. `NoEligibleArbiters()` fires only when the walk finds none.
5. **Health calls** go to every juror and to `liveRandom()` (3) other shortlisted arbiters.

`pickBeacons` uses the same walk and eligibility rules, without the fee test, and returns up to `count` keys, each sent a health call.

### The arbiter pool draw

```solidity
// A registered arbiter picked uniformly from seed, returned as its payee (its operator's owner()),
// or address(0) if neither of two picks is available
function poolPayee(bytes32 seed) external view returns (address)

// Registered arbiters (exited ones are removed; banned ones stay until they complete their exit)
function registryLength() external view returns (uint256)
```

The keeper keeps a registry of every registered arbiter: `registerArbiter` adds the key and `completeExit` removes it. The aggregator calls `poolPayee` at each draw that draws a jury, with a seed derived from that draw's seed, to pay an eighth of its arbiter pool, at most that draw's base fees (the forfeits that earlier v2 drafts sent to a treasury; see [ReputationAggregator](reputation-aggregator.md#the-arbiter-pool)). `poolPayee` makes at most two picks and returns the first arbiter that is registered and not paused, banned, exiting or understaked; otherwise address(0), and the pool waits for the next draw. Anyone may call it. The aggregator caps the call at 80,000 gas and catches its failure, so an operator's `owner()` cannot make the draw fail.

### Outcomes (approved contracts only)

```solidity
// One round's outcomes, one code per slot; roundEnd = the round's deadline
function applyOutcomes(bytes32[] calldata keys, uint8[] calldata codes, uint256 roundEnd) external
```

- A code's low nibble is the timeliness event, bits 4 and 5 the quality class, and bit 7 (`C_COMMITTED`, `0x80`) means the arbiter committed in the round.
- These codes are skipped:
    - code 0;
    - keys that are not registered, or are banned;
    - arbiters frozen at `roundEnd` that did not commit, with `OutcomeSkippedFrozen(key)`. Being down is handled by the freeze, never by points, and a commit proves the arbiter was up.
- `BadParams()` if the arrays differ in length.

### Information Queries

```solidity
struct ArbiterView {
    address oracle;
    uint256 quality;         // 0..cap
    uint256 timeliness;      // 0..cap
    uint256 offenses;
    uint256 flags;           // see Flags
    uint256 blockedUntil;    // timestamp
    uint256 fee;             // posted fee (wei of ETH)
    uint256 callSentAt;
    uint256 callAnsweredAt;
    uint256 stake;           // VDKA wei
    uint256 checkpoints;     // number of state checkpoints
    uint256 exitAt;          // when completeExit is allowed (0 = not exiting)
}

function getArbiter(bytes32 key) external view returns (ArbiterView memory)
function keyOf(address oracle, bytes32 jobId) external pure returns (bytes32)
function jobIdOf(bytes32 key) external view returns (bytes32)
function arbiterClasses(bytes32 key) external view returns (uint64[] memory)
function isFrozen(bytes32 key) external view returns (bool)
function isEligible(bytes32 key, uint256 maxFee) external view returns (bool)          // now
function eligibleCount(uint64 cls, uint256 maxFee) external view returns (uint256)    // off-chain view
function classSize(uint64 cls) external view returns (uint256)       // list slots, freed ones included
function freeSlotCount(uint64 cls) external view returns (uint256)
function slotIn(bytes32 key, uint64 cls) external view returns (uint256)   // slot index + 1, 0 = none
function scansAll(uint64 cls) external view returns (bool)                 // classSize <= maxScan
function revealAfter(bytes32 key, uint256 b)
    external view returns (bytes32 value, uint256 blk, uint256 at, address oracle)
function isContractApproved(address c) external view returns (bool)        // = approvedContracts(c)
function approvedContracts(address c) external view returns (bool)
function verdiktaToken() external view returns (address)                   // immutable
```

The settings in [Configuration Parameters](#configuration-parameters) have getters of the same name. The outcome constants are public as well:

- `T_NONE` 0, `T_DELIVERED` 1, `T_MISS_FINISHED` 2, `T_MISS_FAILED` 3, `T_NOCOMMIT_FAILED` 4;
- `C_COMMITTED` 0x80;
- `Q_NONE` 0, `Q_CLOSE` 1, `Q_OFF` 2, `Q_FAR` 3.

v1's `registeredOracles`/`getOracleInfo`/`getOracleClasses` have no list equivalent (`registryLength()` gives only the count). Follow the `ArbiterRegistered` events, then read `getArbiter(key)` and `arbiterClasses(key)`.

### Contract Approval and Configuration (Owner Only)

```solidity
// Approve a contract to select arbiters, pick beacons and report outcomes. The deployment approves
// the aggregator and JuryBeacons. Every ArbiterOperator that lists this keeper accepts requests
// from approved contracts
function setApproved(address aggregator, bool ok) external onlyOwner

// Table 1 point values; reverts BadParams() if cap == 0, start == 0 or start > cap
function setPoints(Points calldata p) external onlyOwner

// Block duration (s), decay period (s, not 0), health-call deadline (s), unbonding (s, at least
// MIN_UNBONDING); else BadParams(). The unbonding period applies to exits requested afterwards
function setTiming(uint40 lock, uint40 decay, uint40 deadline, uint40 unbonding) external onlyOwner

// Offenses to a ban (1..16), burn per block (VDKA wei, doubled per earlier offense), burn the
// whole stake on a ban; else BadParams()
function setPenalties(uint8 _maxOffenses, uint96 _burnPerBlock, bool _burnOnBan) external onlyOwner

// Shortlist size (not 0), walk bound (at least the shortlist), extra random health calls; else BadParams()
function setSelection(uint16 _shortlist, uint16 _maxScan, uint8 _liveRandom) external onlyOwner

// Applies to new registrations, and to an existing arbiter at its next stake change
function setStakeRequirement(uint256 s) external onlyOwner
```

Approval matters beyond the operator gate: an approved contract can draw juries and change any arbiter's scores through `applyOutcomes`. Approve only contracts you trust. `isContractApproved` keeps v1's name because every deployed ArbiterOperator calls it, and checks that it exists when the keeper is added. The aggregator's `requestAIEvaluationWithApproval` reads `shortlistSize()` to bound K.

## Data Structures

### Points

```solidity
struct Points {
    uint16 gain;      // 20:  delivered (timeliness), close (quality)
    uint16 minor;     // 50:  off (quality)
    uint16 major;     // 200: far (quality); promoted miss in a finished round (timeliness)
    uint16 fail;      // 500: promoted, no reveal, round failed (timeliness)
    uint16 nocommit;  // 400: no commit, round failed for lack of commits (timeliness)
    uint16 start;     // 500: starting score, and the restart after a block
    uint16 cap;       // 1000: highest score
}
```

## Events

```solidity
event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee);
event ArbiterRemoved(bytes32 indexed key, uint256 refunded);
event ExitRequested(bytes32 indexed key, uint256 exitAt);
event HealthCall(bytes32 indexed key, uint256 sentAt);
event HealthAnswered(bytes32 indexed key, uint256 answeredAt);
event ChainResynced(bytes32 indexed key);
event ScoresUpdated(bytes32 indexed key, uint256 quality, uint256 timeliness);
event ArbiterBlocked(bytes32 indexed key, uint256 until, uint256 offenses, uint256 burned);
event ArbiterBanned(bytes32 indexed key, uint256 burned);
event OutcomeSkippedFrozen(bytes32 indexed key);
event ContractApproval(address indexed aggregator, bool approved);
```

`setPaused`, `setFee` and `topUpStake` emit no event. The [Events Reference](../api/events.md) gives each event's fields and when it fires.

## Usage Examples

### Arbiter Registration

The caller must be the operator's owner (or the keeper's owner), and it pays the stake. This contract is meant to be the operator's owner.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IReputationKeeper {
    function stakeRequirement() external view returns (uint256);
    function keyOf(address oracle, bytes32 jobId) external pure returns (bytes32);
    function registerArbiter(address oracle, bytes32 jobId, uint64 fee, uint64[] calldata classes, bytes32 chainHead) external;
    function setFee(bytes32 key, uint64 fee) external;
    function requestExit(bytes32 key) external;
    function completeExit(bytes32 key) external;
}

contract ArbiterManager {
    IReputationKeeper public immutable keeper;
    IERC20 public immutable verdiktaToken;
    address public immutable admin;

    constructor(address _keeper, address _token) {
        keeper = IReputationKeeper(_keeper);
        verdiktaToken = IERC20(_token);
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    // This contract must hold stakeRequirement() VDKA. chainHead is the head of the node's
    // hash chain, or 0 to let the node's health job set it (the arbiter starts frozen)
    function register(address operator, bytes32 jobId, uint64 feeWei, uint64[] calldata classes, bytes32 chainHead)
        external onlyAdmin returns (bytes32 key)
    {
        verdiktaToken.approve(address(keeper), keeper.stakeRequirement());
        keeper.registerArbiter(operator, jobId, feeWei, classes, chainHead);
        key = keeper.keyOf(operator, jobId);
    }

    // v2 changes the fee in place: no re-registration
    function updateFee(bytes32 key, uint64 feeWei) external onlyAdmin {
        keeper.setFee(key, feeWei);
    }

    // Two steps: requestExit now, completeExit after the unbonding period (getArbiter(key).exitAt).
    // The refund goes to the operator's owner
    function startExit(bytes32 key) external onlyAdmin {
        keeper.requestExit(key);
    }

    function finishExit(bytes32 key) external onlyAdmin {
        keeper.completeExit(key);
    }
}
```

In practice arbiters register from a script or a browser, not from a contract. The node generates the chain (seed `s`, v_{i−1} = keccak256(v_i)) and registers the head, or registers with head 0 and lets its health job re-sync.

### Frontend Queries

```javascript
import { ethers } from 'ethers';

const REPUTATION_KEEPER_ABI = [
    'function keyOf(address oracle, bytes32 jobId) pure returns (bytes32)',
    'function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints, uint256 exitAt))',
    'function arbiterClasses(bytes32 key) view returns (uint64[])',
    'function isFrozen(bytes32 key) view returns (bool)',
    'function healthState(bytes32 key) view returns (bool pending, uint256 sentAt, bytes32 head)',
    'function eligibleCount(uint64 cls, uint256 maxFee) view returns (uint256)',
    'event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee)',
    'event ScoresUpdated(bytes32 indexed key, uint256 quality, uint256 timeliness)'
];

const FLAGS = { registered: 1, paused: 2, banned: 4, exiting: 8, callPending: 16, understaked: 32, resync: 64 };

class ReputationManager {
    constructor(contractAddress, provider) {
        this.contract = new ethers.Contract(contractAddress, REPUTATION_KEEPER_ABI, provider);
    }

    async getArbiterDetails(operator, jobId) {
        const key = await this.contract.keyOf(operator, jobId);
        const a = await this.contract.getArbiter(key);
        const flags = Number(a.flags);
        return {
            key,
            quality: Number(a.quality),
            timeliness: Number(a.timeliness),
            offenses: Number(a.offenses),
            fee: ethers.formatEther(a.fee),               // ETH
            stake: ethers.formatEther(a.stake),           // VDKA
            blockedUntil: new Date(Number(a.blockedUntil) * 1000),
            exitAt: a.exitAt === 0n ? null : new Date(Number(a.exitAt) * 1000),
            frozen: await this.contract.isFrozen(key),
            classes: (await this.contract.arbiterClasses(key)).map(Number),
            flags: Object.fromEntries(Object.entries(FLAGS).map(([n, b]) => [n, (flags & b) !== 0]))
        };
    }

    // Every arbiter ever registered: the keeper keeps no list, so follow the events
    async listKeys(fromBlock = 0) {
        const logs = await this.contract.queryFilter(this.contract.filters.ArbiterRegistered(), fromBlock);
        return [...new Set(logs.map(l => l.args.key))];
    }

    monitorScores(key, onUpdate) {
        const filter = this.contract.filters.ScoresUpdated(key);
        this.contract.on(filter, (event) => {
            const [, quality, timeliness] = event.args;
            onUpdate({ quality: Number(quality), timeliness: Number(timeliness), block: event.log.blockNumber });
        });
        return () => this.contract.off(filter);
    }
}
```

## Reputation System

### Reputation Points

At settlement the aggregator sends one code per jury slot (see [ReputationAggregator: Settlement](reputation-aggregator.md#settlement)). The keeper applies them with the current `points()`:

| Event | Timeliness | Quality |
|-------|------------|---------|
| Promoted, revealed (also late) | +20 (`gain`) | by class, if the round finished |
| Promoted, no reveal, round finished | −200 (`major`) | |
| Promoted, no reveal, round failed | −500 (`fail`) | |
| No commit, round failed for lack of commits | −400 (`nocommit`) | |
| Quality class close (d ≤ 1.5 × spread) | | +20 (`gain`) |
| Quality class off (d ≤ 3 × spread) | | −50 (`minor`) |
| Quality class far | | −200 (`major`) |

Scores are capped at `cap` (1,000). An arbiter that was not promoted, or whose round failed in the commit phase with M commits, or in the promotion step, gets no points.

### Consequences (Table 2)

- **Block.** A score that reaches 0 restarts at `start` (500) and blocks the arbiter for `lockDuration() × 2^offenses`. That is 24 h, then 48 h, and so on. A hit while the arbiter is already blocked (several in-flight rounds settling together) restarts the score but adds no offense and no burn. `ArbiterBlocked(key, until, offenses, burned)`.
- **Burn.** Each block burns `burnPerBlock() × 2^offenses` VDKA (default 0) from the stake. The burn uses the token's `burn`, or a transfer to `0x…dEaD` if the token has no `burn`. A stake that falls below the requirement makes the arbiter understaked until it tops up.
- **Decay.** One offense is forgiven per `decayPeriod()` (90 days) without a block, counted from the end of the last block.
- **Ban.** The `maxOffenses()`-th block (3) is a permanent ban (`ArbiterBanned(key, burned)`). The whole stake is burned on a ban only if `burnOnBan()` is set (default off). A banned arbiter can still exit, once its last block has ended, and collect what is left of its stake.

## Configuration Parameters

| Parameter | Default | Description | Set with |
|-----------|---------|-------------|----------|
| `stakeRequirement` | 100 VDKA (100e18) | Stake pulled at registration | `setStakeRequirement` |
| `points` | 20, 50, 200, 500, 400, 500, 1000 | `gain`, `minor`, `major`, `fail`, `nocommit`, `start`, `cap` | `setPoints` |
| `lockDuration` | 24 hours | First block; doubles per offense | `setTiming` |
| `decayPeriod` | 90 days | Clean time that forgives one offense | `setTiming` |
| `callDeadline` | 60 s | Time to answer a health call before freezing | `setTiming` |
| `unbondingPeriod` | 2 days | From `requestExit` to `completeExit` | `setTiming` (at least `MIN_UNBONDING`) |
| `MIN_UNBONDING` | 2 days | Constant | |
| `MAX_DRAW_AGE` | 1 day | Constant: oldest request block a selection may read | |
| `maxOffenses` | 3 | The block that bans | `setPenalties` |
| `burnPerBlock` | 0 | VDKA wei burned per block, doubled per earlier offense | `setPenalties` |
| `burnOnBan` | false | Burn the whole stake on a ban | `setPenalties` |
| `shortlistSize` | 60 | Most arbiters weighed per selection; also bounds a request's K | `setSelection` |
| `maxScan` | 400 | Most list entries visited per selection | `setSelection` |
| `liveRandom` | 3 | Extra random health calls per selection | `setSelection` |

## Security Considerations

### Access Control

- Only the operator's owner or the keeper's owner can register, pause, set the fee, top up or exit an arbiter.
- Only the operator's owner or an authorized sender of the operator can answer health calls or rotate the chain.
- Only approved contracts can select arbiters, pick beacons and report outcomes. Only the keeper's owner approves.

### Economic Security

- Burns and bans put the stake at risk. Unbonding keeps the stake in place until every round that could have used the arbiter has settled.
- A block's duration doubles with each offense, and offenses decay only with clean time.

### Selection Fairness

- **No steering**: the seed is fixed after the request (item 9), and selection reads only the state as of block B. Nothing done between B and the draw (a top-up, a fee change, an exit, a new registration) changes the jury.
- **Position-free**: the walk visits the class list in random order, so a cartel that registers back to back is drawn no more often than any other set of arbiters.
- **Fee weighting uses the price paid**: below the round's floor all fees score alike.
- **Liveness**: every juror gets a health call, so an arbiter that is down is frozen within a minute and left out of later draws.

## Best Practices

### For Arbiter Operators

1. **Run the health job**: answer health calls within 60 s, or the arbiter is frozen and earns nothing. Rotate the chain with `rotateChain` before it runs out.
2. **Add the keeper to your operator**: `addReputationKeeper(<v2 keeper>)`, or every dispatch to you reverts.
3. **Exit in two steps**: `requestExit`, then `completeExit` after `getArbiter(key).exitAt`. A returning arbiter registers its classes again.
4. **Price for the floor**: a fee below a round's floor gains no weight there.

### For Contract Developers

1. **Read the key**: everything is keyed by `keyOf(operator, jobId)`.
2. **Use events for lists**: `ArbiterRegistered`, `ArbiterRemoved`, `ScoresUpdated`.
3. **Check eligibility with `isEligible` and `eligibleCount`**: they read the current state. A draw reads the state at its request block.

### For System Administrators

1. **Approve carefully**: an approved contract can change every arbiter's scores.
2. **Keep `shortlistSize` at or above the aggregator's `maxJury`**: a request's K must fit both.
3. **Watch `OutcomeSkippedFrozen` and `ChainResynced`**: many at once point to a node-side problem.
