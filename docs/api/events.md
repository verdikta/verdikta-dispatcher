# Events Reference

Complete reference for all events emitted by Verdikta Dispatcher contracts. Events are grouped by contract and listed in the order they typically fire during a round.

!!! note "Checked against the code"
    Regenerated on 2026-11-25 for **v2** from the event declarations and `emit` sites in [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol), [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) and [`JuryBeacons.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/JuryBeacons.sol) on the `beacon` branch. v2 is not deployed yet. Every amount in the aggregator's events is in wei of ETH, and payments are credits in the contract's `ethOwed` ledger that the payee collects with `withdrawEth()`. In every aggregator event, `aggRequestId` is the round's `aggId`, `bytes32(roundId)`, and `pollIndex` is the jury slot, 0 to K − 1.

!!! warning "v1 events"
    The v1 aggregator and keeper (tag `aggregator-v0.1.0`, deployed today) emit different events. These v1 events do not exist in v2:

    - aggregator: `OracleSelected`, `RevealRequestDispatched`, `NewOracleResponseRecorded`, `EvaluationTimedOut`, the reveal diagnostics (`RevealHashMismatch`, `InvalidRevealFormat`, `RevealTooManyScores`, `RevealWrongScoreCount`, `RevealTooFewScores`, `RevealCidTooLong`), `ReputationKeeperChanged`, `ScoreDeltasUpdated` and `OracleScoreUpdateSkipped`;
    - keeper: `OracleRegistered`, `OracleDeregistered`, `ScoreUpdated`, `OracleSlashed`, `ContractApproved`/`ContractRemoved`, `OracleActiveStatusUpdated` and `EntropyPushed`.

    In v2, `CommitReceived` carries a `bytes32` hash and no operator, `CommitPhaseComplete` carries the number promoted, `BonusPayment` is indexed by round, and `EvaluationFailed` carries a phase number instead of a string.

## ReputationAggregator Events

### RequestFunded

```solidity
event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | The round |
| `requester` | `address` | Yes | The caller of `requestAIEvaluationWithApproval()` |
| `fromCredit` | `uint256` | No | ETH taken from the requester's `ethOwed` credit: what `msg.value` did not cover |
| `fromValue` | `uint256` | No | `msg.value`. Anything above the prepay was added to the requester's credit |

**When it fires:** Once per request, just before `RequestAIEvaluation`. The prepay held for the round is `fromCredit + fromValue` less any excess, which is `received` in `getRoundInfo`.

### RequestAIEvaluation

```solidity
event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | The round: `bytes32(roundId)`, sequential from 1 |
| `cids` | `string[]` | No | The request's CIDs |

**When it fires:** Once per request, last in the request transaction. No arbiter is chosen yet: the jury is drawn later by `drawJury`.

### SeedSealed

```solidity
event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash);
```

**When it fires:** When blockhash(B+1) is stored: by `sealSeed`, or by the first `drawJury` if the seed was not sealed yet. `blockHash` is that hash.

### BeaconStageStarted

```solidity
event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons);
```

**When it fires:** At the first `drawJury` of a round requested with beacons, when the keeper found at least the quorum of beacon candidates. `beacons` is the number picked. The round is then in phase 2. JuryBeacons emits a `BeaconCalled` per beacon in the same transaction.

### BeaconPayment

```solidity
event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `payee` | `address` | Yes | The beacon's operator `owner()` |
| `amount` | `uint256` | No | `max(eff, minFee)`, credited to `ethOwed[payee]` |

**When it fires:** At the second `drawJury` of a beacon round, once per used beacon value, whether the stage was ready or expired. Up to the quorum (2).

### BasePayment

```solidity
event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `pollIndex` | `uint256` | No | The jury slot |
| `payee` | `address` | Yes | The operator's `owner()`, read at the draw |
| `amount` | `uint256` | No | The slot's fee: `max(posted fee as of B, minFee)` |

**When it fires:** In the draw transaction, once per slot whose commit request was dispatched. A slot that could not be dispatched gets `SlotSkipped` instead and is not paid. A repeated arbiter is paid once per slot.

### JuryDrawn

```solidity
event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `drawer` | `address` | Yes | The caller of `drawJury` |
| `reward` | `uint256` | No | `eff × drawRewardFees()` credited to the drawer, or 0: a third party that draws within `requesterDrawPriority()` (30 s) earns nothing |

