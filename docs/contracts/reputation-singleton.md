# ReputationSingleton Contract

The ReputationSingleton provides a simplified, single-oracle interface for quick AI evaluations. It offers the same frontend compatibility as the multi-oracle ReputationAggregator but with faster response times and lower costs for simpler use cases.

## Overview

The ReputationSingleton is designed for scenarios where:
- **Speed is prioritized** over maximum security
- **Cost efficiency** is important
- **Simple disputes** don't require multiple oracle consensus
- **Development and testing** need a lightweight solution

## Key Features

- **Single Oracle Selection**: Uses ReputationKeeper to select the best available oracle
- **Bonus Payment System**: Pays 1× fee bonus to oracle on successful completion
- **Frontend Compatibility**: Identical interface to ReputationAggregator
- **Timeout Handling**: Automatic failure detection and handling
- **Reputation Integration**: Fully integrated with the reputation system

## Contract Interface

### Primary Function

```solidity
function requestAIEvaluationWithApproval(
    string[] calldata cids,
    string calldata addendumText,
    uint256 _alpha,
    uint256 _maxOracleFee,
    uint256 _estimatedBaseCost,
    uint256 _maxFeeBasedScalingFactor,
    uint64 _requestedClass
) external returns (bytes32 requestId)
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cids` | `string[]` | IPFS content hashes containing evidence (max 10) |
| `addendumText` | `string` | Additional context (max 1000 chars) |
| `_alpha` | `uint256` | Reputation weight (0-1000), higher values favor timeliness |
| `_maxOracleFee` | `uint256` | Maximum fee willing to pay (in LINK) |
| `_estimatedBaseCost` | `uint256` | Estimated base cost for fee calculations |
| `_maxFeeBasedScalingFactor` | `uint256` | Maximum scaling factor for fee weighting |
| `_requestedClass` | `uint64` | Oracle class/type identifier |

#### Returns
- `requestId`: Unique identifier for tracking the request

### View Functions

```solidity
// Get evaluation result (compatible with ReputationAggregator)
function getEvaluation(bytes32 id)
    external view returns (
        uint256[] memory likelihoods,
        string memory justificationCID,
        bool exists
    )

// Calculate maximum total fee (base + bonus)
function maxTotalFee(uint256 requested) 
    external view returns (uint256)

// Get contract configuration
function getContractConfig()
    external view returns (
        address oracleAddr,  // Returns address(0) - no fixed oracle
        address linkAddr,
        bytes32 jobId,       // Returns bytes32(0) - dynamic selection
        uint256 fee          // Returns 0 - dynamic fees
    )

// Check if request failed due to timeout
function isFailed(bytes32 requestId) external view returns (bool)
```

### Configuration Functions (Owner Only)

```solidity
// Set reputation weight for oracle selection
function setAlpha(uint256 _alpha) external onlyOwner

// Set maximum oracle fee ceiling
function setMaxOracleFee(uint256 fee) external onlyOwner

// Set base fee percentage
function setBaseFeePct(uint256 percent) external onlyOwner

// Set response timeout
function setResponseTimeout(uint256 seconds) external onlyOwner

// Set ReputationKeeper contract
function setReputationKeeper(address keeper) external onlyOwner
```

## Events

```solidity
// Request submitted
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);

// Evaluation completed successfully
event EvaluationFulfilled(
    bytes32 indexed requestId,
    uint256[] likelihoods,
    string justificationCID
);

// Evaluation failed (timeout or error)
event EvaluationFailed(bytes32 indexed requestId);

// Bonus payment to oracle
event BonusPaid(
    bytes32 indexed requestId,
    address oracle,
    uint256 amount
);
```

## Usage Examples

### Basic Integration

