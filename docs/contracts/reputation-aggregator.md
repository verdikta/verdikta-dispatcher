# ReputationAggregator Contract

The ReputationAggregator is the most sophisticated contract in the Verdikta ecosystem, implementing a secure commit-reveal mechanism for multi-oracle AI evaluations. It provides maximum security and decentralization for high-stakes dispute resolution.

## Overview

The ReputationAggregator uses a two-phase polling system:

1. **Commit Phase**: K oracles submit encrypted commitments
2. **Reveal Phase**: First M oracles that committed are asked to reveal their actual responses
3. **Aggregation**: First N valid reveals are clustered and aggregated
4. **Bonus Distribution**: Oracles in the best cluster receive bonus payments

### Default Configuration
- **K** = 5 (oracles polled in commit phase)
- **M** = 4 (commits promoted to reveal)
- **N** = 3 (reveals required for aggregation)
- **P** = 2 (cluster size for bonus)
- **B** = 3 (bonus multiplier)

## Key Features

- **Commit-Reveal Security**: Prevents oracle manipulation and front-running
- **Reputation-Based Selection**: Oracles chosen based on quality and timeliness scores
- **Clustering Algorithm**: Groups similar responses to identify consensus
- **Bonus System**: Rewards oracles that provide consensus responses
- **Timeout Handling**: Automatic finalization when oracles fail to respond

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
) external returns (bytes32 aggRequestId)
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cids` | `string[]` | IPFS content hashes containing evidence |
| `addendumText` | `string` | Additional context (max 1000 chars) |
| `_alpha` | `uint256` | Reputation weight (0-1000), higher values favor timeliness |
| `_maxOracleFee` | `uint256` | Maximum fee willing to pay per oracle (in LINK) |
| `_estimatedBaseCost` | `uint256` | Estimated base cost for fee calculations |
| `_maxFeeBasedScalingFactor` | `uint256` | Maximum scaling factor for fee weighting |
| `_requestedClass` | `uint64` | Oracle class/type identifier |

#### Returns
- `aggRequestId`: Unique identifier for tracking the aggregation request

### View Functions

```solidity
// Get aggregation result
function getEvaluation(bytes32 aggId) 
    external view returns (
        uint256[] memory likelihoods,
        string memory justificationCID,
        bool exists
    )

// Check maximum total fee required
function maxTotalFee(uint256 requestedMaxOracleFee) 
    external view returns (uint256)

// Get timeout duration
function responseTimeoutSeconds() external view returns (uint256)
```

### Configuration Functions (Owner Only)

```solidity
// Set phase parameters (K, M, N, P)
function setPhaseCounts(uint256 _k, uint256 _m, uint256 _n, uint256 _p) external onlyOwner

// Set response timeout
function setResponseTimeout(uint256 _seconds) external onlyOwner

// Set reputation weight range
function setAlpha(uint256 _alpha) external onlyOwner

// Set maximum oracle fee
function setMaxOracleFee(uint256 _newMax) external onlyOwner
```

## Events

```solidity
// Request initiated
event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);

// Commit received from oracle
event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash);

// Commit phase completed, moving to reveal
event CommitPhaseComplete(bytes32 indexed aggRequestId);

// Reveal request sent to oracle
event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash);

// Oracle response recorded
event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, address operator);

// Final aggregated result
event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);

// Bonus payment to clustered oracle
event BonusPayment(address indexed operator, uint256 bonusFee);

// Evaluation failed or timed out
event EvaluationFailed(bytes32 indexed aggRequestId, string phase);
event EvaluationTimedOut(bytes32 indexed aggRequestId);
```

## Usage Examples

### Basic Integration

```solidity
pragma solidity ^0.8.21;

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) external returns (bytes32);
    
    function getEvaluation(bytes32 aggId) 
        external view returns (uint256[] memory, string memory, bool);
}

contract DisputeResolution {
    IReputationAggregator public aggregator;
    IERC20 public linkToken;
    
    struct Dispute {
        bytes32 aggregatorId;
        address plaintiff;
        address defendant;
        uint256 amount;
        bool resolved;
    }
    
    mapping(bytes32 => Dispute) public disputes;
    
    constructor(address _aggregator, address _linkToken) {
        aggregator = IReputationAggregator(_aggregator);
        linkToken = IERC20(_linkToken);
    }
    
    function createDispute(
        string[] memory evidenceCIDs,
        string memory description,
        address defendant
    ) external payable returns (bytes32) {
        // Approve LINK tokens for aggregator
        uint256 maxFee = 0.5 ether; // 0.5 LINK maximum
        linkToken.approve(address(aggregator), maxFee);
        
        // Request AI evaluation
        bytes32 aggId = aggregator.requestAIEvaluationWithApproval(
            evidenceCIDs,
            description,
            500,        // 50% weight on timeliness vs quality
            0.1 ether,  // max 0.1 LINK per oracle
            0.01 ether, // estimated base cost
            5,          // max 5x fee scaling
            1           // standard dispute class
        );
        
        // Store dispute
        disputes[aggId] = Dispute({
            aggregatorId: aggId,
            plaintiff: msg.sender,
            defendant: defendant,
            amount: msg.value,
            resolved: false
        });
        
        return aggId;
    }
    
    function resolveDispute(bytes32 aggregatorId) external {
        Dispute storage dispute = disputes[aggregatorId];
        require(!dispute.resolved, "Already resolved");
        
        (uint256[] memory likelihoods, string memory justification, bool exists) = 
            aggregator.getEvaluation(aggregatorId);
        
        require(exists, "Evaluation not complete");
        
        // Resolve based on first likelihood score
        if (likelihoods[0] > 500) { // > 50% likelihood favoring plaintiff
            payable(dispute.plaintiff).transfer(dispute.amount);
        } else {
            payable(dispute.defendant).transfer(dispute.amount);
        }
        
        dispute.resolved = true;
    }
}
```

### Frontend Integration

```javascript
import { ethers } from 'ethers';