**When it fires:** Last in the transaction that draws the jury, after the `BasePayment`s and any `PoolPayment`. The round is then in phase 3, and its deadline is the draw time plus the jury's timeout.

### PoolPayment

```solidity
event PoolPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | The round whose draw paid it (not the round the forfeit came from) |
| `payee` | `address` | Yes | The winning arbiter's operator `owner()` |
| `amount` | `uint256` | No | An eighth of the arbiter pool, `ethOwed(address(0)) / 8`, at most the draw's base fees, credited to `ethOwed[payee]` |

**When it fires:** In a `drawJury` that draws a jury, just before `JuryDrawn`, when the pool holds at least 8 wei and the keeper's `poolPayee(seed)` found an available registered arbiter in its two picks. Declared in `AggregatorLib` and emitted in the aggregator's context, so it appears in the aggregator's logs and ABI. No event fires when nobody was picked: the pool waits for the next draw.

### CommitReceived

```solidity
event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash);
```

**When it fires:** For each accepted commit: in phase 3, before the deadline, a non-zero hash, the slot's first. `commitHash` is `keccak256(abi.encode(aggId, operator, response, salt))`. A rejected commit emits nothing.

### CommitWindowClosed

```solidity
event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock);
```

**When it fires:** When the commit phase closes: at the M+-th commit, at a commit after T+ with at least M in, or through `closeCommits`. `closeBlock` is C. `promote` is possible from block C+2. The round is then in phase 4.

### CommitPhaseComplete

```solidity
event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted);
```

**When it fires:** In `promote`, after the reveal requests have been sent to the M promoted slots. `promoted` is M. The round is then in phase 5. A reveal request that could not be sent gets `SlotSkipped` with reason 3. The promote reward is not in any event.

### RevealReceived

```solidity
event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `pollIndex` | `uint256` | No | The slot |
| `late` | `bool` | No | `false`: a counted reveal (phase 5). `true`: a late reveal after finalization (phase 6), which is scored but does not change the result |
| `qcode` | `uint8` | No | For a late reveal, its quality class (1 close, 2 off, 3 far). 0 for a counted reveal: its class is set at finalization |

**When it fires:** For each valid reveal before the deadline. A bad reveal is ignored and emits nothing.

### BonusPayment

```solidity
event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
```

**When it fires:** At finalization (the N-th counted reveal), once per clustered slot (P of them) with a non-zero bonus. `amount` is `bonusMultiplier × the slot's fee`.

### RequesterRefunded

```solidity
event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `requester` | `address` | Yes | Who was credited: the requester, **or address(0), the arbiter pool**, for a round whose refund would be a free re-roll |
| `amount` | `uint256` | No | The unspent prepay: received minus base fees, bonuses and rewards |

**When it fires:** Only when `amount > 0`, at:

- finalization (to the requester);
- a failed draw: no eligible arbiter or a beacon pool shortage (to the requester), or a failure after a beacon stage when the walk does not cover the class list (to the pool);
- a missed beacon quorum (to the pool);
- the settlement of a failed round: to the requester, except when M commits were in but the round was never promoted. Then the committers share the unspent prepay (`CommitPayment`), and only the indivisible remainder, less than one wei per committer, is credited to the pool (and the event fires only if it is not zero).

A cancelled round emits `RoundCancelled` instead.

### CommitPayment

```solidity
event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `payee` | `address` | Yes | The slot's payee, its operator's `owner()` read at the draw |
| `amount` | `uint256` | No | The slot's equal share: the unspent prepay divided by the round's commits, credited to `ethOwed[payee]` |

**When it fires:** At the settlement of a round that had at least M commits but was never promoted (phase 4, or phase 3 with at least M commits at the deadline), once per slot that committed, after `EvaluationFailed(3 | 4)`. A repeated arbiter is paid once per committed slot. The shares are counted in the round's `rewards` (`getRoundInfo`).