```solidity
pragma solidity ^0.8.21;

interface IReputationSingleton {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendumText,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) external returns (bytes32);
    
    function getEvaluation(bytes32 id) 
        external view returns (uint256[] memory, string memory, bool);
}

contract QuickDispute {
    IReputationSingleton public singleton;
    IERC20 public linkToken;
    
    struct SimpleDispute {
        bytes32 requestId;
        address claimer;
        address opponent;
        uint256 stake;
        bool resolved;
        uint256 deadline;
    }
    
    mapping(bytes32 => SimpleDispute) public disputes;
    uint256 public constant DISPUTE_TIMEOUT = 1 hours;
    
    constructor(address _singleton, address _linkToken) {
        singleton = IReputationSingleton(_singleton);
        linkToken = IERC20(_linkToken);
    }
    
    function createQuickDispute(
        string[] memory evidenceCIDs,
        string memory description,
        address opponent
    ) external payable returns (bytes32) {
        require(msg.value > 0, "Must stake ETH");
        
        // Calculate and approve LINK fees (base + bonus)
        uint256 maxFee = 0.05 ether; // 0.05 LINK
        uint256 totalFee = singleton.maxTotalFee(maxFee);
        linkToken.transferFrom(msg.sender, address(this), totalFee);
        linkToken.approve(address(singleton), totalFee);
        
        // Submit evaluation request
        bytes32 requestId = singleton.requestAIEvaluationWithApproval(
            evidenceCIDs,
            description,
            600,        // Favor timeliness for quick disputes
            maxFee,
            0.005 ether, // Low base cost
            3,          // Moderate scaling
            1           // Standard dispute class
        );
        
        // Store dispute
        disputes[requestId] = SimpleDispute({
            requestId: requestId,
            claimer: msg.sender,
            opponent: opponent,
            stake: msg.value,
            resolved: false,
            deadline: block.timestamp + DISPUTE_TIMEOUT
        });
        
        return requestId;
    }
    
    function resolveDispute(bytes32 requestId) external {
        SimpleDispute storage dispute = disputes[requestId];
        require(!dispute.resolved, "Already resolved");
        require(block.timestamp <= dispute.deadline, "Dispute expired");
        
        (uint256[] memory likelihoods, , bool exists) = 
            singleton.getEvaluation(requestId);
        
        require(exists, "Evaluation not complete");
        
        // Simple resolution: first likelihood > 50% favors claimer
        address winner = likelihoods[0] > 500 ? 
            dispute.claimer : dispute.opponent;
            
        payable(winner).transfer(dispute.stake);
        dispute.resolved = true;
    }
    
    function claimTimeout(bytes32 requestId) external {
        SimpleDispute storage dispute = disputes[requestId];
        require(!dispute.resolved, "Already resolved");
        require(block.timestamp > dispute.deadline, "Not expired");
        
        // Return stake to claimer if evaluation failed
        if (singleton.isFailed(requestId)) {
            payable(dispute.claimer).transfer(dispute.stake);
        } else {
            // If evaluation succeeded but wasn't claimed, split stake
            uint256 half = dispute.stake / 2;
            payable(dispute.claimer).transfer(half);
            payable(dispute.opponent).transfer(half);
        }
        
        dispute.resolved = true;
    }
}
```

### Frontend Integration

