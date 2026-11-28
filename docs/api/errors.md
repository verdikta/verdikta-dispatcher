# Error Reference

Complete reference for all custom errors and revert conditions across Verdikta Dispatcher contracts.

!!! note "Checked against the code"
    Regenerated on 2026-11-25 for **v2** from the error declarations and `revert` sites in [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol), [`AggregatorLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/AggregatorLib.sol), [`ScoringLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ScoringLib.sol), [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) and [`JuryBeacons.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/JuryBeacons.sol) on the `beacon` branch. v2 is not deployed yet. The v1 aggregator and keeper (tag `aggregator-v0.1.0`, deployed today) had different errors: v1's `EmptyCIDList`, `TooManyCIDs`, `CIDTooLong`, `AddendumTooLong`, `InactiveOracle`, `AggregationComplete`, `MalformedPayload`, `RevealBeforeCommit`, `NotTimedOut`, `LengthTooShort`, `InvalidBonusMultiplier`, `ZeroAddress`, `LinkTransferFailed` and the keeper's `require` strings are gone. They are not listed here; see the tag for them. The contracts that still use LINK are listed under [Legacy and v1 contracts](#legacy-and-v1-contracts).

All v2 contracts use custom errors without arguments, except the inherited OpenZeppelin ones. An error raised in a library (`AggregatorLib`, `ScoringLib`) reaches the caller of the aggregator unchanged.

## ReputationAggregator Custom Errors

### Request Errors

These come from `requestAIEvaluationWithApproval(...)`.

| Error | Trigger | Meaning |
|-------|---------|---------|
| `KeeperNotSet()` | `keeper() == address(0)` | No ReputationKeeper is configured (`setContracts`) |
| `BadInput()` | Declared in `AggregatorLib` (`buildCommitPayload`): no CIDs, more than 10, a CID over 100 bytes, or an addendum over 1,000 bytes | The query payload is out of bounds |
| `BadJury()` | Declared in `AggregatorLib` (`checkJury`). The jury breaks one of: K ≥ M ≥ N ≥ P ≥ 1; N ≤ 40; P ≥ 2 unless N = 1; K ≤ `maxJury()`; K ≤ the keeper's `shortlistSize()`; `tPlus()` < timeout ≤ `maxTimeout()`; timeout ≤ 1 day (86,400 s, `AggregatorLib.MAX_TIMEOUT`, whatever `maxTimeout()` says) | The requested jury is not allowed. All limits are read at request time |
| `BadInput()` | Declared in the aggregator: `estimatedBaseCost >= min(maxFee, maxOracleFee())`, `alpha > 1000`, `maxFeeBasedScalingFactor` outside 1..65,535, or a prepay above 2^88 − 1 wei | A fee or weighting parameter is out of bounds |
| `InsufficientPayment()` | `msg.value` plus the caller's `ethOwed` credit is below `maxTotalFee(maxFee, minFee, withBeacons, K, P)` | Send the missing ETH. Credit covers only what `msg.value` does not |
| `EnforcedPause()` | The owner has called `pause()` | Inherited from OpenZeppelin `Pausable`. Only new requests stop |
| (no data) | `withBeacons == true` while `beacons() == address(0)` | The call to read the beacon quorum reverts. `maxTotalFee(..., true, ...)` reverts the same way |

The request first settles due rounds. A revert in the request undoes that too.

### Round Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `WrongPhase()` | `drawJury` outside phases 1–2; `sealSeed` outside phase 1 or when already sealed; `closeCommits` outside phase 3, at or before `windowEnd`, with fewer than M commits, or after the deadline; `promote` outside phase 4 or after the deadline; `settle` outside phases 3–6; `cancelUnsealed` outside phases 1–2 | The call does not fit the round's state. Read `getRoundInfo(aggId)` |
| `TooEarly()` | `drawJury` or `sealSeed` before block B+2; the second `drawJury` of a beacon round while the beacons are pending; `promote` before block C+2; `cancelUnsealed` before block B+1+8,191 (unsealed) or before 1 day after the request (sealed) | Wait and try again |
| `SeedExpired()` | blockhash(B+1) (draw, seal) or blockhash(C+1) (promote) is no longer readable: more than 8,191 blocks old | The seed is gone. An unsealed round can then only be cancelled; a closed round that cannot be promoted waits for settlement |
| `DrawExpired()` | `drawJury` more than 1 day after the request | Only `cancelUnsealed` can end the round |
| `NotDue()` | `settle` at or before the round's deadline | Wait for the deadline (`getRoundInfo().deadline`) |
| `BadSelectionCount()` | The keeper returned a jury of a size other than K | A guard; the keeper always returns K (with repeats if needed) |
| `InsufficientPayment()` | A drawn arbiter's fee as of B is above the round's fee ceiling | A guard; the keeper filters by fee |
| `OutOfGas()` | `drawJury`, `settle` or a dispatch had too little gas for a call whose failure the contract tolerates (the stipend check, or a keeper call starved by the caller) | Raise the gas limit. It stops a caller from choosing a gas limit that skips a slot or the scores |
| `UnknownRequest()` | `fulfill` with a request id that maps to no slot, that was already answered, or from an address other than the operator it was sent to | One answer per request, from its own operator |

`fulfill` does not revert on a bad answer. It ignores without an error a commit outside phase 3, a zero or repeated commit, a reveal from a slot that is not promoted or has already revealed, a reveal of the wrong length, an over-long or malformed `cid:salt`, a hash mismatch, and anything after the deadline. The Chainlink request is used up all the same.

### Payment and Withdrawal Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `NothingOwed()` | `withdrawEth()` or `withdrawEthFor(payee)` when `ethOwed[payee]` is 0 | Nothing to withdraw |
| `EthTransferFailed()` | The ETH transfer in `_withdrawTo(payee)` failed | The payee did not accept ETH (for example a contract without `receive()`). The credit stays |
| `NotAuthorized()` | `withdrawEthFor(payee)` from neither `payee` nor the owner, or for `payee` = address(0) (the arbiter pool, which nobody can withdraw) | Only the payee or the owner can trigger a payout, and it always goes to the payee |

### Configuration Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `InvalidConfig()` | `setLimits` with `maxJury_ == 0`, `tPlus_ == 0` or `maxTimeout_ <= tPlus_` | A `maxTimeout_` above one day is accepted, but `checkJury` caps every request's timeout at one day, so no request can use more |
| `InvalidConfig()` | `setParams` with `bonusMult > 20`, `dispatchGas_` outside 100,000..2,000,000, or `spreadFloor_ > 1e34` | `settlePerReq` and `maxOracleFee_` are not checked; `settlePerReq = 0` turns settlement by requests off |
| `InvalidConfig()` | `setRewards` with `revealWindow_ == 0` | |
| `InvalidConfig()` | `setContracts` with a zero keeper | A zero beacon address is allowed and turns beacons off |
| `OwnableUnauthorizedAccount(address)` | An owner-only function from another address | Inherited from OpenZeppelin `Ownable` |
| `OwnableInvalidOwner(address)` | `transferOwnership(address(0))` | Inherited from OpenZeppelin `Ownable` |
| `ExpectedPause()` | `unpause()` while not paused | Inherited from OpenZeppelin `Pausable`. `pause()` while paused gives `EnforcedPause()` |
| `ReentrancyGuardReentrantCall()` | A guarded function entered again during its own execution | Inherited from OpenZeppelin `ReentrancyGuard` |

## Library Errors

These are declared in the libraries. The aggregator's inputs never trigger the guards; they protect direct calls to the public library functions.

| Error | Library | Trigger |
|-------|---------|---------|
| `BadInput()` | `AggregatorLib` | `buildCommitPayload` (see Request Errors) |
| `BadJury()` | `AggregatorLib` | `checkJury` (see Request Errors) |
| `NeedMoreResponses()` | `AggregatorLib` | `findBestCluster` with fewer than 2 responses. v1's clustering, which the v2 aggregator no longer calls |
| `ArrayLengthMismatch()` | `AggregatorLib` | `findBestCluster`'s distance on vectors of different lengths (v1's clustering) |
| `NeedTwo()` | `ScoringLib` | `bestCluster` with fewer than 2 vectors (the aggregator clusters only from 2 counted reveals) |
| `TooMany()` | `ScoringLib` | `bestCluster` or `tieOrder` with more than 256 vectors |
| `LengthMismatch()` | `ScoringLib` | Vectors of different lengths after normalization, or `aggregate` with `ids` of another length |
| `OutOfRange()` | `ScoringLib` | A vector longer than 20 values, or a value above 1e34 |

## ReputationKeeper Custom Errors

### Registration, Stake and Exit

| Error | Trigger | Meaning |
|-------|---------|---------|
| `BadParams()` | `registerArbiter` with an operator that has no code, or `fee == 0`; `setFee` with `fee == 0` | |
| `BadClasses()` | `registerArbiter` with 0 or more than 5 classes | |
| `NotArbiterOwner()` | `registerArbiter`, `setPaused`, `setFee`, `topUpStake`, `requestExit` or `completeExit` from neither the keeper's owner nor the operator's `owner()` | |
| `AlreadyRegistered()` | `registerArbiter` for a key that is registered, or banned (a banned key is a permanent tombstone) | |
| `NotRegistered()` | Any per-key call (management, health answers, `requestHealthCall`) for a key that is not registered | Registered keys only |
| `TransferFailed()` | The VDKA `transferFrom` (stake, top-up) or `transfer` (refund, burn fallback) returned false | Approve the keeper for `stakeRequirement()` VDKA before `registerArbiter` |
| `AlreadyExiting()` | A second `requestExit` | It would restart the unbonding clock |
| `StillBonded()` | `completeExit` without `requestExit`, or before `getArbiter(key).exitAt` | Wait for the unbonding period (2 days by default) |
| `Blocked()` | `completeExit` while the arbiter is blocked | Wait until `blockedUntil` |

### Health Calls

| Error | Trigger | Meaning |
|-------|---------|---------|
| `NotAuthorizedResponder()` | `answerHealthCall`, `rotateChain` or `requestHealthCall` from neither the operator's `owner()` nor an address for which the operator's `isAuthorizedSender` returns true (or that call reverts) | Send from the node's authorized key |
| `BadPreimage()` | `rotateChain(key, preimage, newHead)` with `newHead != preimage` and a `preimage` that does not hash to the head | A rotation needs a valid answer. An invalid value with `newHead == preimage`, or `answerHealthCall` with one, re-syncs the chain instead of reverting |
| `NotEvictable()` | `evict(key)` for a key that is not in its class lists, or that has not been paused, frozen or banned for `evictAfter` and is not past its `exitAt` | Wait until it is idle that long (`scripts/tidy-classes.js` lists the keys that are) |

### Selection and Outcomes (approved contracts only)

| Error | Trigger | Meaning |
|-------|---------|---------|
| `NotApproved()` | `selectArbiters`, `pickBeacons` or `applyOutcomes` from a contract that `setApproved` has not approved | |
| `BadParams()` | `selectArbiters` with `alpha > 1000`, `count == 0`, `estimatedBaseCost >= maxFee` or a scaling factor below 1; `applyOutcomes` with arrays of different lengths; `missedBeacons` (`JuryBeacons.chargeSilent`) for a pick the caller did not make or already charged, before the deadline or more than a day (`MAX_DRAW_AGE`) after the pick, or with a stage shorter than `callDeadline` | |
| `FutureBlock()` | `selectArbiters` or `pickBeacons` with `atBlock >= block.number` | Selection reads only past state |
| `StaleBlock()` | `selectArbiters` or `pickBeacons` with `atTime` more than `MAX_DRAW_AGE` (1 day) ago | |
| `NoEligibleArbiters()` | `selectArbiters` when the class list is empty as of `atBlock`, or the walk finds no eligible arbiter | Only at zero: with fewer than K, the jury repeats arbiters. The aggregator catches it and fails the round with a refund |

### Configuration

| Error | Trigger |
|-------|---------|
| `BadParams()` | `setPoints` with `cap == 0`, `start == 0` or `start > cap`; `setTiming` with `decay == 0` or `unbonding < MIN_UNBONDING` (2 days); `setPenalties` with `_maxOffenses` 0 or above 16; `setSelection` with `_shortlist == 0` or `_maxScan < _shortlist` |
| `OwnableUnauthorizedAccount(address)` | An owner-only function from another address |
| `OwnableInvalidOwner(address)` | `transferOwnership(address(0))` |

## JuryBeacons Custom Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `NotApproved()` | `start` from an aggregator that `setApproved` has not approved | It reverts the aggregator's `drawJury` |
| `AlreadyStarted()` | A second `start` for the same aggregator and `aggId` | |
| `InvalidConfig()` | `setParams` with `quorum_ == 0`, `polled_ < quorum_`, `polled_ > 16` or `timeout_ == 0` | |
| `OutOfGas()` | `result` without enough gas left to read the payees' owners with the 30,000-gas stipend | So a caller's gas limit cannot skip beacon payments |
| `OwnableUnauthorizedAccount(address)` | `setApproved` or `setParams` from another address | Inherited from OpenZeppelin `Ownable` |

## ArbiterOperator Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"RK: not contract"` | `addReputationKeeper(addr)` where `addr.code.length == 0` | ReputationKeeper address must be a deployed contract |
| `"RK: exists"` | `addReputationKeeper(addr)` where `rk[addr] == true` | This ReputationKeeper is already in the allowlist |
| `"RK: interface"` | `addReputationKeeper(addr)` where `isContractApproved()` staticcall fails | The address does not implement the `IReputationKeeper` interface |
| `"RK: unknown"` | `removeReputationKeeper(addr)` where `rk[addr] == false` | This address is not in the ReputationKeeper allowlist |
| `"Operator: requester not approved"` | Oracle request from a contract not approved by any registered ReputationKeeper (in `_beforeOracleRequest` or `fulfillOracleRequestV`) | The requesting contract must be approved in at least one ReputationKeeper on the operator's list. A v2 keeper approves with `setApproved` and answers `isContractApproved`. For the v2 aggregator, the operator's owner must add the v2 keeper (`addReputationKeeper`); otherwise the aggregator skips the slot (`SlotSkipped`, reason 2). Also checked at fulfillment time as a secondary guard. |
| `"Operator: not enough gas for consumer"` | `gasleft() < 400,000` during `fulfillOracleRequestV` | Insufficient gas remaining for the callback. The oracle node must provide more gas. |

### Inherited Chainlink Errors

The ArbiterOperator inherits from `OperatorMod` which includes standard Chainlink validation modifiers. These may produce revert messages from `validateAuthorizedSender`, `validateRequestId`, `validateCallbackAddress`, and `validateMultiWordResponseId`.

## Legacy and v1 contracts

These contracts are in the repository but are not part of the v2 flow.

### SimpleContract Errors

SimpleContract is a legacy contract that is paid in LINK. It is unchanged in v2 and talks to one fixed operator, without the aggregator or the keeper's selection.

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"class mismatch"` | `_requestedClass != requiredClass` | The requested evaluation class does not match the contract's configured class |
| `"CID count"` | `cids.length == 0` or `cids.length > 10` | Between 1 and 10 CIDs required |
| `"CID len"` | Individual CID exceeds 100 characters | Each CID must be 100 characters or fewer |
| `"addendum len"` | Addendum exceeds 1000 characters | Addendum text must be 1000 characters or fewer |
| `"timeout 30s to 1d"` | `setResponseTimeout()` with value outside 30–86400 second range | Timeout must be between 30 seconds and 1 day |
| `"already closed"` | `fulfill(...)` called on a request where `done == true` | This request has already been fulfilled or timed out |
| `"empty likelihoods"` | Oracle returned `likelihoods.length == 0` | Oracle must provide at least one likelihood score |
| `"empty CID"` | Oracle returned `bytes(justificationCID).length == 0` | Oracle must provide a justification CID |
| `"already complete"` | `finalizeEvaluationTimeout()` on a request where `done == true` | This request has already been finalized |
| `"not timed-out"` | `finalizeEvaluationTimeout()` before `started + responseTimeoutSeconds` | Timeout window has not expired |
| `"bonus LINK xferFrom failed"` | `link.transferFrom(requester, oracle, fee)` returns false during `fulfill()` | Bonus LINK transfer from requester to oracle failed. Check requester's LINK balance and allowance for the SimpleContract address. |

### ReputationSingleton Errors (v1 only)

ReputationSingleton is a legacy contract that is paid in LINK. It works only with the v1 keeper, whose `selectOracles`, `recordUsedOracles` and `updateScores` it calls; v2 has none of them.

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"Keeper zero"` | Constructor called with `_reputationKeeper == address(0)` | ReputationKeeper address cannot be zero at construction |
| `"Keeper not set"` | `requestAIEvaluationWithApproval(...)` when `reputationKeeper == address(0)` | No ReputationKeeper has been configured |
| `"CID count"` | `cids.length == 0` or `cids.length > 10` | Between 1 and 10 CIDs required |
| `"CID len"` | Individual CID exceeds 100 characters | Each CID must be 100 characters or fewer |
| `"Addendum len"` | Addendum exceeds 1000 characters | Addendum text must be 1000 characters or fewer |
| `"LINK pull failed"` | `link.transferFrom(msg.sender, contract, oracleFee * 2)` returns false | Failed to pull LINK from requester. Check balance and allowance for 2× the oracle fee. |
| `"closed"` | `fulfill(...)` called on a request where `done == true` | This request has already been fulfilled or timed out |
| `"bonus transfer failed"` | `link.transfer(oracle, feeUsed)` returns false during `fulfill()` | Bonus LINK transfer from contract to oracle failed |
| `"complete"` | `finalizeEvaluationTimeout()` on a request where `done == true` | This request has already been finalized |
| `"not timed-out"` | `finalizeEvaluationTimeout()` before `started + responseTimeoutSeconds` | Timeout window has not expired |

### DemoClient Errors (v1 aggregator)

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"already pending"` | `request()` called while `currentAggId != bytes32(0)` | A previous request is still active. Call `publish()` to clear it first. |
| `"not ready"` | `publish()` called when `getEvaluation()` returns `exists == false` and `isFailed()` returns `false` | The evaluation is still in progress, or it has passed its timeout and nobody has called the v1 aggregator's `finalizeEvaluationTimeout()` yet. |

`DemoClient.sol` still uses v1's 7-argument request and `maxTotalFee(uint256)`, so it works only with the v1 aggregator. `request()` passes the ETH it receives on to the aggregator, so the aggregator's errors reach the caller unchanged: for example `InsufficientPayment()` when less than `quote()` was sent.

## Troubleshooting

For common integration issues and solutions, see the [Troubleshooting Guide](../troubleshooting/index.md).

For understanding how fees interact with these errors, see the [Fee Mechanisms](../advanced/fees.md) guide.
