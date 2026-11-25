# JuryBeacons Contract

JuryBeacons adds optional beacon randomness to the aggregator's jury draw (TODO item 9's beacon flag). For a request made with `withBeacons = true`, a few arbiters of the request's class act as beacons. Each reveals the next value of its hash chain, and the aggregator draws the jury with a seed that mixes in the first values to arrive. The contract is new in **v2**. It is kept out of the aggregator to save the aggregator's bytecode.

!!! note "Checked against the code"
    Written on 2026-11-25 against v2's [`JuryBeacons.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/JuryBeacons.sol), the beacon stage of [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol) and the keeper's `pickBeacons` and `revealAfter` in [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol), on the `beacon` branch. v2 is not deployed yet: the address is set at the v2 deployment. The numbers below are defaults that the owner can change with `setParams`.

## Overview

Without beacons, the jury seed is `keccak256(aggId, blockhash(B+1))`, where B is the request block. The builder of block B+1 could in principle choose among block hashes. With beacons, the seed is `keccak256(aggId, blockhash(B+1), mix)`, where `mix` comes from values that the beacon arbiters fixed before B+1 and reveal after it. The class presets turn beacons on for Jumbo rounds only.

A beacon round goes like this:

1. **Start.** The first `drawJury(aggId)` on the aggregator, from block B+2, calls `start` here.
    - The keeper picks `polled` beacons (4) from the request's class with the seed `keccak256(aggId, "beacons", blockhash(B+1))`.
    - The pick reads only the keeper's state as of B. It uses the selection walk, and takes arbiters that are registered and not paused, banned, exiting, understaked, blocked or frozen.
    - The keeper sends each beacon a health call (`HealthCall`), and this contract emits `BeaconCalled` for each one.
    - The round moves to phase 2 (beacons), and the aggregator emits `BeaconStageStarted(aggId, picked)`.
2. **Answer.** A beacon answers its health call like any arbiter, with `answerHealthCall` or `rotateChain` on the keeper. Its **beacon value** is its first chain value revealed after block B+1 (`keeper.revealAfter(key, B+1)`). That is normally its answer to the beacon call, or its answer to an earlier call if it answered one after B+1. The value is the preimage of its head as of B+1, so it was fixed before the pick was known, and only its timing is the beacon's choice. Beacon nodes need no extra code.
3. **Ready or expired.** The stage is **ready** once `quorum` values (2) have been revealed by the deadline (`timeout`, 120 s after the start). The first `quorum` reveals count, ordered by block, ties by beacon index. The stage is **expired** if the deadline passes with fewer.
4. **Draw.** A second `drawJury(aggId)` reads `result`:
    - while the stage is pending, the call reverts with `TooEarly()`;
    - each used value's operator owner is paid one juror fee, `max(eff, minFee)` (`BeaconPayment`). On expiry the beacons that answered are paid too;
    - if ready, the jury is drawn with the mixed seed. The requester's 30 s draw priority runs from `readyAt`, when the quorum-th value arrived;
    - if expired, the round ends with no result (phase 8, `EvaluationFailed(aggId, 2)`), and the unspent prepay goes to the treasury, since a refund would be a free re-roll.

If the keeper finds fewer candidates than the quorum, `start` returns the count without starting the stage. The aggregator then fails the round at the first call and refunds the requester (`EvaluationFailed(aggId, 1)`).

### Why it resists steering

