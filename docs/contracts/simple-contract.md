# SimpleContract

The SimpleContract provides a basic, single-oracle interface for development, testing, and simple production use cases. It offers direct oracle interaction without the complexity of reputation management or multi-oracle aggregation.

## Overview

The SimpleContract is designed for:
- **Development and Testing**: Quick setup for prototyping
- **Simple Applications**: Minimal complexity for basic use cases
- **Fixed Oracle Setup**: Direct connection to a specific oracle
- **Educational Purposes**: Understanding basic Chainlink integration

## Key Features

- **Direct Oracle Connection**: Configured with a specific oracle and job ID
- **Bonus Payment System**: Pays equal bonus to oracle on successful completion
- **Class-based Filtering**: Ensures only compatible oracles are used
- **Timeout Handling**: Automatic failure detection and manual finalization
- **Cost Transparency**: Simple 2× fee structure (base + bonus)

## Contract Interface

### Primary Function

```solidity
function requestAIEvaluationWithApproval(
    string[] memory cids,
    string memory addendumText,
    uint256, uint256, uint256, uint256,  // Ignored parameters for compatibility
    uint64 _requestedClass
) external returns (bytes32 requestId)
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cids` | `string[]` | IPFS content hashes containing evidence (max 10) |
| `addendumText` | `string` | Additional context (max 1000 chars) |
| `_requestedClass` | `uint64` | Must match contract's configured class |

**Note**: The middle parameters are ignored for compatibility with other contracts.

### View Functions

```solidity
// Get evaluation result
function getEvaluation(bytes32 id)
    external view returns (
        uint256[] memory likelihoods,
        string memory justificationCID,
        bool exists
    )

// Calculate maximum total fee (base + bonus)
function maxTotalFee(uint256) external view returns (uint256)

// Get contract configuration
function getContractConfig()
    external view returns (
        address oracleAddr,
        address linkAddr,
        bytes32 jobId,
        uint256 currentFee
    )

// Check if request failed
function isFailed(bytes32 requestId) external view returns (bool)

// Get timeout duration
function responseTimeoutSeconds() external view returns (uint256)
```

### Configuration Functions

```solidity
// Set response timeout (basic access control)
function setResponseTimeout(uint256 secs) external

// Owner-only functions (simplified in current implementation)
function withdrawLink(address payable to, uint256 amount) external
```

## Constructor Parameters

```solidity
constructor(
    address _oracle,      // ArbiterOperator contract address
    bytes32 _jobId,       // Job ID on the oracle
    uint256 _fee,         // LINK fee per request
    address _link,        // LINK token address
    uint64 _requiredClass // Oracle class this contract accepts
)
```

## Events

```solidity
// Request submitted
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);

// Evaluation completed
event FulfillAIEvaluation(
    bytes32 indexed requestId,
    uint256[] likelihoods,
    string justificationCID
);

// Internal fulfillment received
event FulfillmentReceived(
    bytes32 indexed requestId,
    address caller,
    uint256 len,
    string justificationCID
);

// Evaluation failed
event EvaluationFailed(bytes32 indexed requestId);

// Bonus payment to oracle
event BonusPaid(
    bytes32 indexed requestId,
    address oracle,
    uint256 amount
);
```

## Usage Examples

### Basic Deployment

```solidity
pragma solidity ^0.8.21;

import "./SimpleContract.sol";

contract SimpleContractDeployer {
    SimpleContract public evaluator;
    
    function deployEvaluator(
        address oracleOperator,
        bytes32 jobId,
        address linkToken
    ) external returns (address) {
        evaluator = new SimpleContract(
            oracleOperator,
            jobId,
            0.01 ether,  // 0.01 LINK fee
            linkToken,
            1            // Class 1 oracle
        );
        
        return address(evaluator);
    }
    
    function getEvaluatorInfo() external view returns (
        address oracle,
        address link,
        bytes32 jobId,
        uint256 fee,
        uint256 maxCost
    ) {
        (oracle, link, jobId, fee) = evaluator.getContractConfig();
        maxCost = evaluator.maxTotalFee(0); // Parameter ignored
        
        return (oracle, link, jobId, fee, maxCost);
    }
}
```

