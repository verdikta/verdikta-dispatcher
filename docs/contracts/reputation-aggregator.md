# ReputationAggregator Contract

The ReputationAggregator is the most sophisticated contract in the Verdikta ecosystem, implementing a secure commit-reveal mechanism for multi-oracle AI evaluations. It provides maximum security and decentralization for high-stakes dispute resolution.

!!! note "Checked against the code"
    Revised on 2026-11-22 against [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationAggregator.sol) and against the aggregator deployed on Base mainnet at [`0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`](https://basescan.org/address/0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a). Evaluation fees are paid in ETH: the requester needs no LINK and approves no token. The numbers on this page are settings that the contract's owner can change, so each one is given with the function that returns the current value.

## Overview

The ReputationAggregator uses a two-phase polling system:

1. **Commit Phase**: K oracles are polled and each returns a hash that commits it to its answer
2. **Reveal Phase**: The first M oracles that committed are asked to reveal their actual responses
3. **Aggregation**: The first N valid reveals are compared, the P closest are clustered, and the clustered answers are averaged
4. **Payment**: Every polled oracle is credited its base fee when the request is made; the P clustered oracles are credited a bonus on top; what the requester prepaid and the round did not spend is credited back

### Configuration

The constructor sets these values and `deploy/03_config.js` sets them again after deployment. The aggregator on Base mainnet returned the same values on 2026-11-22.

| Setting | Value | Read it with |
|---------|-------|--------------|
| **K**, oracles polled in the commit phase | 6 | `commitOraclesToPoll()` |
| **M**, commits promoted to reveal | 4 | `oraclesToPoll()` |
| **N**, reveals aggregated | 3 | `requiredResponses()` |
| **P**, cluster size for the bonus | 2 | `clusterSize()` |
| **B**, bonus multiplier | 3 | `bonusMultiplier()` |
| Timeout for the whole round | 300 seconds | `responseTimeoutSeconds()` |
| Highest fee one oracle may charge | 0.0004 ETH | `maxOracleFee()` |
| Longest score array an oracle may return | 20 | `maxLikelihoodLength()` |

The aggregator on Base Sepolia (`0xe8a385E473EA710c5a88Cc72681a16a26fe380e4`) returned the same values on that date except for the timeout, which is 900 seconds there.

## Key Features

- **Commit-Reveal Security**: Prevents oracle manipulation and front-running
- **Reputation-Based Selection**: Oracles chosen based on quality and timeliness scores
- **Clustering Algorithm**: Groups similar responses to identify consensus
- **Bonus System**: Rewards oracles that provide consensus responses
- **ETH Payment with Refund**: The requester prepays a worst-case budget in ETH and is credited what the round does not spend
- **Timeout Handling**: A round that has not finished within the timeout can be closed by anyone with `finalizeEvaluationTimeout()`. It is not closed automatically

## Contract Interface

### Primary Function

```solidity
function requestAIEvaluationWithApproval(
    string[] memory cids,
    string memory addendumText,
    uint256 _alpha,
    uint256 _maxOracleFee,
    uint256 _estimatedBaseCost,
    uint256 _maxFeeBasedScalingFactor,
    uint64 _requestedClass
) public payable nonReentrant whenNotPaused returns (bytes32)
```

The function keeps its historical name. It is `payable`: the ETH that funds the round travels with the call, and there is no token approval.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cids` | `string[]` | IPFS content hashes containing evidence: 1 to 10 entries (`MAX_CID_COUNT`), each at most 100 bytes (`MAX_CID_LENGTH`) |
| `addendumText` | `string` | Additional context, at most 1000 bytes (`MAX_ADDENDUM_LENGTH`) |
| `_alpha` | `uint256` | Reputation weight (0-1000), higher values favor timeliness |
| `_maxOracleFee` | `uint256` | Highest fee you accept from one oracle, in ETH wei. A value above the contract's `maxOracleFee()` is lowered to it |
| `_estimatedBaseCost` | `uint256` | Estimated base cost for fee weighting, in ETH wei. Must be lower than the fee ceiling in effect |
| `_maxFeeBasedScalingFactor` | `uint256` | Maximum scaling factor for fee weighting (at least 1) |
| `_requestedClass` | `uint64` | Oracle class/type identifier. Only oracles registered for this class are eligible. On 2026-11-22 all 40 oracles on Base mainnet listed class 128 (the ReputationKeeper's `getOracleClasses(i)`) |

#### ETH to send

The call must be funded with `maxTotalFee(_maxOracleFee)`. The contract first uses any credit the caller already has in `ethOwed(caller)` and requires the rest as `msg.value`; if the two together are too little it reverts with `InsufficientPayment()`. ETH sent above the required amount is not lost: it is part of the round's escrow and is credited back when the round ends. See [Fee Structure](#fee-structure).

#### Returns
- `aggRequestId`: Unique identifier for tracking the aggregation request. The same value is the indexed argument of the `RequestAIEvaluation` event

### View Functions

```solidity
// Get aggregation result. hasValidData is true only for a round that completed with a result
function getEvaluation(bytes32 reqId)
    public view returns (
        uint256[] memory likelihoods,
        string memory justifications,   // comma-separated CIDs of the clustered oracles
        bool hasValidData
    )

// True once a round has been closed as failed by finalizeEvaluationTimeout()
function isFailed(bytes32 aggId) external view returns (bool)

// Worst-case ETH (wei) for one round: min(requestedMaxOracleFee, maxOracleFee) * (K + B * P)
function maxTotalFee(uint256 requestedMaxOracleFee)
    public view returns (uint256)

// ETH (wei) the contract holds for an address: oracle earnings or requester refunds
function ethOwed(address payee) external view returns (uint256)

// Phase and progress of a round
function getAggregationStatus(bytes32 aggId)
    external view returns (
        bool isComplete,
        bool failed,
        bool commitPhaseComplete,
        uint256 commitExpected,
        uint256 commitReceived,
        uint256 responseCount,
        uint256 requiredN,
        uint256 clusterP,
        address requester,
        uint256 startTimestamp
    )

// ETH accounting of a round
function getEthAccounting(bytes32 aggId)
    external view returns (
        uint256 ethReceived,
        uint256 baseCredited,
        uint256 bonusCredited,
        uint256 bonusMultiplierSnap,
        uint256 reserved
    )

// Get timeout duration
function responseTimeoutSeconds() external view returns (uint256)
```

### Withdrawals and Timeouts

```solidity
// Send the caller's whole ethOwed balance to the caller
function withdrawEth() external

// Send payee's whole ethOwed balance to payee. Callable by payee or by the contract owner
function withdrawEthFor(address payee) external

// Close a round that has passed its timeout. Callable by anyone
function finalizeEvaluationTimeout(bytes32 aggId) external
```

### Configuration Functions (Owner Only)

```solidity
// Set phase parameters and the timeout. Requires K >= M >= N >= P and P >= 2
function setConfig(uint256 _k, uint256 _m, uint256 _n, uint256 _p, uint256 _timeoutSecs) external onlyOwner

// Set response timeout
function setResponseTimeout(uint256 _seconds) external onlyOwner

// Set the highest fee (ETH wei) one oracle may charge
function setMaxOracleFee(uint256 _newMax) external onlyOwner

// Set the bonus multiplier (0 to 20)
function setBonusMultiplier(uint256 _m) external onlyOwner

// Set the longest score array an oracle may return (at least 2)
function setMaxLikelihoodLength(uint256 _len) external onlyOwner

// Set the reputation changes applied after a round
function setScoreDeltas(int8, int8, int8, int8, int8, int8, int8, int8) external onlyOwner

// Point the aggregator at another ReputationKeeper
function setReputationKeeper(address newKeeper) external onlyOwner

// Stop and resume new requests. Rounds in progress, timeouts and withdrawals keep working while paused
function pause() external onlyOwner
function unpause() external onlyOwner

// Recover LINK sent to the contract by mistake (the contract holds no LINK in normal operation)
function withdrawLink(address payable _to, uint256 _amount) external onlyOwner
```

The owner has no function that takes ETH out of the contract. The only code that sends ETH is the internal `_withdrawTo(payee)`, reached through `withdrawEth()` and `withdrawEthFor(payee)`, and it always pays the address the ETH is credited to.

## Events

```solidity
// Request initiated
event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);

