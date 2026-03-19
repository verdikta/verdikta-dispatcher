# Events Reference

Complete reference for all events emitted by Verdikta Dispatcher contracts. Events are grouped by contract and listed in the order they typically fire during a request lifecycle.

## ReputationAggregator Events

### RequestAIEvaluation

Emitted when a new commit-reveal evaluation request is created.

```solidity
event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Unique aggregator request identifier, derived from `keccak256(timestamp, sender, cidPayload, requestCounter)` |
| `cids` | `string[]` | No | Array of IPFS CIDs containing evidence to evaluate |

**When it fires:** Once per call to `requestAIEvaluationWithApproval()`, after all K oracles have been dispatched.

### OracleSelected

Emitted for every oracle chosen for a poll slot during request creation.

```solidity
event OracleSelected(
    bytes32 indexed aggRequestId,
    uint256 indexed pollIndex,
    address oracle,
    bytes32 jobId
);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |
| `pollIndex` | `uint256` | Yes | Zero-based slot number (0 to K−1) |
| `oracle` | `address` | No | Oracle operator address |
| `jobId` | `bytes32` | No | Job ID used for this request |

**When it fires:** K times per request (default 6), once per selected oracle. Fires before `RequestAIEvaluation`.

### CommitReceived

Emitted when an oracle submits a commit hash during the commit phase.

```solidity
event CommitReceived(
    bytes32 indexed aggRequestId,
    uint256 pollIndex,
    address operator,
    bytes16 commitHash
);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |
| `pollIndex` | `uint256` | No | Oracle's slot index in the polling array |
| `operator` | `address` | No | Address of the oracle operator (`msg.sender` of the fulfillment) |
| `commitHash` | `bytes16` | No | 128-bit hash of the oracle's commitment: `bytes16(bytes32(response[0] << 128))` |

**When it fires:** Each time an oracle calls back with a Mode 1 (commit) response. Also fires for late commits that arrive after the commit phase has completed (these are logged but otherwise ignored).

### CommitPhaseComplete

Emitted when the required number of commits (M) have been received, transitioning the evaluation to the reveal phase.

```solidity
event CommitPhaseComplete(bytes32 indexed aggRequestId);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |

**When it fires:** Once, when `commitReceived == oraclesToPoll` (M). Can also fire during `finalizeEvaluationTimeout()` if enough commits (≥ M) exist at timeout.

### RevealRequestDispatched

Emitted when a Mode 2 (reveal) request is sent to an oracle that successfully committed.

```solidity
event RevealRequestDispatched(
    bytes32 indexed aggRequestId,
    uint256 pollIndex,
    bytes16 commitHash
);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |
| `pollIndex` | `uint256` | No | Oracle's slot index |
| `commitHash` | `bytes16` | No | The commit hash the oracle is being asked to reveal |

**When it fires:** Once per oracle that committed (skipping slots with no commit), immediately after `CommitPhaseComplete`. The reveal request payload is `"2:<commitHashHex>"`.

### NewOracleResponseRecorded

Emitted when an oracle provides a valid reveal response that passes all validation (hash match, format check, array length check).

```solidity
event NewOracleResponseRecorded(
    bytes32 requestId,
    uint256 pollIndex,
    bytes32 indexed aggRequestId,
    address operator
);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `requestId` | `bytes32` | No | Chainlink request identifier (the reveal-phase request ID) |
| `pollIndex` | `uint256` | No | Oracle's slot index |
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |
| `operator` | `address` | No | Address of the oracle operator |

**When it fires:** Each time a valid reveal is accepted and stored. Does not fire for rejected reveals (hash mismatch, format error, etc.).

### FulfillAIEvaluation

Emitted when the aggregation is complete and final results are available.

```solidity
event FulfillAIEvaluation(
    bytes32 indexed aggRequestId,
    uint256[] aggregated,
    string justifications
);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |
| `aggregated` | `uint256[]` | No | Final aggregated likelihood scores — the arithmetic mean of clustered oracles' scores per dimension |
| `justifications` | `string` | No | Comma-separated IPFS CIDs of justifications from clustered oracles only |

**When it fires:** Once, when N reveals have been received and `_finalizeAggregation()` completes successfully.

### BonusPayment

Emitted when bonus LINK is paid to a clustered oracle.

```solidity
event BonusPayment(address indexed operator, uint256 bonusFee);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `operator` | `address` | Yes | Oracle operator receiving the bonus |
| `bonusFee` | `uint256` | No | Amount of bonus LINK paid: `pollFees[slot] × bonusMultiplier` |

**When it fires:** Once per clustered oracle (up to P times, default 2) during `_finalizeAggregation()`.

### EvaluationTimedOut

Emitted when an evaluation exceeds the response timeout.

```solidity
event EvaluationTimedOut(bytes32 indexed aggRequestId);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |

**When it fires:** When `finalizeEvaluationTimeout()` is called after the timeout window expires and the evaluation cannot be completed normally.

### EvaluationFailed

Emitted when an evaluation fails during a specific phase.

```solidity
event EvaluationFailed(bytes32 indexed aggRequestId, string phase);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `aggRequestId` | `bytes32` | Yes | Aggregator request identifier |
| `phase` | `string` | No | Phase where failure occurred: `"commit"` (fewer than M commits) or `"reveal"` (fewer than N reveals) |