### FulfillAIEvaluation

```solidity
event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
```

**When it fires:** At finalization, last in the transaction of the N-th counted reveal, after the `BonusPayment`s and the `RequesterRefunded`. `aggregated` is the cluster's mean on the 0..1,000,000 scale; `justifications` is the clustered reveals' CIDs, comma-separated. The round is then in phase 6.

### EvaluationFailed

```solidity
event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase);
```

`phase` is where the round failed:

| `phase` | Cause | Emitted by |
|---------|-------|------------|
| 1 | No eligible arbiter at the draw, or fewer beacon candidates than the quorum | `drawJury` |
| 2 | Beacon quorum missed by the beacon deadline | the second `drawJury` |
| 3 | Commit phase never closed by the deadline | settlement |
| 4 | Closed but never promoted | settlement |
| 5 | Fewer than N counted reveals by the deadline | settlement |

**When it fires:** As above. The round is then in phase 8, and `isFailed(aggId)` is true. A failure at 1 or 2 is not settled with the keeper (there is no jury to score) and emits no `RoundSettled`.

### RoundSettled

```solidity
event RoundSettled(bytes32 indexed aggRequestId, bool failed);
```

**When it fires:** When a drawn round is settled after its deadline, by `settle` or by a later request's settlement queue. Every slot's outcome has then been reported to the keeper. `failed` is false for a finalized round (phase 7) and true for a failed one (phase 8, after its `EvaluationFailed`).

### RoundCancelled

```solidity
event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool);
```

The parameter keeps the name it had when v2 drafts had a treasury: the amount now goes to the arbiter pool, `ethOwed(address(0))`, not to a treasury.

**When it fires:** On `cancelUnsealed` of a round that was never drawn: unsealed once blockhash(B+1) left the 8,191-block history, or sealed but undrawn 1 day after the request. `toPool` is the whole prepay, credited to the arbiter pool. The round is then in phase 9, and `isFailed` stays false.

### SlotSkipped

```solidity
event SlotSkipped(bytes32 indexed aggRequestId, uint256 pollIndex, uint8 reason);
```

| `reason` | When | Effect |
|----------|------|--------|
| 1 | At the draw: the operator's `owner()` reverted, returned short data, a zero address, or dirty high bits, within the 30,000-gas stipend | The slot gets no commit request and no base fee |
| 2 | At the draw: the commit request reverted or used up `dispatchGas()`, for example because the operator does not list the v2 keeper | The same |
| 3 | At `promote`: the reveal request reverted | The promoted slot cannot reveal |
| 4 | At settlement: the keeper's `applyOutcomes` reverted. `pollIndex` is `type(uint256).max` | The round is settled without scores |

### EthWithdrawn

```solidity
event EthWithdrawn(address indexed payee, uint256 amount);
```

**When it fires:** On `withdrawEth()` or `withdrawEthFor(payee)`: `amount` is the whole credit sent to `payee`.

### Inherited Events

`OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` from OpenZeppelin `Ownable`, `Paused(address account)` / `Unpaused(address account)` from `Pausable`. The aggregator does not use `ChainlinkClient`, so Chainlink's `ChainlinkRequested` and `ChainlinkFulfilled` events are not emitted: the operator's `OracleRequest` and `OracleResponse` events cover each request, and its id can be computed (see the contract page, "How requests go out"). The owner's setters (`setLimits`, `setParams`, `setRewards`, `setContracts`) emit no event.

## ReputationKeeper Events

### ArbiterRegistered

```solidity
event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee);
```

**When it fires:** On `registerArbiter`. `key` is `keyOf(oracle, jobId)`, and `fee` is the posted fee in wei of ETH. The keeper keeps no enumerable list: this event is how to find all arbiters.

### ExitRequested

```solidity
event ExitRequested(bytes32 indexed key, uint256 exitAt);
```

**When it fires:** On `requestExit`. `exitAt` is when `completeExit` becomes possible: now plus `unbondingPeriod()`.

### ArbiterRemoved

```solidity
event ArbiterRemoved(bytes32 indexed key, uint256 refunded);
```

