# Integration Examples

This section provides comprehensive examples for integrating with Verdikta Dispatcher smart contracts. Choose the example that best matches your use case and technical requirements.

## Quick Start Examples

### 1. Simple Content Moderation

Perfect for basic content filtering and moderation systems.

```solidity
pragma solidity ^0.8.21;

import "../contracts/SimpleContract.sol";

contract ContentModerator {
    SimpleContract public evaluator;
    
    mapping(string => bool) public approvedContent;
    
    function moderateContent(string memory contentHash) external {
        string[] memory evidence = new string[](1);
        evidence[0] = contentHash;
        
        bytes32 requestId = evaluator.requestAIEvaluationWithApproval(
            evidence,
            "Content moderation check",
            0, 0, 0, 0, 1  // Use SimpleContract defaults
        );
        
        // Monitor requestId for results...
    }
}
```

### 2. Dispute Resolution System

Using ReputationSingleton for quick dispute resolution.

```solidity
pragma solidity ^0.8.21;

contract DisputeResolver {
    IReputationSingleton public dispatcher;
    
    struct Dispute {
        address plaintiff;
        address defendant;
        uint256 amount;
        bytes32 evaluationId;
        bool resolved;
    }
    
    mapping(bytes32 => Dispute) public disputes;
    
    function createDispute(
        string[] memory evidence,
        address defendant
    ) external payable returns (bytes32) {
        bytes32 evalId = dispatcher.requestAIEvaluationWithApproval(
            evidence,
            "Dispute resolution request",
            500,            // Balanced reputation weighting
            0.05 ether,     // Max 0.05 LINK fee
            0.005 ether,    // Base cost estimate
            3,              // Fee scaling factor
            1               // Standard dispute class
        );
        
        disputes[evalId] = Dispute({
            plaintiff: msg.sender,
            defendant: defendant,
            amount: msg.value,
            evaluationId: evalId,
            resolved: false
        });
        
        return evalId;
    }
}
```

### 3. High-Security Arbitration

Using ReputationAggregator for maximum security.

```solidity
pragma solidity ^0.8.21;

contract SecureArbitration {
    IReputationAggregator public aggregator;
    
    uint256 public constant MIN_DISPUTE_VALUE = 1 ether;
    
    function createHighStakesDispute(
        string[] memory evidence,
        string memory description
    ) external payable returns (bytes32) {
        require(msg.value >= MIN_DISPUTE_VALUE, "Dispute value too low");
        
        bytes32 aggId = aggregator.requestAIEvaluationWithApproval(
            evidence,
            description,
            400,            // Favor quality over speed
            0.1 ether,      // Higher fee for quality oracles
            0.01 ether,     // Base cost
            5,              // Max scaling
            1               // Premium dispute class
        );
        
        // Store dispute details...
        return aggId;
    }
}
```

## Integration Patterns

### Event-Driven Architecture

```solidity
contract EventDrivenIntegration {
    IReputationSingleton public dispatcher;
    
    event EvaluationRequested(bytes32 indexed requestId, address requester);
    event EvaluationCompleted(bytes32 indexed requestId, uint256[] results);
    
    function submitForEvaluation(string[] memory evidence) external returns (bytes32) {
        bytes32 requestId = dispatcher.requestAIEvaluationWithApproval(
            evidence, "", 500, 0.05 ether, 0.005 ether, 3, 1
        );
        
        emit EvaluationRequested(requestId, msg.sender);
        return requestId;
    }
    
    // Called by external service monitoring events
    function processResults(bytes32 requestId) external {
        (uint256[] memory likelihoods, , bool exists) = 
            dispatcher.getEvaluation(requestId);
            
        require(exists, "Evaluation not ready");
        
        emit EvaluationCompleted(requestId, likelihoods);
        
        // Process results based on business logic
        _handleResults(requestId, likelihoods);
    }
    
    function _handleResults(bytes32 requestId, uint256[] memory likelihoods) internal {
        // Implementation specific to your use case
    }
}
```

### Factory Pattern for Multiple Disputes

```solidity
contract DisputeFactory {
    IReputationAggregator public aggregator;
    
    struct DisputeConfig {
        uint256 alpha;
        uint256 maxFee;
        uint256 baseCost;
        uint256 scalingFactor;
        uint64 oracleClass;
    }
    
    mapping(string => DisputeConfig) public disputeTypes;
    
    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
        
        // Configure different dispute types
        disputeTypes["simple"] = DisputeConfig(600, 0.02 ether, 0.002 ether, 2, 1);
        disputeTypes["complex"] = DisputeConfig(400, 0.1 ether, 0.01 ether, 5, 2);
        disputeTypes["urgent"] = DisputeConfig(800, 0.05 ether, 0.005 ether, 3, 1);
    }
    
    function createDispute(
        string memory disputeType,
        string[] memory evidence,
        string memory description
    ) external returns (bytes32) {
        DisputeConfig memory config = disputeTypes[disputeType];
        require(config.maxFee > 0, "Invalid dispute type");
        
        return aggregator.requestAIEvaluationWithApproval(
            evidence,
            description,
            config.alpha,
            config.maxFee,
            config.baseCost,
            config.scalingFactor,
            config.oracleClass
        );
    }
}
```