```javascript
import { ethers } from 'ethers';

class QuickEvaluator {
    constructor(contractAddress, signer) {
        this.contract = new ethers.Contract(
            contractAddress,
            REPUTATION_SINGLETON_ABI,
            signer
        );
        this.linkToken = new ethers.Contract(
            LINK_TOKEN_ADDRESS,
            LINK_ABI,
            signer
        );
    }
    
    async submitQuickEvaluation(evidenceFiles, description, options = {}) {
        try {
            // Upload evidence to IPFS
            const cids = await Promise.all(
                evidenceFiles.map(file => this.uploadToIPFS(file))
            );
            
            // Configure request parameters
            const params = {
                alpha: options.prioritizeSpeed ? 800 : 500,
                maxFee: options.maxFee || ethers.parseEther("0.05"),
                baseCost: options.baseCost || ethers.parseEther("0.005"),
                scalingFactor: options.scalingFactor || 3,
                oracleClass: options.oracleClass || 1
            };
            
            // Calculate total cost (base + bonus)
            const totalCost = await this.contract.maxTotalFee(params.maxFee);
            
            // Approve LINK tokens
            await this.linkToken.approve(this.contract.target, totalCost);
            
            // Submit request
            const tx = await this.contract.requestAIEvaluationWithApproval(
                cids,
                description,
                params.alpha,
                params.maxFee,
                params.baseCost,
                params.scalingFactor,
                params.oracleClass
            );
            
            console.log("Quick evaluation submitted:", tx.hash);
            const receipt = await tx.wait();
            
            // Extract request ID from events
            const event = receipt.logs.find(
                log => log.topics[0] === this.contract.interface.getEvent("RequestAIEvaluation").topicHash
            );
            const requestId = event.topics[1];
            
            return {
                requestId,
                transactionHash: tx.hash,
                estimatedCompletionTime: Date.now() + 60000, // ~1 minute
                cost: ethers.formatEther(totalCost)
            };
            
        } catch (error) {
            console.error("Failed to submit evaluation:", error);
            throw error;
        }
    }
    
    async pollForResult(requestId, maxWaitTime = 300000) { // 5 minutes max
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime) {
            const [likelihoods, justificationCID, exists] = 
                await this.contract.getEvaluation(requestId);
                
            if (exists) {
                return {
                    status: 'complete',
                    likelihoods: likelihoods.map(l => Number(l)),
                    justificationCID,
                    justification: await this.fetchFromIPFS(justificationCID),
                    completionTime: Date.now() - startTime
                };
            }
            
            // Check if failed
            const failed = await this.contract.isFailed(requestId);
            if (failed) {
                return {
                    status: 'failed',
                    error: 'Evaluation timed out or failed'
                };
            }
            
            // Wait before next check
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        return {
            status: 'timeout',
            error: 'Maximum wait time exceeded'
        };
    }
    
    watchEvaluation(requestId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Evaluation timeout'));
            }, 300000); // 5 minute timeout
            
            const fulfillFilter = this.contract.filters.EvaluationFulfilled(requestId);
            const failFilter = this.contract.filters.EvaluationFailed(requestId);
            
            const cleanup = () => {
                this.contract.off(fulfillFilter);
                this.contract.off(failFilter);
                clearTimeout(timeout);
            };
            
            this.contract.once(fulfillFilter, async (reqId, likelihoods, justificationCID) => {
                cleanup();
                resolve({
                    status: 'complete',
                    likelihoods: likelihoods.map(l => Number(l)),
                    justificationCID,
                    justification: await this.fetchFromIPFS(justificationCID)
                });
            });
            
            this.contract.once(failFilter, (reqId) => {
                cleanup();
                reject(new Error('Evaluation failed'));
            });
        });
    }
}
```

### React Hook Example

```javascript
import { useState, useCallback, useEffect } from 'react';
import { useContract, useSigner } from './web3-hooks';

export function useQuickEvaluation(contractAddress) {
    const signer = useSigner();
    const contract = useContract(contractAddress, REPUTATION_SINGLETON_ABI, signer);
    const [evaluations, setEvaluations] = useState({});
    
    const submitEvaluation = useCallback(async (files, description, options) => {
        if (!contract) throw new Error('Contract not available');
        
        const evaluator = new QuickEvaluator(contractAddress, signer);
        const result = await evaluator.submitQuickEvaluation(files, description, options);
        
        setEvaluations(prev => ({
            ...prev,
            [result.requestId]: {
                ...result,
                status: 'pending'
            }
        }));
        
        // Watch for completion
        evaluator.watchEvaluation(result.requestId)
            .then(completedResult => {
                setEvaluations(prev => ({
                    ...prev,
                    [result.requestId]: {
                        ...prev[result.requestId],
                        ...completedResult
                    }
                }));
            })
            .catch(error => {
                setEvaluations(prev => ({
                    ...prev,
                    [result.requestId]: {
                        ...prev[result.requestId],
                        status: 'failed',
                        error: error.message
                    }
                }));
            });
        
        return result.requestId;
    }, [contract, contractAddress, signer]);
    
    const getEvaluation = useCallback((requestId) => {
        return evaluations[requestId];
    }, [evaluations]);
    
    return {
        submitEvaluation,
        getEvaluation,
        evaluations
    };
}
```