**When it fires:** On `completeExit`. `refunded` is the stake left after burns, sent in VDKA to the operator's `owner()`.

### HealthCall

```solidity
event HealthCall(bytes32 indexed key, uint256 sentAt);
```

**When it fires:** When a health call is sent to an arbiter. It is sent to:

- every juror at selection, and `liveRandom()` other shortlisted arbiters;
- every beacon candidate;
- the keys passed to `sendHealthCalls`;
- the key passed to `requestHealthCall`;
- an arbiter's own first valid answer after a re-sync.

The node must answer within `callDeadline()` (60 s) or the arbiter is frozen. A second call while one is pending emits nothing (the earlier deadline stands), except the one call a re-sync waits for.

### HealthAnswered

```solidity
event HealthAnswered(bytes32 indexed key, uint256 answeredAt);
```

**When it fires:** On every valid `answerHealthCall` or `rotateChain`: one whose value hashes to the head. It fires also when no call was pending; the value is then revealed early.

### ChainResynced

```solidity
event ChainResynced(bytes32 indexed key);
```

**When it fires:** When an answer's value does not hash to the head (`answerHealthCall(key, v)` or `rotateChain(key, v, v)`). `v` becomes the head, and the arbiter is frozen until it answers a call sent after the re-sync.

### ScoresUpdated

```solidity
event ScoresUpdated(bytes32 indexed key, uint256 quality, uint256 timeliness);
```

**When it fires:** In `applyOutcomes`, once per slot with a non-zero code that was scored. The values are the new scores, after the cap and any restart at `start`. A repeated arbiter gets one event per slot.

### OutcomeSkippedFrozen

```solidity
event OutcomeSkippedFrozen(bytes32 indexed key);
```

**When it fires:** In `applyOutcomes`, for a slot whose arbiter was frozen at the round's end and did not commit in the round. It is not scored.

### ArbiterBlocked

```solidity
event ArbiterBlocked(bytes32 indexed key, uint256 until, uint256 offenses, uint256 burned);
```

**When it fires:** In `applyOutcomes`, when a score reaches 0 and the arbiter is not already blocked. `until` is the end of the block, `offenses` the count after this one (after decay), and `burned` the VDKA burned from the stake.

### ArbiterBanned

```solidity
event ArbiterBanned(bytes32 indexed key, uint256 burned);
```

**When it fires:** Right after the `ArbiterBlocked` of the `maxOffenses()`-th block (3). `burned` is the same amount: the whole stake if `burnOnBan()` is set.

### ContractApproval

```solidity
event ContractApproval(address indexed aggregator, bool approved);
```

**When it fires:** On `setApproved`. Approved contracts can select arbiters, pick beacons and report outcomes, and ArbiterOperators that list this keeper accept their requests.

The keeper's `setPaused`, `setFee`, `topUpStake` and owner setters emit no event. Ownership changes emit OpenZeppelin's `OwnershipTransferred`.

## JuryBeacons Events

### BeaconCalled

```solidity
event BeaconCalled(address indexed aggregator, bytes32 indexed aggId, uint256 index, bytes32 indexed key, uint256 deadline);
```

**When it fires:** In `start`, once per picked beacon, when the stage starts with at least the quorum. `index` orders the beacons for mixing, `key` is the beacon's keeper key, and `deadline` is when the stage expires. It is for information: the node answers the keeper's `HealthCall`, emitted in the same transaction.

### Approval

```solidity
event Approval(address indexed aggregator, bool ok);
```

**When it fires:** On `setApproved`.

## ArbiterOperator Events

### ReputationKeeper Management

```solidity
event ReputationKeeperAdded(address indexed rk);
event ReputationKeeperRemoved(address indexed rk);
```

**When they fire:** When the owner adds or removes a ReputationKeeper from the access control allowlist via `addReputationKeeper()` / `removeReputationKeeper()`.

### Callback Tracing

