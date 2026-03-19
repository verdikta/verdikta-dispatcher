# Error Reference

Complete reference for all custom errors and revert conditions across Verdikta Dispatcher contracts.

## ReputationAggregator Custom Errors

These errors use Solidity custom error syntax (gas-efficient, no string storage).

### Configuration Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `LengthTooShort()` | `setMaxLikelihoodLength(_len)` where `_len < 2` | The maximum likelihood array length must be at least 2 |
| `InvalidConfig()` | `setConfig(_k, _m, _n, _p, _timeout)` where `K < M`, `M < N`, `N < P`, or `P < 1` | Phase parameters must satisfy `K ≥ M ≥ N ≥ P ≥ 1` |
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
| `InactiveOracle()` | An oracle selected for polling has `isActive == false` at dispatch time | Selected oracle was deactivated between selection and dispatch |

### Fulfillment Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `AggregationComplete()` | `fulfill(...)` or `_finalizeAggregation(...)` on an already-finalized evaluation | This evaluation has already been finalized |
| `UnknownRequest()` | `fulfill(...)` with a `requestId` that maps to `aggId == bytes32(0)` | The Chainlink request ID does not belong to any known evaluation |
| `InvalidRequest()` | `fulfill(...)` with a `requestId` not in `agg.requestIds` | The request ID is not authorized for this evaluation |
| `MalformedPayload()` | `fulfill(...)` where response does not match either commit or reveal shape | Commit shape: exactly 1 element + empty CID. Reveal shape: 2+ elements + non-empty CID. |
| `RevealBeforeCommit()` | A reveal-shaped response arrives before `commitPhaseComplete == true` | The commit phase must complete (M commits received) before reveal responses are accepted |
| `NotTimedOut()` | `finalizeEvaluationTimeout(...)` before `startTimestamp + responseTimeoutSeconds` | The evaluation has not yet exceeded its timeout window |
| `NeedMoreResponses()` | Internal clustering (`_findBestClusterFromResponses`) called with fewer than 2 selected responses | At least 2 selected responses are needed for Euclidean distance clustering |
| `ArrayLengthMismatch()` | Two likelihood arrays have different lengths during `_calculateDistance()` | All oracle responses must return the same number of likelihood scores |

### Transfer Errors

| Error | Trigger | Meaning |
|-------|---------|---------|
| `FeeTransferFailed()` | `LINK.transferFrom(requester, contract, fee)` returns false during commit-phase dispatch | The LINK token transfer for the base fee failed. Check that the requester has approved sufficient LINK and has adequate balance. |
| `BonusTransferFailed()` | Bonus payment to a clustered oracle returns false during finalization | The LINK bonus transfer failed. For user-funded requests, the requester must still have sufficient LINK allowance at finalization time. |
| `LinkTransferFailed()` | `withdrawLink(...)` transfer returns false | Emergency LINK withdrawal failed |

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
| `"Fee must be greater than 0"` | `fee == 0` | A non-zero LINK fee is required for oracle registration |
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
| `"not ready"` | `publish()` called when `getEvaluation()` returns `exists == false` and `isFailed()` returns `false` | The evaluation is still in progress. Wait and try again. |

## Troubleshooting

For common integration issues and solutions, see the [Troubleshooting Guide](../troubleshooting/index.md).

For understanding how fees interact with these errors, see the [Fee Mechanisms](../advanced/fees.md) guide.