## Cost Structure

The ReputationSingleton uses a simple fee structure:

1. **Base Fee**: Determined by selected oracle's fee
2. **Bonus Fee**: Equal to base fee (paid on success)
3. **Total Maximum**: `2 × oracle_fee`

**Example**: If oracle charges 0.02 LINK:
- User approves: 0.04 LINK maximum
- Oracle receives: 0.02 LINK immediately + 0.02 LINK bonus on completion

## Performance Characteristics

| Metric | ReputationSingleton | ReputationAggregator |
|--------|-------------------|---------------------|
| **Response Time** | ~30-60 seconds | ~5-15 minutes |
| **Cost** | 2× oracle fee | 15× oracle fee (max) |
| **Security** | Single point of failure | Multi-oracle consensus |
| **Complexity** | Low | High |
| **Use Cases** | Simple disputes, testing | High-stakes disputes |

## Best Practices

### When to Use ReputationSingleton

✅ **Good for**:
- Quick content moderation
- Simple true/false evaluations
- Development and testing
- Cost-sensitive applications
- Time-sensitive disputes

❌ **Avoid for**:
- High-value disputes
- Complex multi-part evaluations
- Mission-critical decisions
- Adversarial environments

### Configuration Recommendations

```javascript
// Development/Testing
const devConfig = {
    alpha: 500,           // Balanced
    maxFee: ethers.parseEther("0.01"),
    baseCost: ethers.parseEther("0.001"),
    scalingFactor: 2
};

// Production - Speed Priority
const speedConfig = {
    alpha: 800,           // Favor timeliness
    maxFee: ethers.parseEther("0.05"),
    baseCost: ethers.parseEther("0.005"),
    scalingFactor: 5
};

// Production - Cost Priority
const costConfig = {
    alpha: 300,           // Favor quality over speed
    maxFee: ethers.parseEther("0.02"),
    baseCost: ethers.parseEther("0.002"),
    scalingFactor: 2
};
```

## Security Considerations

### Limitations
- **Single Oracle Risk**: No consensus mechanism to detect malicious responses
- **No Clustering**: Cannot identify outlier responses
- **Limited Redundancy**: Oracle failure means evaluation failure

### Mitigations
- **Reputation System**: Only high-reputation oracles are selected
- **Stake Requirements**: Oracles have economic incentives for honest behavior
- **Bonus Alignment**: Payment structure encourages quality responses
- **Timeout Handling**: Automatic failure detection for unresponsive oracles

### Recommended Safeguards

```solidity
contract SafeQuickDispute {
    uint256 public constant MAX_DISPUTE_VALUE = 0.1 ether;
    uint256 public constant MIN_ORACLE_REPUTATION = 50;
    
    function createDispute(bytes32 requestId) external payable {
        require(msg.value <= MAX_DISPUTE_VALUE, "Value too high for quick resolution");
        
        // Additional checks could be added here to verify
        // the selected oracle meets minimum reputation requirements
    }
}
```

## Troubleshooting

### Common Issues

**"No active oracles available"**
- Check oracle class exists and is active
- Ensure maxOracleFee is sufficient
- Verify oracles aren't locked due to poor performance

**"Evaluation taking too long"**
```javascript
// Set appropriate timeout and handle failures
const timeout = await contract.responseTimeoutSeconds();
setTimeout(async () => {
    const failed = await contract.isFailed(requestId);
    if (!failed) {
        await contract.finalizeEvaluationTimeout(requestId);
    }
}, timeout * 1000);
```

**"Bonus payment failed"**
- Ensure sufficient LINK token approval
- Verify requester has enough LINK balance
- Check oracle address is valid

### Error Codes

| Error | Cause | Solution |
|-------|-------|----------|
| `Keeper not set` | ReputationKeeper not configured | Set keeper address |
| `CID count` | Too many/few evidence files | Use 1-10 IPFS hashes |
| `CID len` | Individual CID too long | Use valid IPFS hashes |
| `Addendum len` | Description too long | Limit to 1000 characters |
| `class mismatch` | Oracle doesn't support class | Use supported oracle class | 