// How the round was funded: from the requester's existing credit and from msg.value
event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);

// An oracle was picked for a poll slot
event OracleSelected(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address oracle, bytes32 jobId);

// Base fee credited to a polled oracle's owner at request time
event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);

// Commit received from oracle
event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash);

// Commit phase completed, moving to reveal
event CommitPhaseComplete(bytes32 indexed aggRequestId);

// Reveal request sent to oracle
event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash);

// Oracle response recorded
event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator);

// Final aggregated result
event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);

// Bonus credited to a clustered oracle's owner (amount in ETH wei)
event BonusPayment(address indexed operator, uint256 bonusFee);

// Unspent prepayment credited back to the requester
event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);

// ETH paid out of the ledger
event EthWithdrawn(address indexed payee, uint256 amount);

// Evaluation failed or timed out
event EvaluationFailed(bytes32 indexed aggRequestId, string phase);
event EvaluationTimedOut(bytes32 indexed aggRequestId);
```

The contract also emits diagnostic events for rejected reveals (`RevealHashMismatch`, `InvalidRevealFormat`, `RevealTooManyScores`, `RevealTooFewScores`, `RevealWrongScoreCount`, `RevealCidTooLong`) and `OracleScoreUpdateSkipped`. See the [Events Reference](../api/events.md).

## Usage Examples

### Basic Integration

This contract passes on the ETH it is called with, so it does not have to be funded in advance. It follows [`demoClient/contracts/DemoClient.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/demoClient/contracts/DemoClient.sol) in this repository.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass
    ) external payable returns (bytes32);

    function maxTotalFee(uint256 requestedMaxOracleFee) external view returns (uint256);
    function getEvaluation(bytes32 aggId)
        external view returns (uint256[] memory, string memory, bool);
    function isFailed(bytes32 aggId) external view returns (bool);
    function withdrawEth() external;
}

