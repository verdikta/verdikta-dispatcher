> **Warning**
> Draft — requires author review

# Security Model

Access control patterns, commit-reveal protections, known attack surfaces visible in the code, and reentrancy guards across the Verdikta Dispatcher contracts.

## Access Control

### Owner-Only Functions

All core contracts use OpenZeppelin's `Ownable` for administrative functions. The `onlyOwner` modifier restricts the following operations:

**ReputationAggregator** (inherits `Ownable`):
- `setConfig(K, M, N, P, timeout)` — phase parameters and timeout
- `setMaxOracleFee(uint256)` — oracle fee ceiling
- `setBonusMultiplier(uint256)` — bonus multiplier (0–20×)
- `setMaxLikelihoodLength(uint256)` — response array length cap
- `setResponseTimeout(uint256)` — timeout window
- `setReputationKeeper(address)` — keeper contract reference
- `setScoreDeltas(...)` — reputation score delta parameters
- `withdrawLink(address, uint256)` — emergency LINK recovery

**ReputationKeeper** (inherits `Ownable`):
- `approveContract(address)` / `removeContract(address)` — aggregator allowlist
- `setOracleActive(address, bytes32, bool)` — pause/unpause oracles
- `manualBlockOracle(address, bytes32, uint256)` — manual oracle blocking
- `resetAllReputations()` — zero all scores and unblock all oracles
- `setSlashAmount(uint256)` / `setLockDuration(uint256)` — penalty configuration
- `setSevereThreshold(int256)` / `setMildThreshold(int256)` — threshold tuning
- `setMaxScoreHistory(uint256)` / `setShortlistSize(uint256)` — selection configuration
- `setMaxScoreForSelection(uint256)` / `setMinScoreForSelection(uint256)` — score clamping
- `setVerdiktaToken(address)` — VDKA token contract address

**ReputationSingleton** (inherits `Ownable`):
- `setAlpha(uint256)` / `setMaxOracleFee(uint256)` / `setBaseFeePct(uint256)`
- `setMaxFeeBasedScalingFactor(uint256)` / `setResponseTimeout(uint256)`
- `setReputationKeeper(address)` / `setChainlinkToken(address)`
- `withdrawLink(address, uint256)`

**ArbiterOperator** (inherits `OperatorMod` which provides `onlyOwner`):
- `addReputationKeeper(address)` / `removeReputationKeeper(address)`

### Authorized Sender Pattern (ArbiterOperator)

The ArbiterOperator inherits Chainlink's `validateAuthorizedSender` modifier, which restricts `fulfillOracleRequestV()` to addresses registered as authorized senders (typically Chainlink node addresses). This is separate from the ReputationKeeper allowlist and is configured via the inherited `setAuthorizedSenders()` function.

### Approved Contract Pattern (ReputationKeeper)

Aggregator contracts must be explicitly approved via `approveContract()` before they can:
- Call `selectOracles()` — select oracles for an evaluation
- Call `recordUsedOracles()` — record which oracles were dispatched
- Call `pushEntropy()` — contribute entropy for selection randomness

Score updates via `updateScores()` additionally require that the specific oracle was previously recorded via `recordUsedOracles()` by the calling contract. This two-step authorization prevents arbitrary contracts from manipulating oracle scores.

### Oracle Registration Authorization

`registerOracle()` and `deregisterOracle()` require the caller to be either:
- The ReputationKeeper contract owner (`owner()`), OR
- The owner of the oracle contract (`IOracleOwner(_oracle).owner()`)

Additionally, `registerOracle()` validates:
- The oracle address contains deployed code (`_oracle.code.length > 0`)
- The oracle implements `IArbiterOperator` via ERC-165 (`supportsInterface(0xd9f812f9)`)
- The oracle's ReputationKeeper allowlist either includes this keeper or is empty

## Reentrancy Protection

### Contracts Using ReentrancyGuard

Both `ReputationAggregator` and `ReputationSingleton` inherit OpenZeppelin's `ReentrancyGuard`:

| Function | Contract | Protected |
|----------|----------|-----------|
| `requestAIEvaluationWithApproval()` | ReputationAggregator | `nonReentrant` |
| `fulfill()` | ReputationAggregator | `nonReentrant` |
| `finalizeEvaluationTimeout()` | ReputationAggregator | `nonReentrant` |
| `requestAIEvaluationWithApproval()` | ReputationSingleton | `nonReentrant` |
| `finalizeEvaluationTimeout()` | ReputationSingleton | `nonReentrant` |

Note: ReputationSingleton's `fulfill()` is **not** marked `nonReentrant` — it relies on Chainlink's `recordChainlinkFulfillment` modifier (which deletes the pending request, preventing replay) and the `done` flag check.

### Contracts Without ReentrancyGuard

- **SimpleContract**: No reentrancy guard. Uses `recordChainlinkFulfillment` modifier which prevents duplicate fulfillments but is not a general reentrancy guard. The `done` flag provides additional protection.
- **ReputationKeeper**: No reentrancy guard. State changes (score updates, slashing) complete before any external calls (VDKA token transfers).
- **ArbiterOperator**: Uses Chainlink's built-in request validation modifiers (`validateRequestId`, `validateAuthorizedSender`, `validateCallbackAddress`, `validateMultiWordResponseId`).

## Commit-Reveal Security

The ReputationAggregator implements a two-phase commit-reveal protocol to prevent oracle response manipulation.

### How It Works

1. **Commit phase (Mode 1):** Each oracle computes `sha256(abi.encode(oracleAddress, likelihoods[], salt))`, truncates to 128 bits (`bytes16`), and returns this hash as `response[0]`. The CID field is empty. The actual evaluation results are hidden.

2. **Reveal phase (Mode 2):** Once M commits are received, the contract sends reveal requests containing `"2:<commitHashHex>"`. Oracles respond with their actual likelihood scores and `"justificationCID:20hexSalt"`. The contract recomputes `bytes16(sha256(abi.encode(msg.sender, response, saltUint)))` and verifies it matches the stored commit.

### Protections Provided