class VerdiktaDispatcher {
    constructor(contractAddress, signer) {
        this.contract = new ethers.Contract(
            contractAddress,
            REPUTATION_AGGREGATOR_ABI,
            signer
        );
    }
    
    async submitDispute(evidenceFiles, description, options = {}) {
        try {
            // Upload evidence to IPFS and get CIDs
            const cids = await Promise.all(
                evidenceFiles.map(file => this.uploadToIPFS(file))
            );
            
            // Get fee estimate
            const maxFee = options.maxFee || ethers.parseEther("0.1");
            const totalFee = await this.contract.maxTotalFee(maxFee);
            
            // Approve LINK tokens
            const linkToken = new ethers.Contract(
                LINK_TOKEN_ADDRESS,
                LINK_ABI,
                this.contract.signer
            );
            
            await linkToken.approve(this.contract.target, totalFee);
            
            // Submit request
            const tx = await this.contract.requestAIEvaluationWithApproval(
                cids,
                description,
                options.alpha || 500,
                maxFee,
                options.baseCost || ethers.parseEther("0.01"),
                options.scalingFactor || 5,
                options.oracleClass || 1
            );
            
            console.log("Transaction submitted:", tx.hash);
            const receipt = await tx.wait();
            
            // Extract aggregator ID from events
            const event = receipt.logs.find(
                log => log.topics[0] === this.contract.interface.getEvent("RequestAIEvaluation").topicHash
            );
            const aggId = event.topics[1];
            
            return {
                aggregatorId: aggId,
                transactionHash: tx.hash,
                blockNumber: receipt.blockNumber
            };
            
        } catch (error) {
            console.error("Failed to submit dispute:", error);
            throw error;
        }
    }
    
    async getResult(aggregatorId) {
        const [likelihoods, justificationCID, exists] = 
            await this.contract.getEvaluation(aggregatorId);
            
        if (!exists) {
            return { status: 'pending' };
        }
        
        return {
            status: 'complete',
            likelihoods: likelihoods.map(l => Number(l)),
            justificationCID,
            justification: await this.fetchFromIPFS(justificationCID)
        };
    }
    
    watchProgress(aggregatorId, callbacks = {}) {
        const filters = {
            commitReceived: this.contract.filters.CommitReceived(aggregatorId),
            commitComplete: this.contract.filters.CommitPhaseComplete(aggregatorId),
            responseRecorded: this.contract.filters.NewOracleResponseRecorded(),
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

## Security Considerations

### Commit-Reveal Protection
- **Front-running Prevention**: Oracles cannot see other responses during commit phase
- **Hash Verification**: Reveals must match committed hashes exactly
- **Salt Randomization**: Each oracle uses unique salt for additional security

### Economic Security
- **Stake Requirements**: Oracles must stake VDKA tokens to participate
- **Slashing Mechanism**: Poor performance results in stake reduction
- **Bonus Alignment**: Rewards encourage honest consensus participation

### Operational Security
- **Timeout Handling**: Automatic progression when oracles fail to respond
- **Reputation Tracking**: Long-term performance affects selection probability
- **Access Control**: Only approved contracts can request evaluations

## Fee Structure

The total cost for a ReputationAggregator request includes:

1. **Base Fees**: K × oracle_fee (for commit phase)
2. **Reveal Fees**: M × oracle_fee (for reveal phase) 
3. **Bonus Pool**: P × bonus_multiplier × oracle_fee

**Maximum Total**: `fee × (K + M + P × bonus_multiplier)`

With default settings (K=5, M=4, P=2, B=3):
- **Maximum**: `fee × (5 + 4 + 2 × 3) = fee × 15`
- **Typical**: Much lower as not all oracles receive bonuses

## Troubleshooting

### Common Issues

**"Insufficient LINK tokens"**
```javascript
// Check required amount first
const totalFee = await contract.maxTotalFee(maxOracleFee);
await linkToken.approve(contractAddress, totalFee);
```

**"No active oracles available"**
- Ensure requested oracle class exists
- Check if maxOracleFee is sufficient
- Verify oracles aren't all locked/blocked

**"Evaluation timed out"**
```javascript
// Monitor timeout and handle gracefully
const timeout = await contract.responseTimeoutSeconds();
setTimeout(() => {
    contract.finalizeEvaluationTimeout(aggregatorId);
}, timeout * 1000);
```

### Error Codes

| Error | Cause | Solution |
|-------|-------|----------|
| `Empty CID list` | No evidence provided | Include at least one IPFS hash |
| `Too many CIDs` | > 10 evidence files | Combine evidence or split requests |
| `CID too long` | Individual CID > 100 chars | Use valid IPFS hashes |
| `Addendum too long` | Description > 1000 chars | Shorten description |
| `K must be >= M` | Invalid phase configuration | Use valid K,M,N,P values |

## Best Practices

1. **Always check fee requirements** before submitting requests
2. **Monitor events** to track progress and handle timeouts
3. **Use appropriate alpha values** based on use case priority
4. **Handle both success and failure cases** in your application
5. **Cache IPFS content** for better user experience
6. **Implement retry logic** for network failures 