contract EvaluationClient {
    IReputationAggregator public immutable aggregator;
    address public immutable owner;

    uint256 public constant MAX_ORACLE_FEE = 15e13;   // 0.00015 ETH per oracle at most
    uint256 public constant BASE_COST      = 8e9;     // estimated base cost, below MAX_ORACLE_FEE

    mapping(bytes32 => address) public requesterOf;

    event Requested(bytes32 indexed aggId, address indexed requester);
    event Resolved(bytes32 indexed aggId, uint256[] likelihoods, string justifications);
    event Failed(bytes32 indexed aggId);

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
        owner = msg.sender;
    }

    // Worst-case ETH to send with requestEvaluation()
    function quote() external view returns (uint256) {
        return aggregator.maxTotalFee(MAX_ORACLE_FEE);
    }

    function requestEvaluation(
        string[] calldata evidenceCIDs,
        string calldata description
    ) external payable returns (bytes32 aggId) {
        // The ETH sent with this call funds the round. The aggregator reverts
        // with InsufficientPayment() if it is less than quote(), minus any
        // credit this contract already holds in the aggregator.
        aggId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidenceCIDs,
            description,
            500,              // equal weight on timeliness and quality
            MAX_ORACLE_FEE,
            BASE_COST,
            5,                // max 5x fee scaling
            128               // oracle class
        );
        requesterOf[aggId] = msg.sender;
        emit Requested(aggId, msg.sender);
    }

    function resolve(bytes32 aggId) external {
        require(requesterOf[aggId] != address(0), "Unknown request");

        (uint256[] memory likelihoods, string memory justifications, bool hasValidData) =
            aggregator.getEvaluation(aggId);

        if (hasValidData) {
            delete requesterOf[aggId];
            emit Resolved(aggId, likelihoods, justifications);
        } else if (aggregator.isFailed(aggId)) {
            // Someone called finalizeEvaluationTimeout() on the aggregator
            delete requesterOf[aggId];
            emit Failed(aggId);
        } else {
            revert("Evaluation not complete");
        }
    }

    // The aggregator sees this contract as the requester, so the unspent part
    // of every prepayment is credited to this contract. Collect it here.
    function reclaim() external {
        require(msg.sender == owner, "Not owner");
        aggregator.withdrawEth();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "Transfer failed");
    }

    // The aggregator sends the reclaimed ETH here
    receive() external payable {}
}
```

### Frontend Integration

```javascript
import { ethers } from 'ethers';