**When it fires:** Immediately after `EvaluationTimedOut` when insufficient responses prevent completion.

### Reveal Validation Events

These events fire when an oracle's reveal is rejected for a specific reason. The transaction does **not** revert — the oracle is treated as a non-responder, allowing the round to continue with other oracles.

#### RevealHashMismatch

```solidity
event RevealHashMismatch(
    bytes32 indexed aggRequestId,
    uint256 indexed pollIndex,
    address operator,
    bytes16 expectedHash,
    bytes16 gotHash
);
```

**When it fires:** The `sha256(abi.encode(msg.sender, response, saltUint))` recomputed from the reveal does not match the stored commit hash. Possible causes: oracle changed its response between commit and reveal, or salt was corrupted.

#### InvalidRevealFormat

```solidity
event InvalidRevealFormat(
    bytes32 indexed aggRequestId,
    uint256 indexed pollIndex,
    address operator,
    string badCid
);
```

**When it fires:** The CID string does not match the expected `"justificationCID:20hexSalt"` format. The validator checks: minimum length > 21, last colon separates exactly 20 hex characters.

#### RevealTooManyScores

```solidity
event RevealTooManyScores(
    bytes32 indexed aggRequestId,
    uint256 indexed pollIndex,
    address operator,
    uint256 responseLength,
    uint256 maxAllowed
);
```

**When it fires:** `response.length > maxLikelihoodLength` (default 20). Prevents gas exhaustion from oversized payloads.

#### RevealWrongScoreCount

```solidity
event RevealWrongScoreCount(
    bytes32 indexed aggRequestId,
    uint256 indexed pollIndex,
    address operator,
    uint256 responseLength,
    uint256 expectedLength
);
```

**When it fires:** `response.length` does not match the length established by the first accepted reveal in this round. All reveals in a round must have the same number of scores.

#### RevealTooFewScores

```solidity
event RevealTooFewScores(
    bytes32 indexed aggRequestId,
    uint256 indexed pollIndex,
    address operator,
    uint256 responseLength
);
```

**When it fires:** `response.length < 2`. A valid evaluation requires at least 2 likelihood scores.

### Administrative Events

#### ReputationKeeperChanged

```solidity
event ReputationKeeperChanged(address indexed oldKeeper, address indexed newKeeper);
```

**When it fires:** When the owner calls `setReputationKeeper(newAddress)`.

#### ScoreDeltasUpdated

```solidity
event ScoreDeltasUpdated(
    int8 clusteredTimeliness, int8 clusteredQuality,
    int8 selectedTimeliness,  int8 selectedQuality,
    int8 revealedTimeliness,  int8 revealedQuality,
    int8 committedTimeliness, int8 committedQuality
);
```

**When it fires:** When the owner calls `setScoreDeltas(...)` to update the reputation scoring parameters.

#### OracleScoreUpdateSkipped

```solidity
event OracleScoreUpdateSkipped(address oracle, bytes32 jobId, string reason);
```

**When it fires:** During finalization when a `try/catch` around `reputationKeeper.updateScores()` catches a revert. The `reason` string indicates the context:
- `"Inactive at finalization"` — oracle became inactive between dispatch and finalization
- `"updateScores failed for clustered selected response"` — score update reverted for a clustered oracle
- `"updateScores failed for non-clustered selected response"` — score update reverted for a selected-but-not-clustered oracle
- `"updateScores failed for responded but not selected"` — score update reverted for a revealed-but-not-selected oracle
- `"updateScores failed for no response"` — score update reverted for a non-responding oracle
- `"timeout penalty"` — score update reverted during timeout penalty application

## ReputationKeeper Events

### OracleRegistered

```solidity
event OracleRegistered(address indexed oracle, bytes32 jobId, uint256 fee);
```

**When it fires:** When `registerOracle()` successfully stakes VDKA and records the oracle.

### OracleDeregistered

```solidity
event OracleDeregistered(address indexed oracle, bytes32 jobId);
```

**When it fires:** When `deregisterOracle()` removes the oracle record and refunds the stake.

### ScoreUpdated

```solidity
event ScoreUpdated(address indexed oracle, int256 newQualityScore, int256 newTimelinessScore);
```

**When it fires:** After every `updateScores()` call, reflecting the oracle's new cumulative scores. This fires even when slashing or blocking also occurs — it always shows the latest state.

### OracleSlashed

```solidity
event OracleSlashed(
    address indexed oracle,
    bytes32 jobId,
    uint256 slashAmount,
    uint256 lockedUntil,
    bool blocked
);
```

| Parameter | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `oracle` | `address` | Yes | Slashed oracle's operator address |
| `jobId` | `bytes32` | No | Job identifier |
| `slashAmount` | `uint256` | No | VDKA tokens slashed (0 for mild threshold, `slashAmountConfig` for severe or consistent degradation) |
| `lockedUntil` | `uint256` | No | Timestamp until which the oracle is locked |
| `blocked` | `bool` | No | `true` for severe threshold or consistent degradation; `false` for mild threshold |