### Integration Example

```solidity
pragma solidity ^0.8.21;

contract ContentModerator {
    SimpleContract public evaluator;
    IERC20 public linkToken;
    
    struct ModerationRequest {
        bytes32 requestId;
        address requester;
        string contentHash;
        bool resolved;
        bool approved;
    }
    
    mapping(bytes32 => ModerationRequest) public requests;
    mapping(address => bool) public moderators;
    
    event ContentSubmitted(bytes32 indexed requestId, address requester);
    event ContentModerated(bytes32 indexed requestId, bool approved);
    
    constructor(address _evaluator, address _linkToken) {
        evaluator = SimpleContract(_evaluator);
        linkToken = IERC20(_linkToken);
        moderators[msg.sender] = true;
    }
    
    function submitContent(string memory contentIPFSHash) external returns (bytes32) {
        // Prepare evidence array
        string[] memory cids = new string[](1);
        cids[0] = contentIPFSHash;
        
        // Calculate and approve fees
        uint256 totalFee = evaluator.maxTotalFee(0);
        linkToken.transferFrom(msg.sender, address(this), totalFee);
        linkToken.approve(address(evaluator), totalFee);
        
        // Submit for evaluation
        bytes32 requestId = evaluator.requestAIEvaluationWithApproval(
            cids,
            "Content moderation request",
            0, 0, 0, 0,  // Ignored parameters
            1            // Moderation class
        );
        
        // Store request
        requests[requestId] = ModerationRequest({
            requestId: requestId,
            requester: msg.sender,
            contentHash: contentIPFSHash,
            resolved: false,
            approved: false
        });
        
        emit ContentSubmitted(requestId, msg.sender);
        return requestId;
    }
    
    function processResult(bytes32 requestId) external {
        ModerationRequest storage request = requests[requestId];
        require(!request.resolved, "Already processed");
        
        (uint256[] memory likelihoods, , bool exists) = 
            evaluator.getEvaluation(requestId);
        
        require(exists, "Evaluation not complete");
        
        // Approve if likelihood > 70%
        bool approved = likelihoods[0] > 700;
        
        request.resolved = true;
        request.approved = approved;
        
        emit ContentModerated(requestId, approved);
    }
    
    function handleTimeout(bytes32 requestId) external {
        require(moderators[msg.sender], "Not authorized");
        
        ModerationRequest storage request = requests[requestId];
        require(!request.resolved, "Already processed");
        
        // Check if evaluation failed
        if (evaluator.isFailed(requestId)) {
            // Manually reject on timeout
            request.resolved = true;
            request.approved = false;
            emit ContentModerated(requestId, false);
        }
    }
}
```

### Frontend Integration