```solidity
event OracleCallbackAttempt(
    bytes32 indexed requestId,
    address callback,
    bytes4 selector,
    uint256 gasBefore
);

event OracleCallbackResult(
    bytes32 indexed requestId,
    bool success,
    bytes returnData,
    uint256 gasAfter
);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `requestId` | `bytes32` | Chainlink request identifier |
| `callback` | `address` | Consumer contract receiving the callback |
| `selector` | `bytes4` | Function selector being called (e.g., `fulfill.selector`) |
| `gasBefore` / `gasAfter` | `uint256` | Gas remaining before and after the callback |
| `success` | `bool` | Whether the low-level call succeeded |
| `returnData` | `bytes` | Return data (or revert data) from the callback |

**When they fire:** During `fulfillOracleRequestV()`, immediately before and after the callback to the consumer contract. Useful for debugging: compare `gasBefore − gasAfter` for gas consumption and inspect `returnData` on failure.

### Inherited Chainlink Events

```solidity
event OracleRequest(/* standard Chainlink fields */);
event OracleResponse(bytes32 indexed requestId);
```

**When they fire:** Standard Chainlink operator events inherited from `OperatorMod`. `OracleRequest` fires when the operator accepts a new request (after `_beforeOracleRequest` access control passes). `OracleResponse` fires during `fulfillOracleRequestV()` after payment processing.

## Legacy and v1 contracts

These contracts are in the repository but are not part of the v2 flow.

### SimpleContract Events

SimpleContract is a legacy contract that is paid in LINK. It is unchanged in v2.

#### RequestAIEvaluation

```solidity
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
```

**When it fires:** Once per call to `requestAIEvaluationWithApproval()`.

#### FulfillmentReceived

```solidity
event FulfillmentReceived(bytes32 indexed requestId, address caller, uint256 len, string justificationCID);
```

**When it fires:** At the beginning of `fulfill()`, before validation. A debugging event that shows the raw callback data including the caller address and array length.

#### FulfillAIEvaluation

```solidity
event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
```

**When it fires:** After successful fulfillment and bonus payment.

#### BonusPaid

```solidity
event BonusPaid(bytes32 indexed requestId, address oracle, uint256 amount);
```

**When it fires:** When the bonus LINK is successfully transferred from the requester to the oracle during `fulfill()`. Amount equals the contract's configured `fee`.

#### EvaluationFailed

```solidity
event EvaluationFailed(bytes32 indexed requestId);
```

**When it fires:** When `finalizeEvaluationTimeout()` marks a request as timed out.

### ReputationSingleton Events (v1 only)

ReputationSingleton is a legacy contract that is paid in LINK. It works only with the v1 keeper.

#### RequestAIEvaluation

```solidity
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
```

**When it fires:** Once per call to `requestAIEvaluationWithApproval()`.

#### EvaluationFulfilled

```solidity
event EvaluationFulfilled(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
```

**When it fires:** After successful fulfillment and bonus payment. Note the event name: `EvaluationFulfilled` (not `FulfillAIEvaluation`).

#### BonusPaid

```solidity
event BonusPaid(bytes32 indexed requestId, address oracle, uint256 amount);
```

**When it fires:** When the bonus LINK (equal to `feeUsed`) is transferred from the contract's balance to the oracle during `fulfill()`.

#### EvaluationFailed

```solidity
event EvaluationFailed(bytes32 indexed requestId);
```

**When it fires:** When `finalizeEvaluationTimeout()` marks a request as timed out.

## Event Lifecycle: Complete Request Flow

### ReputationAggregator (v2)

```
Request transaction (block B):
1. RequestFunded                         ETH from credit and from msg.value
2. RequestAIEvaluation                   round created; no jury yet
   (plus RoundSettled etc. for any due rounds the request settles first)

drawJury, from block B+2:
3. SeedSealed                            unless sealSeed ran earlier
   With beacons, first call:  BeaconStageStarted + JuryBeacons.BeaconCalled (x beacons)
                              + keeper HealthCall (x beacons)
   With beacons, second call: BeaconPayment (x used values)
4. keeper HealthCall (x jurors + 3)
5. BasePayment (x dispatched slots) and SlotSkipped (x undispatched slots)
   PoolPayment                           an eighth of the arbiter pool (at most the base fees), if someone was picked
6. JuryDrawn                             phase 3, deadline = now + timeout

As the arbiters answer:
7. CommitReceived (x commits)
8. CommitWindowClosed                    at the M+-th commit, after T+ with M, or closeCommits
9. CommitPhaseComplete                   promote, from block C+2; reveal requests sent
10. RevealReceived(late = false) (x N)

In the transaction of the N-th counted reveal:
11. BonusPayment (x P)
12. RequesterRefunded
13. FulfillAIEvaluation                  phase 6

Until the deadline:
    RevealReceived(late = true, qcode)   late reveals, scored only

After the deadline, settle() or a later request:
14. (failed rounds: RequesterRefunded, EvaluationFailed(3 | 4 | 5); never promoted with M commits:
    RequesterRefunded(address(0)) for the remainder, if any, EvaluationFailed, CommitPayment (x committed slots))
15. keeper ScoresUpdated / OutcomeSkippedFrozen / ArbiterBlocked / ArbiterBanned
16. RoundSettled

Other endings:
    EvaluationFailed(1) (+ RequesterRefunded) at the draw: no eligible arbiter or too few beacons
    BeaconPayment + RequesterRefunded(address(0), the pool) + EvaluationFailed(2): beacon quorum missed
    RoundCancelled: never drawn (the whole prepay to the pool)

Whenever a payee collects:
    EthWithdrawn
```

### ReputationSingleton (v1 only)

```
1. RequestAIEvaluation              — request created
2. BonusPaid                        — oracle bonus paid from contract balance
3. EvaluationFulfilled              — result received

On timeout:
   EvaluationFailed
```

### SimpleContract

```
1. RequestAIEvaluation              — request created
2. FulfillmentReceived              — debugging: raw callback data logged
3. BonusPaid                        — bonus pulled from requester to oracle
4. FulfillAIEvaluation              — result stored and emitted

On timeout:
   EvaluationFailed
```

## Listening for Events

```javascript
// ethers.js v6 example
const contract = new ethers.Contract(address, abi, provider);

// New results (ReputationAggregator). Subscribed by event name, the listener gets the values
contract.on("FulfillAIEvaluation", (aggRequestId, aggregated, justifications) => {
    console.log("Evaluation complete:", {
        aggRequestId,
        scores: aggregated.map(s => s.toString()),   // 0..1,000,000 scale
        justifications
    });
});

// One round. Subscribed with a filter object, the listener gets one argument,
// the event, and the values are in its `args`
contract.on(contract.filters.JuryDrawn(myAggId), (event) => {
    const [, drawer, reward] = event.args;
    console.log(`Jury drawn by ${drawer}, reward ${ethers.formatEther(reward)} ETH`);
});
contract.on(contract.filters.CommitReceived(myAggId), (event) => {
    const [, pollIndex] = event.args;
    console.log(`Commit from slot ${pollIndex}`);
});
contract.once(contract.filters.FulfillAIEvaluation(myAggId), (event) => {
    const [, aggregated] = event.args;
    console.log("Got result:", aggregated.map(s => s.toString()));
});
contract.once(contract.filters.EvaluationFailed(myAggId), (event) => {
    const [, phase] = event.args;
    console.log(`Round failed in phase ${phase}`);
});

// What a round paid and gave back (wei of ETH)
contract.on(contract.filters.BasePayment(myAggId), (event) => {
    const [, pollIndex, payee, amount] = event.args;
    console.log(`Base fee ${ethers.formatEther(amount)} ETH to ${payee} (slot ${pollIndex})`);
});
contract.on(contract.filters.RequesterRefunded(myAggId), (event) => {
    const [, to, amount] = event.args;   // the requester, or address(0): the arbiter pool
    console.log(`Unspent ${ethers.formatEther(amount)} ETH credited to ${to}`);
});
```

For what triggers each error, see the [Error Reference](errors.md). For the fee flow behind `BasePayment`, `BonusPayment`, `BeaconPayment` and `RequesterRefunded`, see [Fee Mechanisms](../advanced/fees.md) and the [ReputationAggregator fee structure](../contracts/reputation-aggregator.md#fee-structure).