- **Front-running prevention:** Oracles cannot see other responses during the commit phase because only hashes are visible on-chain.
- **Hash binding:** The commit hash includes `msg.sender` (the oracle's address), preventing oracles from copying another oracle's commit hash.
- **Salt uniqueness:** Each oracle uses its own random 80-bit salt, which is later mixed into the system entropy via `_updateEntropy()`.
- **Response locking:** After committing, an oracle cannot change its answer — any modification changes the hash and the reveal will be rejected (`RevealHashMismatch` event).

### Non-Reverting Reveal Rejection

Invalid reveals emit diagnostic events but do **not** revert the transaction. This allows the evaluation round to continue with other oracles rather than failing entirely. The following conditions cause silent rejection:

| Condition | Event Emitted |
|-----------|--------------|
| Hash mismatch | `RevealHashMismatch` |
| Malformed CID:salt format | `InvalidRevealFormat` |
| Too many scores (> `maxLikelihoodLength`) | `RevealTooManyScores` |
| Wrong score count (doesn't match first reveal) | `RevealWrongScoreCount` |
| Too few scores (< 2) | `RevealTooFewScores` |
| Duplicate reveal for same slot | Silently ignored (no event) |

Rejected oracles are treated as non-responders during finalization and penalized accordingly.

## Request Validation

### Pre-emission Gating (ArbiterOperator)

The ArbiterOperator's `_beforeOracleRequest()` hook calls `_approved(requester)` before the standard Chainlink `OracleRequest` event is emitted by `OperatorMod`. This prevents unauthorized requests from ever reaching oracle nodes — the event that triggers oracle job execution is never emitted for unapproved requesters.

### Double Validation

During `fulfillOracleRequestV()`, the ArbiterOperator re-checks `_approved(callbackAddress)`. This guards against the edge case where a contract is de-approved between request submission and fulfillment, preventing responses from being delivered to contracts that have lost authorization.

### Input Validation

All request entry points validate:
- CID array: non-empty, max 10 items (`MAX_CID_COUNT`), each max 100 characters (`MAX_CID_LENGTH`)
- Addendum text: max 1000 characters (`MAX_ADDENDUM_LENGTH`)
- Oracle response arrays: each score clamped to `MAX_ARBITER_RETURN_SCORE` (1e34) to prevent overflow during aggregation arithmetic

### Response Completeness Checks

During fulfillment, the contract validates:
- Payload shape distinguishes commit from reveal (1 element + empty CID vs. 2+ elements + non-empty CID)
- First reveal establishes the expected array length; all subsequent reveals must match
- CID:salt format validation via `_isValidCidSalt()` before parsing

## Gas Safety

### Minimum Consumer Gas

ArbiterOperator enforces `gasleft() >= 400,000` before making the callback to the consumer contract. This matches the Chainlink node's expected gas provision of approximately 500,000. Without this check, callbacks could silently fail due to gas exhaustion while appearing to succeed at the operator level.

### Response Length Limits

The `maxLikelihoodLength` parameter (default: 20) caps the number of scores an oracle can return, preventing gas exhaustion from excessively large arrays during aggregation.

### Score Value Clamping

Individual likelihood scores are clamped to `MAX_ARBITER_RETURN_SCORE` (1e34) to prevent overflow when scores are summed during aggregation.

## Known Attack Surfaces

### Oracle Collusion

If multiple oracles collude, they can dominate the consensus cluster and influence evaluation results. Mitigated by:
- **Random oracle selection** with entropy mixing from multiple sources
- **Commit-reveal** preventing pre-coordination on specific values (oracles cannot see each other's commits)
- **Reputation scoring** that penalizes outlier behavior over time, making sustained collusion costly
- **Cluster detection** that selects the closest P responses — colluding oracles must independently arrive at similar answers

### Block-Level Entropy Manipulation

Oracle selection uses `block.prevrandao` and `block.timestamp` which are partially predictable by validators. Mitigated by:
- **Aggregator-provided entropy** from oracle salts (not known to validators at block production time)
- **Two-slot entropy buffer** in ReputationKeeper preventing same-block manipulation
- **Selection counter** incremented per call provides additional mixing

### LINK Allowance Griefing

If a requester's LINK approval expires or is reduced between request creation and bonus payment (ReputationAggregator), the bonus transfer fails with `BonusTransferFailed()`. The evaluation still completes with valid results, but clustered oracles may not receive their bonuses. There is no mechanism to retry bonus payments.

### Oracle Registration Spam

Anyone who owns an ArbiterOperator and has 100 VDKA can register oracles. Mitigated by:
- **Stake requirement** (100 VDKA) creates economic cost per registration
- **IArbiterOperator interface check** ensures proper contract type
- **Class-based filtering** limits which oracles serve which evaluation types
- **Owner can manually block** problematic oracles via `manualBlockOracle()`

### Stale Oracle Data

If an oracle becomes inactive between selection and dispatch, the `InactiveOracle()` error reverts the entire request. There is no retry mechanism — the requester must submit a new request. During finalization, inactive oracles are skipped with an `OracleScoreUpdateSkipped` event rather than reverting.

## SimpleContract Security Limitations

The SimpleContract is intended for development/testing and has intentionally relaxed security:

- `setResponseTimeout()` has no `onlyOwner` modifier (commented as "stub")
- `withdrawLink()` has no `onlyOwner` modifier (commented as "stub")
- No `ReentrancyGuard` on any function
- Single oracle with no redundancy or consensus mechanism
- No commit-reveal — oracle responses are visible immediately

**Do not use SimpleContract for production deployments handling significant value.**

## Upgrade Considerations

None of the contracts use proxy patterns or upgradeable storage. Upgrades require deploying new contracts and re-wiring references:

- **Replace aggregator/singleton**: Deploy new contract, call `setReputationKeeper()` on it, call `approveContract(newAddress)` + `removeContract(oldAddress)` on the keeper
- **Replace keeper**: Deploy new keeper, call `approveContract()` for each aggregator, call `setReputationKeeper()` on each aggregator, re-register all oracles and re-approve all contracts
- **Replace operator**: Deploy new ArbiterOperator, call `addReputationKeeper()` on it, register new oracle identity with keeper

Oracle registrations and reputation scores live in the ReputationKeeper. Replacing the keeper requires re-registering all oracles (scores start at 0). The owner can use `resetAllReputations()` to zero scores on the existing keeper without re-registering.