**When it fires:** When `updateScores()` triggers a penalty. Three scenarios:
1. **Severe threshold** — quality or timeliness score drops below `severeThreshold` (default −900)
2. **Mild threshold** — quality or timeliness score drops below `mildThreshold` (default −300) but above severe
3. **Consistent degradation** — score history buffer is full (25 entries) and every entry is worse than the previous on at least one dimension

### ContractApproved / ContractRemoved

```solidity
event ContractApproved(address indexed contractAddress);
event ContractRemoved(address indexed contractAddress);
```

**When they fire:** When the owner calls `approveContract()` or `removeContract()` to manage the aggregator allowlist.

### OracleActiveStatusUpdated

```solidity
event OracleActiveStatusUpdated(address indexed oracle, bytes32 jobId, bool isActive);
```

**When it fires:** When the owner calls `setOracleActive()` to pause (`false`) or unpause (`true`) an oracle.

### EntropyPushed

```solidity
event EntropyPushed(bytes16 entropy, uint256 blockNumber);
```

**When it fires:** When an approved aggregator calls `pushEntropy()` and `block.number > entropyBlock` (at most once per block). The entropy is mixed into the selection randomness for future oracle selections.

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

## SimpleContract Events

### RequestAIEvaluation

```solidity
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
```

**When it fires:** Once per call to `requestAIEvaluationWithApproval()`.

### FulfillmentReceived

```solidity
event FulfillmentReceived(bytes32 indexed requestId, address caller, uint256 len, string justificationCID);
```

**When it fires:** At the beginning of `fulfill()`, before validation. A debugging event that shows the raw callback data including the caller address and array length.

### FulfillAIEvaluation

```solidity
event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
```

**When it fires:** After successful fulfillment and bonus payment.

### BonusPaid

```solidity
event BonusPaid(bytes32 indexed requestId, address oracle, uint256 amount);
```

**When it fires:** When the bonus LINK is successfully transferred from the requester to the oracle during `fulfill()`. Amount equals the contract's configured `fee`.

### EvaluationFailed

```solidity
event EvaluationFailed(bytes32 indexed requestId);
```

**When it fires:** When `finalizeEvaluationTimeout()` marks a request as timed out.

## ReputationSingleton Events

### RequestAIEvaluation

```solidity
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
```

**When it fires:** Once per call to `requestAIEvaluationWithApproval()`.

### EvaluationFulfilled

```solidity
event EvaluationFulfilled(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
```

**When it fires:** After successful fulfillment and bonus payment. Note the event name: `EvaluationFulfilled` (not `FulfillAIEvaluation`).

### BonusPaid

```solidity
event BonusPaid(bytes32 indexed requestId, address oracle, uint256 amount);
```

**When it fires:** When the bonus LINK (equal to `feeUsed`) is transferred from the contract's balance to the oracle during `fulfill()`.

### EvaluationFailed

```solidity
event EvaluationFailed(bytes32 indexed requestId);
```

**When it fires:** When `finalizeEvaluationTimeout()` marks a request as timed out.

## Event Lifecycle: Complete Request Flow

### ReputationAggregator (commit-reveal)

```
1. OracleSelected (× K)            — oracles chosen for polling
2. RequestAIEvaluation              — request created
3. CommitReceived (× up to K)       — oracles submit hashes
4. CommitPhaseComplete              — M commits received, transition to reveal
5. RevealRequestDispatched (× M)    — reveal requests sent to committed oracles
6. NewOracleResponseRecorded (× N)  — valid reveals accepted
7. BonusPayment (× P)              — clustered oracles paid
8. FulfillAIEvaluation             — final aggregated result

On timeout:
   EvaluationTimedOut + EvaluationFailed("commit" | "reveal")

On invalid reveal:
   RevealHashMismatch | InvalidRevealFormat | RevealTooManyScores |
   RevealWrongScoreCount | RevealTooFewScores
```

### ReputationSingleton

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

// Listen for new evaluation results (ReputationAggregator)
contract.on("FulfillAIEvaluation", (aggRequestId, aggregated, justifications) => {
    console.log("Evaluation complete:", {
        aggRequestId,
        scores: aggregated.map(s => s.toString()),
        justifications
    });
});

// Filter by specific request
const filter = contract.filters.CommitReceived(myAggRequestId);
contract.on(filter, (aggRequestId, pollIndex, operator, commitHash) => {
    console.log(`Commit ${pollIndex} received from ${operator}`);
});

// One-shot listener for a specific fulfillment
const fulfillFilter = contract.filters.FulfillAIEvaluation(myRequestId);
contract.once(fulfillFilter, (aggRequestId, likelihoods, justificationCid) => {
    console.log("Got result:", likelihoods.map(l => l.toString()));
});
```

For understanding what triggers each error condition, see the [Error Reference](errors.md). For the full fee flow associated with `BonusPayment` events, see [Fee Mechanisms](../advanced/fees.md).