## Frontend Integration Examples

### React Hook for Dispute Management

```javascript
import { useState, useCallback, useEffect } from 'react';
import { useContract, useSigner } from './web3-hooks';

export function useVerdiktaDispatcher(contractAddress, contractType = 'singleton') {
    const signer = useSigner();
    const contract = useContract(contractAddress, getABI(contractType), signer);
    const [disputes, setDisputes] = useState({});
    const [loading, setLoading] = useState(false);
    
    const submitDispute = useCallback(async (evidence, description, options = {}) => {
        if (!contract) throw new Error('Contract not available');
        
        setLoading(true);
        try {
            const params = {
                alpha: options.alpha || 500,
                maxFee: options.maxFee || ethers.parseEther("0.05"),
                baseCost: options.baseCost || ethers.parseEther("0.005"),
                scalingFactor: options.scalingFactor || 3,
                oracleClass: options.oracleClass || 1
            };
            
            // Approve LINK tokens
            const totalFee = await contract.maxTotalFee(params.maxFee);
            const linkToken = new ethers.Contract(LINK_TOKEN_ADDRESS, LINK_ABI, signer);
            await linkToken.approve(contract.target, totalFee);
            
            // Submit dispute
            const tx = await contract.requestAIEvaluationWithApproval(
                evidence,
                description,
                params.alpha,
                params.maxFee,
                params.baseCost,
                params.scalingFactor,
                params.oracleClass
            );
            
            const receipt = await tx.wait();
            const requestId = extractRequestId(receipt, contractType);
            
            setDisputes(prev => ({
                ...prev,
                [requestId]: {
                    requestId,
                    evidence,
                    description,
                    status: 'pending',
                    submittedAt: Date.now(),
                    transactionHash: tx.hash
                }
            }));
            
            // Start monitoring
            monitorDispute(requestId);
            
            return requestId;
            
        } finally {
            setLoading(false);
        }
    }, [contract, signer]);
    
    const monitorDispute = useCallback((requestId) => {
        const checkResult = async () => {
            try {
                const [likelihoods, justificationCID, exists] = 
                    await contract.getEvaluation(requestId);
                    
                if (exists) {
                    setDisputes(prev => ({
                        ...prev,
                        [requestId]: {
                            ...prev[requestId],
                            status: 'completed',
                            likelihoods: likelihoods.map(l => Number(l)),
                            justificationCID,
                            completedAt: Date.now()
                        }
                    }));
                    return;
                }
                
                // Check if failed
                const failed = await contract.isFailed(requestId);
                if (failed) {
                    setDisputes(prev => ({
                        ...prev,
                        [requestId]: {
                            ...prev[requestId],
                            status: 'failed',
                            failedAt: Date.now()
                        }
                    }));
                    return;
                }
                
                // Continue monitoring
                setTimeout(checkResult, 10000); // Check every 10 seconds
                
            } catch (error) {
                console.error('Error monitoring dispute:', error);
                setTimeout(checkResult, 30000); // Retry in 30 seconds
            }
        };
        
        checkResult();
    }, [contract]);
    
    return {
        submitDispute,
        disputes,
        loading,
        contract
    };
}

function getABI(contractType) {
    switch (contractType) {
        case 'aggregator': return REPUTATION_AGGREGATOR_ABI;
        case 'singleton': return REPUTATION_SINGLETON_ABI;
        case 'simple': return SIMPLE_CONTRACT_ABI;
        default: throw new Error(`Unknown contract type: ${contractType}`);
    }
}

function extractRequestId(receipt, contractType) {
    const eventName = 'RequestAIEvaluation';
    const event = receipt.logs.find(log => {
        try {
            const iface = new ethers.Interface(getABI(contractType));
            const parsed = iface.parseLog(log);
            return parsed.name === eventName;
        } catch {
            return false;
        }
    });
    
    if (!event) throw new Error('Request ID not found in transaction receipt');
    return event.topics[1];
}
```

### Vue.js Composition API Example