```javascript
import { ethers } from 'ethers';

class SimpleEvaluator {
    constructor(contractAddress, signer) {
        this.contract = new ethers.Contract(
            contractAddress,
            SIMPLE_CONTRACT_ABI,
            signer
        );
    }
    
    async getConfiguration() {
        const [oracle, linkAddr, jobId, fee] = 
            await this.contract.getContractConfig();
        const maxTotalFee = await this.contract.maxTotalFee(0);
        const timeout = await this.contract.responseTimeoutSeconds();
        
        return {
            oracle,
            linkToken: linkAddr,
            jobId,
            fee: ethers.formatEther(fee),
            maxTotalFee: ethers.formatEther(maxTotalFee),
            timeoutSeconds: Number(timeout)
        };
    }
    
    async submitEvaluation(contentHash, description = "") {
        try {
            const config = await this.getConfiguration();
            
            // Approve LINK tokens
            const linkToken = new ethers.Contract(
                config.linkToken,
                LINK_ABI,
                this.contract.signer
            );
            
            const totalFee = ethers.parseEther(config.maxTotalFee);
            await linkToken.approve(this.contract.target, totalFee);
            
            // Submit request
            const tx = await this.contract.requestAIEvaluationWithApproval(
                [contentHash],
                description,
                0, 0, 0, 0,  // Ignored parameters
                1            // Default class
            );
            
            console.log("Evaluation submitted:", tx.hash);
            const receipt = await tx.wait();
            
            // Extract request ID from events
            const event = receipt.logs.find(
                log => log.topics[0] === this.contract.interface.getEvent("RequestAIEvaluation").topicHash
            );
            const requestId = event.topics[1];
            
            return {
                requestId,
                transactionHash: tx.hash,
                estimatedCompletionTime: Date.now() + (config.timeoutSeconds * 1000)
            };
            
        } catch (error) {
            console.error("Failed to submit evaluation:", error);
            throw error;
        }
    }
    
    async getResult(requestId) {
        const [likelihoods, justificationCID, exists] = 
            await this.contract.getEvaluation(requestId);
            
        if (!exists) {
            const failed = await this.contract.isFailed(requestId);
            return failed ? 
                { status: 'failed', error: 'Evaluation timed out' } :
                { status: 'pending' };
        }
        
        return {
            status: 'complete',
            likelihoods: likelihoods.map(l => Number(l)),
            justificationCID,
            confidence: Math.max(...likelihoods.map(l => Number(l))) / 10 // Convert to percentage
        };
    }
    
    watchEvaluation(requestId) {
        return new Promise((resolve, reject) => {
            const config = this.getConfiguration();
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Evaluation timeout'));
            }, config.timeoutSeconds * 1000);
            
            const fulfillFilter = this.contract.filters.FulfillAIEvaluation(requestId);
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
                    justificationCID
                });
            });
            
            this.contract.once(failFilter, (reqId) => {
                cleanup();
                reject(new Error('Evaluation failed'));
            });
        });
    }
}

// Usage example
async function moderateContent(contentHash) {
    const evaluator = new SimpleEvaluator(CONTRACT_ADDRESS, signer);
    
    try {
        const submission = await evaluator.submitEvaluation(contentHash, "Moderation check");
        console.log("Submitted:", submission.requestId);
        
        const result = await evaluator.watchEvaluation(submission.requestId);
        console.log("Result:", result);
        
        return result.likelihoods[0] > 500; // Approve if > 50%
        
    } catch (error) {
        console.error("Moderation failed:", error);
        return false; // Reject on error
    }
}
```

## Configuration and Deployment

### Network-Specific Deployment

```javascript
// Deployment script for different networks
const deploymentConfigs = {
    'base-sepolia': {
        linkToken: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
        oracle: '0x...', // Your ArbiterOperator address
        jobId: '0x...', // Your job ID
        fee: ethers.parseEther('0.01'),
        requiredClass: 1
    },
    'sepolia': {
        linkToken: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
        oracle: '0x...', // Your ArbiterOperator address
        jobId: '0x...', // Your job ID
        fee: ethers.parseEther('0.005'),
        requiredClass: 1
    }
};

async function deploySimpleContract(network) {
    const config = deploymentConfigs[network];
    if (!config) throw new Error(`No config for network: ${network}`);
    
    const SimpleContract = await ethers.getContractFactory("SimpleContract");
    const contract = await SimpleContract.deploy(
        config.oracle,
        config.jobId,
        config.fee,
        config.linkToken,
        config.requiredClass
    );
    
    await contract.waitForDeployment();
    
    console.log(`SimpleContract deployed to: ${contract.target}`);
    console.log(`Configuration:`, config);
    
    return contract;
}
```

## Cost Structure

The SimpleContract uses a straightforward fee structure:

1. **Base Fee**: The configured fee amount
2. **Bonus Fee**: Equal to the base fee (paid on success)
3. **Total Maximum**: `2 × fee`

**Example**: If configured with 0.01 LINK fee:
- User approves: 0.02 LINK
- Oracle receives: 0.01 LINK immediately + 0.01 LINK bonus on completion

## Comparison with Other Contracts

| Feature | SimpleContract | ReputationSingleton | ReputationAggregator |
|---------|---------------|-------------------|---------------------|
| **Setup Complexity** | Minimal | Medium | High |
| **Oracle Selection** | Fixed | Dynamic (reputation-based) | Dynamic (multi-oracle) |
| **Cost** | 2× fee | 2× fee | Up to 15× fee |
| **Response Time** | ~30-60 seconds | ~30-60 seconds | ~5-15 minutes |
| **Security** | Basic | Reputation-based | Multi-oracle consensus |
| **Use Cases** | Testing, simple apps | Quick disputes | High-stakes disputes |

## Best Practices

### When to Use SimpleContract

✅ **Good for**:
- Development and testing
- Proof of concepts
- Simple applications with trusted oracles
- Educational purposes
- Fixed oracle setups

❌ **Avoid for**:
- Production applications requiring high security
- Applications needing oracle redundancy
- Dynamic oracle selection requirements
- High-value dispute resolution

### Security Considerations

**Limitations**:
- **Single Point of Failure**: Only one oracle, no redundancy
- **No Reputation System**: Cannot adapt to oracle performance
- **Fixed Configuration**: Cannot change oracle without redeployment

**Mitigations**:
- **Oracle Selection**: Choose high-reputation, reliable oracles
- **Monitoring**: Implement external monitoring of oracle performance
- **Fallback Plans**: Have manual override mechanisms for critical applications

### Configuration Recommendations

```solidity
// Development configuration
SimpleContract devContract = new SimpleContract(
    testOracleAddress,
    testJobId,
    0.001 ether,  // Low fee for testing
    linkTokenAddress,
    1             // Standard test class
);

// Production configuration (use with caution)
SimpleContract prodContract = new SimpleContract(
    trustedOracleAddress,
    productionJobId,
    0.01 ether,   // Reasonable fee
    linkTokenAddress,
    1             // Production class
);
```

## Troubleshooting

### Common Issues

**"class mismatch"**
```solidity
// Check oracle's configured class matches contract
uint64 contractClass = 1; // Your configured class
uint64 requestClass = 2;  // Class in request
// Must match: contractClass == requestClass
```

**"CID count" / "CID len" / "Addendum len"**
- Max 10 CIDs per request
- Each CID max 100 characters  
- Addendum max 1000 characters

**"bonus LINK xferFrom failed"**
- Ensure requester has sufficient LINK balance
- Verify LINK token approval covers total fee
- Check oracle address is valid

### Testing and Debugging

```javascript
// Test configuration
async function testSimpleContract(contractAddress) {
    const contract = new ethers.Contract(contractAddress, ABI, provider);
    
    const [oracle, link, jobId, fee] = await contract.getContractConfig();
    const maxFee = await contract.maxTotalFee(0);
    const timeout = await contract.responseTimeoutSeconds();
    
    console.log('Configuration:', {
        oracle,
        linkToken: link,
        jobId,
        fee: ethers.formatEther(fee),
        maxTotalFee: ethers.formatEther(maxFee),
        timeoutSeconds: Number(timeout)
    });
    
    // Test with minimal request
    const testCids = ['QmTest123'];
    const linkToken = new ethers.Contract(link, LINK_ABI, signer);
    
    await linkToken.approve(contractAddress, maxFee);
    const tx = await contract.requestAIEvaluationWithApproval(
        testCids, '', 0, 0, 0, 0, 1
    );
    
    console.log('Test request submitted:', tx.hash);
}
``` 