const REPUTATION_AGGREGATOR_ABI = [
    'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass) payable returns (bytes32)',
    'function maxTotalFee(uint256 requestedMaxOracleFee) view returns (uint256)',
    'function ethOwed(address payee) view returns (uint256)',
    'function responseTimeoutSeconds() view returns (uint256)',
    'function getEvaluation(bytes32 aggId) view returns (uint256[] likelihoods, string justifications, bool hasValidData)',
    'function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',
    'function isFailed(bytes32 aggId) view returns (bool)',
    'function finalizeEvaluationTimeout(bytes32 aggId)',
    'function withdrawEth()',
    'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
    'event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)',
    'event CommitPhaseComplete(bytes32 indexed aggRequestId)',
    'event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)',
    'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
    'event EvaluationFailed(bytes32 indexed aggRequestId, string phase)'
];

class VerdiktaDispatcher {
    constructor(contractAddress, signer) {
        this.signer = signer;
        this.contract = new ethers.Contract(
            contractAddress,
            REPUTATION_AGGREGATOR_ABI,
            signer
        );
    }

    // cids: IPFS CIDs of the query package(s) to evaluate
    async submitRequest(cids, description, options = {}) {
        // Highest fee accepted from one oracle, and the base cost for fee weighting (ETH wei)
        const maxFee = options.maxFee ?? ethers.parseEther("0.00015");
        const baseCost = options.baseCost ?? 8_000_000_000n;

        // Worst-case ETH for the round, less any credit already held in the aggregator
        const required = await this.contract.maxTotalFee(maxFee);
        const credit = await this.contract.ethOwed(await this.signer.getAddress());
        const value = required > credit ? required - credit : 0n;

        const args = [
            cids,
            description,
            options.alpha ?? 500,
            maxFee,
            baseCost,
            options.scalingFactor ?? 5,
            options.oracleClass ?? 128
        ];

        // Oracle selection is random, so the gas used differs from the estimate:
        // add headroom, or the transaction can run out of gas
        const estimate = await this.contract.requestAIEvaluationWithApproval.estimateGas(...args, { value });
        const gasLimit = (estimate * 150n) / 100n;

        // Submit request: the ETH travels with the call, there is nothing to approve
        const tx = await this.contract.requestAIEvaluationWithApproval(...args, { value, gasLimit });

        console.log("Transaction submitted:", tx.hash);
        const receipt = await tx.wait();

        // Extract aggregator ID from events
        const topic = this.contract.interface.getEvent("RequestAIEvaluation").topicHash;
        const event = receipt.logs.find(
            log => log.address.toLowerCase() === this.contract.target.toLowerCase()
                && log.topics[0] === topic
        );
        const aggId = event.topics[1];

        return {
            aggregatorId: aggId,
            transactionHash: tx.hash,
            blockNumber: receipt.blockNumber,
            valueSent: value
        };
    }

    async getResult(aggregatorId) {
        const [likelihoods, justifications, hasValidData] =
            await this.contract.getEvaluation(aggregatorId);

        if (hasValidData) {
            return {
                status: 'complete',
                likelihoods: likelihoods.map(l => Number(l)),
                // one CID per clustered oracle
                justificationCIDs: justifications.split(',')
            };
        }

        if (await this.contract.isFailed(aggregatorId)) {
            return { status: 'failed' };
        }

        // A round does not fail by itself: once the timeout has passed,
        // someone has to close it before isFailed() turns true
        const status = await this.contract.getAggregationStatus(aggregatorId);
        const timeout = await this.contract.responseTimeoutSeconds();
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (now >= status.startTimestamp + timeout) {
            return { status: 'timed-out' };
        }

        return { status: 'pending' };
    }