- The pick depends only on blockhash(B+1) and the state as of B. Each value is the next one after the head at the end of B+1, so it was fixed before anyone but the builder of B+1 knew the pick. A later chain rotation cannot change it, since a rotation reveals that value first.
- So a beacon can only choose when to reveal, or not to.
- Only the arbiter can answer: its operator's owner, or an authorized sender of its operator. The reveal times are the beacons' own.
- `result` reads only reveals in completed blocks (`blk < block.number`), so the order of transactions within a block cannot change it. Once ready, it is final.
- Values are mixed in beacon-index order, so arrival decides only which values are used, not their order.
- A re-synced value is never a beacon value (the keeper's `revealAfter` takes only a value that hashes to the head before it). A beacon that re-syncs after B+1 counts as having withheld.

A cartel holding beacon seats can still choose among a few seeds by when it reveals, and it can force a no-result round by withholding (item 9, "What it buys and costs"). Withholding is cheap: a beacon that answers just after the deadline is frozen only from the 60 s call deadline until then, and its value does not count.

## Contract Interface

### Aggregator Calls

```solidity
// Start the beacon stage for one request (approved aggregators only, once per aggId).
// Picks max(polled, quorum_) beacons through the keeper. Returns the number picked; with fewer than
// quorum_ the stage is not started and the caller should fail the round
function start(bytes32 aggId, bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint8 quorum_)
    external returns (uint256 picked)
```

| Parameter | Description |
|-----------|-------------|
| `aggId` | The aggregator's round id |
| `seed` | Entropy for the pick; the aggregator passes `keccak256(aggId, "beacons", blockhash(B+1))` |
| `cls` | The request's class |
| `atBlock`, `atTime` | The request block B and its timestamp: the pick reads the state as of then |
| `quorum_` | The values the aggregator escrowed for, fixed at the request |

Reverts with `NotApproved()` for a caller that `setApproved` has not approved, and with `AlreadyStarted()` for a second start of the same `aggId` by the same aggregator. The keeper's `pickBeacons` reverts with `NotApproved()` if the keeper has not approved this contract, with `FutureBlock()` and with `StaleBlock()`. These errors revert the aggregator's `drawJury`.

### Views

```solidity
// The stage's state for aggregator's request
function result(address aggregator, bytes32 aggId)
    external view returns (uint8 state, bytes32 mix, uint256 readyAt, address[] memory payees)

// The request's beacons, the request block B, and the deadline
function getBeacons(address aggregator, bytes32 aggId)
    external view returns (bytes32[] memory keys, uint256 atBlock, uint256 deadline)

function keeper() external view returns (address)                 // immutable
function approved(address aggregator) external view returns (bool)
function polled() external view returns (uint8)                   // 4
function quorum() external view returns (uint8)                   // 2
function timeout() external view returns (uint40)                 // 120 s
```

`result` returns:

| Field | Meaning |
|-------|---------|
| `state` | `ST_NONE` 0 (not started), `ST_PENDING` 1, `ST_READY` 2, `ST_EXPIRED` 3 |
| `mix` | When ready: `keccak256` chained over the used values in beacon-index order (`mix = keccak256(mix, value)`, from 0) |
| `readyAt` | When ready: when the quorum-th used value was revealed, and never before the start |
| `payees` | When ready or expired: the operator owners of the used values. An owner that cannot be read within a 30,000-gas stipend is left out, and that beacon goes unpaid |

`result` reverts with `OutOfGas()` if the call has too little gas left to read the owners with the stipend, so a caller's gas limit cannot skip the payments.

### Owner Functions

```solidity
// Approve an aggregator to start beacon stages
function setApproved(address aggregator, bool ok) external onlyOwner

// polled (quorum..16), quorum (at least 1), timeout (s, not 0); else InvalidConfig()
function setParams(uint8 polled_, uint8 quorum_, uint40 timeout_) external onlyOwner
```

The aggregator reads `quorum()` when a request is made. The request's prepay covers that many beacon payments, and the round keeps that quorum even if the owner changes it later. `polled` is read when the stage starts, and is never below the round's quorum. `timeout` is read when the stage starts.

### Deployment

[`deploy/02_keeper.js`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/deploy/02_keeper.js) deploys JuryBeacons with the keeper's address and wires the three contracts:

- the keeper approves JuryBeacons (`setApproved`), so it can call `pickBeacons`;
- JuryBeacons approves the aggregator;
- the aggregator's `setContracts(keeper, beacons, treasury)` sets it. A zero `beacons` address turns beacons off, and a request with `withBeacons = true` then reverts.

## Events

```solidity
// One per picked beacon when a stage starts
event BeaconCalled(address indexed aggregator, bytes32 indexed aggId, uint256 index, bytes32 indexed key, uint256 deadline);

// setApproved
event Approval(address indexed aggregator, bool ok);
```

The keeper's `HealthCall(key, sentAt)` is the call the beacon node answers; `BeaconCalled` is for information. The aggregator's side of the stage emits `BeaconStageStarted`, `BeaconPayment` and, on expiry, `EvaluationFailed(aggId, 2)`. See the [Events Reference](../api/events.md).

## Errors

| Error | Trigger |
|-------|---------|
| `NotApproved()` | `start` from an address that is not approved |
| `AlreadyStarted()` | A second `start` for the same aggregator and `aggId` |
| `InvalidConfig()` | `setParams` with `quorum_ == 0`, `polled_ < quorum_`, `polled_ > 16` or `timeout_ == 0` |
| `OutOfGas()` | `result` without enough gas to read the payees' owners with the stipend |

## Cost

- The beacon payments are in the prepay: `maxTotalFee(..., withBeacons = true, K, P)` adds `quorum × max(eff, minFee)`.
- Each used value is paid `max(eff, minFee)`, and only used values are paid: at most the quorum.
- A beacon whose value arrives after the first `quorum`, or after the deadline, is not paid.
- Gas: starting the stage costs the requester about 0.39M gas, and a beacon's answer is an ordinary health answer (about 123k), according to the measurements in the aggregator's [`README.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/README.md).

## For Arbiter Operators

- No extra code is needed: a beacon call is a keeper `HealthCall`, and the health job's answer is the beacon value.
- Answer promptly. Only the first `quorum` values within 120 s of the start are used and paid, and a node that misses the 60 s call deadline is also frozen until it answers.
- Never reuse a chain whose values were already revealed: that would make the beacon values predictable. When re-syncing, re-sync onto a fresh chain.
