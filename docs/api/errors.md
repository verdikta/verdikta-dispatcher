# Error Reference

Complete reference for all custom errors and revert conditions across Verdikta Dispatcher contracts.

!!! note "Checked against the code"
    The ReputationAggregator section was revised on 2026-11-22 against the error declarations in [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationAggregator.sol) and [`AggregatorLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/AggregatorLib.sol). The aggregator is paid in ETH, so its payment errors are about ETH. `FeeTransferFailed()` and `BonusTransferFailed()` are not listed any more: they belonged to the LINK-funded aggregator (`ReputationAggregatorLINK.sol` at the tag `aggregator-v0.1.0`) and the current contract does not declare them.

## ReputationAggregator Custom Errors

These errors use Solidity custom error syntax (gas-efficient, no string storage).

### Configuration Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `LengthTooShort()` | `setMaxLikelihoodLength(_len)` where `_len < 2` | The maximum likelihood array length must be at least 2 |
| `InvalidConfig()` | `setConfig(_k, _m, _n, _p, _timeout)` where `K < M`, `M < N`, `N < P`, or `P < 2` | Phase parameters must satisfy `K ≥ M ≥ N ≥ P ≥ 2` |
| `InvalidBonusMultiplier()` | `setBonusMultiplier(_m)` where `_m > 20` | Bonus multiplier cannot exceed 20× |
| `KeeperNotSet()` | `requestAIEvaluationWithApproval(...)` when `reputationKeeper == address(0)` | No ReputationKeeper contract has been configured |
| `ZeroAddress()` | `setReputationKeeper(address(0))` | Cannot set ReputationKeeper to the zero address |

### Request Validation Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `EmptyCIDList()` | `requestAIEvaluationWithApproval(...)` with empty `cids` array | At least one IPFS CID must be provided |
| `TooManyCIDs()` | `requestAIEvaluationWithApproval(...)` with `cids.length > MAX_CID_COUNT` (10) | Maximum 10 CIDs per request |
| `CIDTooLong()` | Any individual CID exceeds `MAX_CID_LENGTH` (100 characters) | Each CID must be 100 characters or fewer |
| `AddendumTooLong()` | `addendumText` exceeds `MAX_ADDENDUM_LENGTH` (1000 characters) | Addendum text must be 1000 characters or fewer |
| `InactiveOracle()` | An oracle selected for polling has `isActive == false` at dispatch time (`_pollOracle`) | The keeper returned an oracle that it reports as inactive |
| `BadSelectionCount()` | The keeper's `selectOracles(...)` returned a number of oracles other than `commitOraclesToPoll` (K) | The round's prepayment is sized for exactly K base fees, so any other count is refused |
| `EnforcedPause()` | `requestAIEvaluationWithApproval(...)` while the owner has paused the contract with `pause()` | New requests are stopped. Inherited from OpenZeppelin `Pausable`. Rounds in progress, `finalizeEvaluationTimeout(...)` and withdrawals are not affected |

### Payment and Withdrawal Errors

Evaluation fees are paid in ETH. These errors replace the LINK transfer errors of the earlier contract.

| Error | Trigger | Meaning |
|-------|---------|---------|
| `InsufficientPayment()` | `requestAIEvaluationWithApproval(...)` when `msg.value` plus the caller's `ethOwed` credit is less than `maxTotalFee(_maxOracleFee)` (checked in `_fundFromCredit`) | Send the missing ETH with the call. `maxTotalFee(...)` returns the required amount, and `ethOwed(caller)` the credit that is used first |
| `InsufficientPayment()` | A selected oracle's registered fee is above the fee ceiling the round was sized on (guard in `_pollOracle`) | A second line of defence: the keeper already filters oracles by fee, so this does not trigger in normal operation |
| `NothingOwed()` | `withdrawEth()` or `withdrawEthFor(payee)` when `ethOwed[payee]` is 0 | There is nothing to withdraw for this address |
| `EthTransferFailed()` | The ETH transfer to the payee in `_withdrawTo(payee)` returned false | The payee's address did not accept the ETH (for example a contract without a `receive()` function). The transaction reverts, so the credit stays in `ethOwed[payee]` |
| `NotAuthorized()` | `withdrawEthFor(payee)` called by an address that is neither `payee` nor the contract owner | Only the payee or the owner can trigger a payout, and it always goes to the payee |
| `LinkTransferFailed()` | The LINK transfer in `withdrawLink(...)` returned false | The owner-only recovery of LINK sent to the contract by mistake failed. The contract holds no LINK in normal operation |

### Fulfillment Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `AggregationComplete()` | `fulfill(...)` or `finalizeEvaluationTimeout(...)` on an already-finalized evaluation | This evaluation has already been finalized |
| `UnknownRequest()` | `fulfill(...)` with a `requestId` that maps to `aggId == bytes32(0)`, or `finalizeEvaluationTimeout(aggId)` with an ID that no request created (`startTimestamp == 0`) | The ID does not belong to any known evaluation |
| `MalformedPayload()` | `fulfill(...)` where response does not match either commit or reveal shape | Commit shape: exactly 1 element + empty CID. Reveal shape: 2+ elements + non-empty CID. |
| `RevealBeforeCommit()` | A reveal-shaped response arrives before `commitPhaseComplete == true` | The commit phase must complete (M commits received) before reveal responses are accepted |
| `NotTimedOut()` | `finalizeEvaluationTimeout(...)` before `startTimestamp + responseTimeoutSeconds` | The evaluation has not yet exceeded its timeout window |
| `NeedMoreResponses()` | `AggregatorLib.findBestCluster(...)` called with fewer than 2 selected responses | Declared in `AggregatorLib`. At least 2 selected responses are needed for clustering. The aggregator calls the function only when it has 2 or more |
| `ArrayLengthMismatch()` | Two likelihood arrays have different lengths in `AggregatorLib.calculateDistance(...)` | Declared in `AggregatorLib`. The aggregator first brings all reveals to the most common length (`normalizeToModal`), so this is a guard |

### Other Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `OnlySelf()` | `dispatchOracleRequest(...)` called by any address other than the aggregator itself | The function is an internal step of the contract that had to be declared `external`. Nobody else can use it |
| `OwnableUnauthorizedAccount(address)` | An owner-only function called by another address | Inherited from OpenZeppelin `Ownable` |
| `ReentrancyGuardReentrantCall()` | A guarded function entered again during its own execution | Inherited from OpenZeppelin `ReentrancyGuard` |

## ReputationKeeper Require Errors

ReputationKeeper uses `require()` with string messages (not custom errors).

### Registration Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"Oracle is a zero address"` | `registerOracle(address(0), ...)` | Oracle address cannot be zero |
| `"Oracle address has no code"` | `_oracle.code.length == 0` | The oracle address must be a deployed contract |
| `"Oracle not ArbiterOperator type"` | `IERC165(_oracle).supportsInterface(ARBITERIFACE)` returns false | Oracle must implement `IArbiterOperator` (ERC-165 interface ID `0xd9f812f9`) |
| `"Oracle does not support Reputation Keeper"` | Oracle's RK list is non-empty and does not include this keeper | The ArbiterOperator must have this ReputationKeeper in its allowlist, or its allowlist must be empty |
| `"Oracle is already registered"` | `oracles[key].stakeAmount > 0` for this oracle+jobId key | This oracle/jobId combination is already registered |
| `"Fee must be greater than 0"` | `fee == 0` | A non-zero fee is required for oracle registration. The keeper stores the fee as a plain number; the ReputationAggregator reads it as wei of ETH |
| `"At least one class must be provided"` | `_classes.length == 0` | Oracle must support at least one evaluation class |
| `"A maximum of 5 classes are allowed"` | `_classes.length > 5` | Oracle can support at most 5 evaluation classes |
| `"Not authorized to register oracle"` | Caller is neither `owner()` of the keeper nor `IOracleOwner(_oracle).owner()` | Only the oracle contract owner or keeper contract owner can register |
| `"Stake transfer failed"` | VDKA `transferFrom()` returns false | Ensure 100 VDKA tokens (`STAKE_REQUIREMENT`) are approved for the keeper contract |

### Deregistration Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"Oracle not registered"` | `stakeAmount == 0` AND `!isActive` AND `!blocked` | This oracle/jobId combination is not in the registry |
| `"Not authorized to deregister oracle"` | Caller is neither keeper owner nor oracle contract owner | Only authorized parties can deregister |
| `"Oracle is locked and cannot be unregistered"` | `block.timestamp < info.lockedUntil` | Oracle is under a lock period from slashing; wait for it to expire |
| `"Oracle owner is zero"` | `IOracleOwner(_oracle).owner()` returns `address(0)` | The oracle contract's owner is the zero address |
| `"Stake refund failed"` | VDKA `transfer()` returns false | Token transfer for stake refund failed |

### Selection Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"Not approved to select oracles"` | `approvedContracts[msg.sender].isApproved == false` | Only approved aggregator contracts can call `selectOracles` |
| `"Base cost must be less than max fee"` | `estimatedBaseCost >= maxFee` | The base cost estimate must be strictly less than the maximum fee |
| `"Max scaling factor must be at least 1"` | `maxFeeBasedScalingFactor < 1` | The fee scaling factor must be 1 or greater |
| `"No active oracles available with fee <= maxFee and requested class"` | Zero eligible oracles after filtering | No oracles match the criteria. Increase `maxFee`, try a different class, or wait for oracles to become available. |

### Score and Reputation Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"Oracle not used by this contract"` | `updateScores(...)` for oracle key not in `approvedContracts[msg.sender].usedOracles` | The calling contract must first call `recordUsedOracles()` before updating scores |
| `"Not approved to record oracles"` | `recordUsedOracles(...)` from an unapproved contract | Only approved contracts can record oracle usage |
| `"not aggregator"` | `pushEntropy(...)` from an unapproved contract | Only approved aggregator contracts can push entropy |
| `"Oracle not found"` | `getOracleClassesByKey(...)` for an unregistered oracle | The oracle/jobId combination is not in the `registeredOracles` array |
| `"Index out of bounds"` | `getOracleClasses(index)` with `index >= registeredOracles.length` | The index exceeds the number of registered oracles |

### Administrative Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"Oracle not registered"` | `setOracleActive(...)` or `manualBlockOracle(...)` where `stakeAmount == 0` | Cannot modify an oracle that is not registered |
| `"Duration must be > 0"` | `manualBlockOracle(...)` with `_duration == 0` AND `lockDurationConfig == 0` | Block duration must be positive |
| `"maxScoreHistory must be > 0"` | `setMaxScoreHistory(0)` | Score history window must be at least 1 |
| `"maxScoreForSelection must be > 0"` | `setMaxScoreForSelection(0)` | Selection score cap must be positive |
| `"minScoreForSelection must be > 0"` | `setMinScoreForSelection(0)` | Selection score floor must be positive |
| `"Shortlist size must be > 0"` | `setShortlistSize(0)` | Shortlist must contain at least 1 oracle |
| `"Invalid token address"` | `setVerdiktaToken(address(0))` | Cannot set VDKA token to the zero address |

## ArbiterOperator Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"RK: not contract"` | `addReputationKeeper(addr)` where `addr.code.length == 0` | ReputationKeeper address must be a deployed contract |
| `"RK: exists"` | `addReputationKeeper(addr)` where `rk[addr] == true` | This ReputationKeeper is already in the allowlist |
| `"RK: interface"` | `addReputationKeeper(addr)` where `isContractApproved()` staticcall fails | The address does not implement the `IReputationKeeper` interface |
| `"RK: unknown"` | `removeReputationKeeper(addr)` where `rk[addr] == false` | This address is not in the ReputationKeeper allowlist |
| `"Operator: requester not approved"` | Oracle request from a contract not approved by any registered ReputationKeeper (in `_beforeOracleRequest` or `fulfillOracleRequestV`) | The requesting contract must be approved in at least one ReputationKeeper. Also checked at fulfillment time as a secondary guard. |
| `"Operator: not enough gas for consumer"` | `gasleft() < 400,000` during `fulfillOracleRequestV` | Insufficient gas remaining for the callback. The oracle node must provide more gas. |

### Inherited Chainlink Errors

The ArbiterOperator inherits from `OperatorMod` which includes standard Chainlink validation modifiers. These may produce revert messages from `validateAuthorizedSender`, `validateRequestId`, `validateCallbackAddress`, and `validateMultiWordResponseId`.

## SimpleContract Errors

SimpleContract is a legacy contract that is paid in LINK.

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

## ReputationSingleton Errors

ReputationSingleton is a legacy contract that is paid in LINK.

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

## DemoClient Errors

| Revert Message | Trigger | Meaning |
|----------------|---------|---------|
| `"already pending"` | `request()` called while `currentAggId != bytes32(0)` | A previous request is still active. Call `publish()` to clear it first. |
| `"not ready"` | `publish()` called when `getEvaluation()` returns `exists == false` and `isFailed()` returns `false` | The evaluation is still in progress, or it has passed its timeout and nobody has called `finalizeEvaluationTimeout()` on the aggregator yet. |

`request()` passes the ETH it receives on to the aggregator, so the aggregator's errors reach the caller unchanged: for example `InsufficientPayment()` when less than `quote()` was sent.

## Troubleshooting

For common integration issues and solutions, see the [Troubleshooting Guide](../troubleshooting/index.md).

For understanding how fees interact with these errors, see the [Fee Mechanisms](../advanced/fees.md) guide.