```javascript
import { ref, computed, onMounted } from 'vue';
import { ethers } from 'ethers';

export function useVerdiktaIntegration(contractAddress) {
    const contract = ref(null);
    const disputes = ref({});
    const loading = ref(false);
    const error = ref(null);
    
    const pendingDisputes = computed(() => {
        return Object.values(disputes.value).filter(d => d.status === 'pending');
    });
    
    const completedDisputes = computed(() => {
        return Object.values(disputes.value).filter(d => d.status === 'completed');
    });
    
    onMounted(async () => {
        try {
            const { ethereum } = window;
            if (!ethereum) throw new Error('MetaMask not found');
            
            const provider = new ethers.BrowserProvider(ethereum);
            const signer = await provider.getSigner();
            
            contract.value = new ethers.Contract(
                contractAddress,
                REPUTATION_SINGLETON_ABI,
                signer
            );
            
        } catch (err) {
            error.value = err.message;
        }
    });
    
    const submitEvaluation = async (evidenceFiles, description) => {
        if (!contract.value) throw new Error('Contract not initialized');
        
        loading.value = true;
        error.value = null;
        
        try {
            // Upload files to IPFS
            const cids = await Promise.all(
                evidenceFiles.map(file => uploadToIPFS(file))
            );
            
            // Submit evaluation
            const tx = await contract.value.requestAIEvaluationWithApproval(
                cids,
                description,
                500,
                ethers.parseEther("0.05"),
                ethers.parseEther("0.005"),
                3,
                1
            );
            
            const receipt = await tx.wait();
            const requestId = extractRequestId(receipt);
            
            disputes.value[requestId] = {
                requestId,
                evidence: cids,
                description,
                status: 'pending',
                submittedAt: new Date(),
                transactionHash: tx.hash
            };
            
            // Start monitoring
            monitorEvaluation(requestId);
            
            return requestId;
            
        } catch (err) {
            error.value = err.message;
            throw err;
        } finally {
            loading.value = false;
        }
    };
    
    const monitorEvaluation = async (requestId) => {
        const poll = async () => {
            try {
                const [likelihoods, justificationCID, exists] = 
                    await contract.value.getEvaluation(requestId);
                    
                if (exists) {
                    disputes.value[requestId] = {
                        ...disputes.value[requestId],
                        status: 'completed',
                        likelihoods: likelihoods.map(l => Number(l)),
                        justificationCID,
                        completedAt: new Date()
                    };
                    return;
                }
                
                const failed = await contract.value.isFailed(requestId);
                if (failed) {
                    disputes.value[requestId] = {
                        ...disputes.value[requestId],
                        status: 'failed',
                        failedAt: new Date()
                    };
                    return;
                }
                
                // Continue monitoring
                setTimeout(poll, 5000);
                
            } catch (err) {
                console.error('Monitoring error:', err);
                setTimeout(poll, 15000);
            }
        };
        
        poll();
    };
    
    return {
        disputes,
        pendingDisputes,
        completedDisputes,
        loading,
        error,
        submitEvaluation
    };
}
```

## Testing Examples