    // Close a round that has passed its timeout. Anyone may call this.
    // The unspent part of the prepayment is credited back to the requester
    async finalizeTimeout(aggregatorId) {
        const tx = await this.contract.finalizeEvaluationTimeout(aggregatorId);
        return tx.wait();
    }

    // Take the caller's credit (refunds) out of the aggregator
    async withdrawCredit() {
        const tx = await this.contract.withdrawEth();
        return tx.wait();
    }

    watchProgress(aggregatorId, callbacks = {}) {
        const filters = {
            commitReceived: this.contract.filters.CommitReceived(aggregatorId),
            commitComplete: this.contract.filters.CommitPhaseComplete(aggregatorId),
            // aggRequestId is the third argument of this event
            responseRecorded: this.contract.filters.NewOracleResponseRecorded(null, null, aggregatorId),
            fulfilled: this.contract.filters.FulfillAIEvaluation(aggregatorId),
            failed: this.contract.filters.EvaluationFailed(aggregatorId)
        };

        Object.entries(filters).forEach(([event, filter]) => {
            if (callbacks[event]) {
                this.contract.on(filter, callbacks[event]);
            }
        });

        return () => {
            Object.values(filters).forEach(filter => {
                this.contract.off(filter);
            });
        };
    }
}
```

The repository's own script for a single request is [`reputationBasedAggregator/scripts/single-query.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/scripts/single-query.js), and [`scripts/refund.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/scripts/refund.js) closes a timed-out round and withdraws the caller's credit.

## Security Considerations

### Commit-Reveal Protection
- **Front-running Prevention**: Oracles cannot see other responses during commit phase
- **Hash Verification**: A reveal is accepted only if `bytes16(sha256(abi.encode(operator, likelihoods, salt)))` equals the hash the oracle committed
- **Salt Randomization**: Each oracle uses unique salt for additional security

### Economic Security
- **Stake Requirements**: Oracles must stake 100 VDKA (`STAKE_REQUIREMENT` in the ReputationKeeper) to register
- **Penalties**: An oracle whose quality or timeliness score falls below the keeper's thresholds is locked (its stake cannot be withdrawn) for `lockDurationConfig()`, and below the severe threshold it is also left out of selection for that time and loses `slashAmountConfig()` of its stake. On Base mainnet `slashAmountConfig()` returned 0 on 2026-11-22, so no stake is taken today. See [Reputation System](../advanced/reputation.md)
- **Bonus Alignment**: Rewards encourage honest consensus participation

### Operational Security
- **Timeout Handling**: One timeout covers the whole round, commit and reveal together, counted from the request. After it, anyone can call `finalizeEvaluationTimeout()`; the round stays open until someone does
- **Reputation Tracking**: Long-term performance affects selection probability
- **Access Control**: Any address can request an evaluation from the aggregator by paying for it. What is restricted is the layer below: only aggregator contracts approved in the ReputationKeeper (`approveContract()`) can select oracles and update their scores, and an ArbiterOperator that has a keeper list accepts requests only from contracts one of those keepers has approved
- **Pause**: The owner can stop new requests with `pause()`. Rounds in progress, timeout finalization and withdrawals are not affected

## Fee Structure

Fees are paid in ETH. The requester prepays a worst-case budget and is credited what the round does not spend.

**Prepayment**, returned by `maxTotalFee(_maxOracleFee)`:

```
ceiling     = min(_maxOracleFee, maxOracleFee())
prepayment  = ceiling × (K + B × P)
```

With the current settings (K=6, B=3, P=2) the prepayment is `ceiling × 12`. At the contract's own ceiling of 0.0004 ETH that is 0.0048 ETH.

**What a round costs** depends on the fees of the oracles that were selected, not on the ceiling:

1. **Base fees**: each of the K polled oracles is credited its registered fee when the request is made (`BasePayment`). An oracle whose request could not be dispatched is not credited
2. **Bonus**: each of the P clustered oracles is credited `B ×` its registered fee when the round completes (`BonusPayment`)
3. **Refund**: the rest of the prepayment is credited to the requester (`RequesterRefunded`)

There is no separate fee for the reveal phase.

On 2026-11-22 all 40 oracles registered on Base mainnet charged 0.00002 ETH (the ReputationKeeper's `registeredOracles(i)` and `getOracleInfo(operator, jobId)` list them). At that fee:

| Outcome | Cost in oracle fees |
|---------|---------------------|
| Round completes | 6 × 0.00002 + 2 × 3 × 0.00002 = 0.00024 ETH |
| Round times out | 6 × 0.00002 = 0.00012 ETH (base fees stay with the oracles, no bonus) |

Network gas for the request transaction comes on top.

All credits are entries in the contract's `ethOwed` ledger. A requester's credit pays for that requester's next request before new ETH is asked for, or can be taken out with `withdrawEth()`. Oracle owners collect their earnings the same way.

For the full accounting see [Fee Mechanisms](../advanced/fees.md) and the [ETH payment implementation notes](../advanced/eth-payment-migration.md).

## Troubleshooting

### Common Issues

**`InsufficientPayment()`**
```javascript
// Send the worst-case amount, less the credit you already hold
const required = await contract.maxTotalFee(maxOracleFee);
const credit = await contract.ethOwed(await signer.getAddress());
const value = required > credit ? required - credit : 0n;
await contract.requestAIEvaluationWithApproval(/* ... */, { value });
```

**The request transaction runs out of gas**

Oracle selection is random, so the gas a request uses differs a little from what a wallet estimates beforehand. Estimate with `estimateGas` and add headroom (the repository's `single-query.js` adds 50%). On 2026-11-22 a request on a fork of Base mainnet used about 3.25 million gas.

**"No active oracles available with fee <= maxFee and requested class"**
- Ensure requested oracle class exists
- Check that `_maxOracleFee` is at least the fee the oracles charge
- Verify oracles aren't all locked/blocked

**"Base cost must be less than max fee"**
- `_estimatedBaseCost` must be lower than `min(_maxOracleFee, maxOracleFee())`

**The evaluation does not finish**
```javascript
// A round is not closed automatically. After the timeout, close it yourself:
// the unspent part of your prepayment is then credited back to you
const timeout = await contract.responseTimeoutSeconds();
const status = await contract.getAggregationStatus(aggregatorId);
const now = BigInt(Math.floor(Date.now() / 1000));
if (!status.isComplete && now >= status.startTimestamp + timeout) {
    await (await contract.finalizeEvaluationTimeout(aggregatorId)).wait();
}
```

### Error Codes

The aggregator uses custom errors:

| Error | Cause | Solution |
|-------|-------|----------|
| `EmptyCIDList()` | No evidence provided | Include at least one IPFS hash |
| `TooManyCIDs()` | > 10 evidence files | Combine evidence or split requests |
| `CIDTooLong()` | Individual CID > 100 bytes | Use valid IPFS hashes |
| `AddendumTooLong()` | Description > 1000 bytes | Shorten description |
| `InsufficientPayment()` | `msg.value` plus the caller's credit is below `maxTotalFee(_maxOracleFee)` | Send the missing ETH |
| `NotTimedOut()` | `finalizeEvaluationTimeout()` called before the timeout | Wait until `startTimestamp + responseTimeoutSeconds()` |
| `AggregationComplete()` | The round is already closed | Read the result with `getEvaluation()` |
| `UnknownRequest()` | No round exists for this ID | Check the request ID |
| `NothingOwed()` | `withdrawEth()` with no credit | Nothing to withdraw |
| `EnforcedPause()` | New requests are paused by the owner | Try again after `unpause()` |
| `InvalidConfig()` | Owner passed values to `setConfig()` that break K >= M >= N >= P >= 2 | Use valid K,M,N,P values |

## Best Practices

1. **Size the prepayment with `maxTotalFee()`** before submitting requests, and count your existing `ethOwed` credit
2. **Monitor events** to track progress
3. **Handle timeouts yourself**: call `finalizeEvaluationTimeout()` once the timeout has passed, or your prepayment stays reserved in the round
4. **Use appropriate alpha values** based on use case priority
5. **Handle both success and failure cases** in your application
6. **Withdraw or reuse your credit**: refunds stay in the contract until you call `withdrawEth()` or make another request
7. **Cache IPFS content** for better user experience
8. **Implement retry logic** for network failures