### Unit Tests with Hardhat

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SimpleContract Integration", function () {
    let simpleContract;
    let mockOracle;
    let linkToken;
    let owner, user;
    
    beforeEach(async function () {
        [owner, user] = await ethers.getSigners();
        
        // Deploy mock contracts
        const LinkToken = await ethers.getContractFactory("MockLinkToken");
        linkToken = await LinkToken.deploy();
        
        const MockOracle = await ethers.getContractFactory("MockArbiterOperator");
        mockOracle = await MockOracle.deploy(linkToken.target);
        
        // Deploy SimpleContract
        const SimpleContract = await ethers.getContractFactory("SimpleContract");
        simpleContract = await SimpleContract.deploy(
            mockOracle.target,
            ethers.id("test-job"),
            ethers.parseEther("0.01"),
            linkToken.target,
            1
        );
        
        // Setup user with LINK tokens
        await linkToken.mint(user.address, ethers.parseEther("1"));
        await linkToken.connect(user).approve(
            simpleContract.target, 
            ethers.parseEther("1")
        );
    });
    
    it("Should submit evaluation request", async function () {
        const cids = ["QmTest123"];
        const description = "Test evaluation";
        
        const tx = await simpleContract.connect(user).requestAIEvaluationWithApproval(
            cids,
            description,
            0, 0, 0, 0, 1
        );
        
        const receipt = await tx.wait();
        
        // Check event emission
        const event = receipt.logs.find(
            log => log.topics[0] === simpleContract.interface.getEvent("RequestAIEvaluation").topicHash
        );
        
        expect(event).to.not.be.undefined;
        
        const requestId = event.topics[1];
        
        // Simulate oracle response
        const likelihoods = [750, 250];
        const justificationCID = "QmJustification123";
        
        await mockOracle.fulfillRequest(
            requestId,
            likelihoods,
            justificationCID
        );
        
        // Check result
        const [resultLikelihoods, resultCID, exists] = 
            await simpleContract.getEvaluation(requestId);
            
        expect(exists).to.be.true;
        expect(resultLikelihoods[0]).to.equal(750);
        expect(resultCID).to.equal(justificationCID);
    });
    
    it("Should handle timeout scenarios", async function () {
        const cids = ["QmTest123"];
        
        const tx = await simpleContract.connect(user).requestAIEvaluationWithApproval(
            cids, "", 0, 0, 0, 0, 1
        );
        
        const receipt = await tx.wait();
        const requestId = receipt.logs[0].topics[1];
        
        // Fast forward time beyond timeout
        await ethers.provider.send("evm_increaseTime", [400]); // 400 seconds
        await ethers.provider.send("evm_mine");
        
        // Finalize timeout
        await simpleContract.finalizeEvaluationTimeout(requestId);
        
        // Check failed status
        expect(await simpleContract.isFailed(requestId)).to.be.true;
    });
});
```

## Best Practices

### 1. Error Handling

```solidity
contract RobustIntegration {
    IReputationSingleton public dispatcher;
    
    enum EvaluationStatus { Pending, Completed, Failed, Timeout }
    
    struct SafeEvaluation {
        bytes32 requestId;
        EvaluationStatus status;
        uint256 submittedAt;
        uint256 timeoutAt;
        string[] evidence;
        bool processed;
    }
    
    mapping(bytes32 => SafeEvaluation) public evaluations;
    
    function safeSubmitEvaluation(
        string[] memory evidence,
        string memory description
    ) external returns (bytes32) {
        try dispatcher.requestAIEvaluationWithApproval(
            evidence, description, 500, 0.05 ether, 0.005 ether, 3, 1
        ) returns (bytes32 requestId) {
            
            uint256 timeout = block.timestamp + 600; // 10 minutes
            
            evaluations[requestId] = SafeEvaluation({
                requestId: requestId,
                status: EvaluationStatus.Pending,
                submittedAt: block.timestamp,
                timeoutAt: timeout,
                evidence: evidence,
                processed: false
            });
            
            return requestId;
            
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("Submission failed: ", reason)));
        } catch {
            revert("Submission failed: Unknown error");
        }
    }
    
    function processEvaluation(bytes32 requestId) external {
        SafeEvaluation storage eval = evaluations[requestId];
        require(!eval.processed, "Already processed");
        
        if (block.timestamp > eval.timeoutAt) {
            eval.status = EvaluationStatus.Timeout;
            eval.processed = true;
            _handleTimeout(requestId);
            return;
        }
        
        try dispatcher.getEvaluation(requestId) returns (
            uint256[] memory likelihoods,
            string memory justificationCID,
            bool exists
        ) {
            if (exists) {
                eval.status = EvaluationStatus.Completed;
                eval.processed = true;
                _handleSuccess(requestId, likelihoods, justificationCID);
            }
        } catch {
            eval.status = EvaluationStatus.Failed;
            eval.processed = true;
            _handleFailure(requestId);
        }
    }
    
    function _handleSuccess(
        bytes32 requestId,
        uint256[] memory likelihoods,
        string memory justificationCID
    ) internal {
        // Implementation specific to your use case
    }
    
    function _handleFailure(bytes32 requestId) internal {
        // Handle evaluation failures
    }
    
    function _handleTimeout(bytes32 requestId) internal {
        // Handle timeout scenarios
    }
}
```

### 2. Fee Management

```solidity
contract FeeOptimizedIntegration {
    IReputationSingleton public dispatcher;
    IERC20 public linkToken;
    
    uint256 public constant MIN_LINK_BALANCE = 0.1 ether;
    uint256 public constant REFILL_AMOUNT = 0.5 ether;
    
    modifier ensureLinkBalance() {
        if (linkToken.balanceOf(address(this)) < MIN_LINK_BALANCE) {
            _refillLinkBalance();
        }
        _;
    }
    
    function submitWithFeeManagement(
        string[] memory evidence,
        string memory description
    ) external ensureLinkBalance returns (bytes32) {
        
        uint256 estimatedFee = dispatcher.maxTotalFee(0.05 ether);
        require(
            linkToken.balanceOf(address(this)) >= estimatedFee,
            "Insufficient LINK balance"
        );
        
        linkToken.approve(address(dispatcher), estimatedFee);
        
        return dispatcher.requestAIEvaluationWithApproval(
            evidence, description, 500, 0.05 ether, 0.005 ether, 3, 1
        );
    }
    
    function _refillLinkBalance() internal {
        // Implementation depends on your fee management strategy
        // Could pull from treasury, swap tokens, etc.
    }
}
```

## Next Steps

- **[Frontend Integration](frontend.md)**: Detailed frontend examples
- **[Smart Contract Integration](integration.md)**: Advanced contract patterns
- **[Deployment Guide](../deployment/index.md)**: How to deploy and configure contracts
- **[API Reference](../api/index.md)**: Complete contract interfaces 