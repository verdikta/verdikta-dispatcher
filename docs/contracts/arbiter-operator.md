# ArbiterOperator Contract

The ArbiterOperator is a specialized Chainlink operator contract that enforces access control for Verdikta's oracle network. It extends the standard Chainlink operator with reputation-based allowlists and multi-word response capabilities.

## Overview

The ArbiterOperator serves as the gateway between the Verdikta network and Chainlink infrastructure by:

- **Access Control**: Only approved contracts can request oracle services
- **Multi-word Responses**: Supports complex data structures in responses
- **Reputation Integration**: Works with ReputationKeeper allowlists
- **Standard Compliance**: Maintains full Chainlink operator compatibility

## Key Features

### Enhanced Access Control
- **Reputation Keeper Integration**: Validates requests against approved contract lists
- **Flexible Allowlists**: Multiple ReputationKeeper contracts can be registered
- **Gateway Mode**: Can operate with or without allowlist enforcement

### Advanced Response Handling
- **Multi-word Responses**: Supports complex data structures beyond single values
- **Gas Management**: Ensures sufficient gas for complex callback operations
- **Detailed Event Logging**: Comprehensive callback tracing for debugging

## Contract Interface

### Core Functionality

```solidity
// Multi-word response fulfillment
function fulfillOracleRequestV(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
) external returns (bool success)
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `requestId` | `bytes32` | Unique identifier for the oracle request |
| `payment` | `uint256` | Payment amount in LINK tokens |
| `callbackAddress` | `address` | Contract to call with the response |
| `callbackFunctionId` | `bytes4` | Function selector to call |
| `expiration` | `uint256` | Request expiration timestamp |
| `data` | `bytes` | Encoded response data |

### Reputation Keeper Management

```solidity
// Add a ReputationKeeper to the allowlist
function addReputationKeeper(address rkAddr) external onlyOwner

// Remove a ReputationKeeper from the allowlist
function removeReputationKeeper(address rkAddr) external onlyOwner

// Check if address is a registered ReputationKeeper
function isReputationKeeper(address rkAddr) external view returns (bool)

// Check if the allowlist is empty (gate disabled)
function isReputationKeeperListEmpty() external view returns (bool)
```

### Interface Detection

```solidity
// ERC-165 interface detection
function supportsInterface(bytes4 interfaceId) 
    external view returns (bool)
```

The ArbiterOperator implements the `IArbiterOperator` interface with ID `0xd9f812f9`.

## Events

```solidity
// Reputation Keeper management
event ReputationKeeperAdded(address indexed rk);
event ReputationKeeperRemoved(address indexed rk);

// Callback execution tracing
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

// Inherited from standard Chainlink operator
event OracleRequest(/* ... */);
event OracleResponse(bytes32 indexed requestId);
```

## Usage Examples

### Oracle Deployment

```solidity
pragma solidity ^0.8.19;

import "./ArbiterOperator.sol";

contract OracleDeployment {
    ArbiterOperator public operator;
    address public owner;
    
    constructor(address linkToken) {
        operator = new ArbiterOperator(linkToken);
        owner = msg.sender;
    }
    
    function setupReputationKeepers(address[] memory keepers) external {
        require(msg.sender == owner, "Only owner");
        
        for (uint256 i = 0; i < keepers.length; i++) {
            operator.addReputationKeeper(keepers[i]);
        }
    }
    
    function getOperatorInfo() external view returns (
        address operatorAddress,
        bool hasReputationKeepers,
        bool isArbiterOperator
    ) {
        return (
            address(operator),
            !operator.isReputationKeeperListEmpty(),
            operator.supportsInterface(type(IArbiterOperator).interfaceId)
        );
    }
}
```

### Integration with ReputationKeeper

```solidity
pragma solidity ^0.8.19;

contract OracleRegistration {
    ArbiterOperator public operator;
    ReputationKeeper public reputationKeeper;
    
    function registerWithSystem(
        bytes32 jobId,
        uint256 fee,
        uint64[] memory classes
    ) external {
        // First, register operator with reputation system
        reputationKeeper.registerOracle(
            address(operator),
            jobId,
            fee,
            classes
        );
        
        // Ensure operator recognizes the reputation keeper
        require(
            operator.isReputationKeeper(address(reputationKeeper)) ||
            operator.isReputationKeeperListEmpty(),
            "Operator doesn't recognize ReputationKeeper"
        );
    }
    
    function checkCompatibility() external view returns (bool) {
        // Verify the operator is compatible with Verdikta system
        return operator.supportsInterface(type(IArbiterOperator).interfaceId);
    }
}
```

### Client Contract Example

```solidity
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

contract VerdiktaClient is ChainlinkClient {
    using Chainlink for Chainlink.Request;
    
    ArbiterOperator public arbiterOperator;
    bytes32 public jobId;
    uint256 public fee;
    
    constructor(
        address _operator,
        address _link,
        bytes32 _jobId,
        uint256 _fee
    ) {
        _setChainlinkToken(_link);
        arbiterOperator = ArbiterOperator(_operator);
        jobId = _jobId;
        fee = _fee;
    }
    
    function requestEvaluation(string memory cid) external returns (bytes32) {
        // Verify this contract is approved
        require(
            arbiterOperator.isReputationKeeperListEmpty() ||
            _isApprovedByReputationKeepers(),
            "Contract not approved for oracle requests"
        );
        
        Chainlink.Request memory req = _buildOperatorRequest(
            jobId,
            this.fulfill.selector
        );
        req._add("cid", cid);
        
        return _sendOperatorRequestTo(address(arbiterOperator), req, fee);
    }
    
    function fulfill(
        bytes32 requestId,
        uint256[] memory likelihoods,
        string memory justificationCID
    ) external recordChainlinkFulfillment(requestId) {
        // Handle the multi-word response
        // Process likelihoods array and justification
    }
    
    function _isApprovedByReputationKeepers() internal view returns (bool) {
        // Implementation would check with known ReputationKeeper contracts
        // This is simplified for the example
        return true;
    }
}
```

### Node.js Oracle Implementation

```javascript
const { Requester, Validator } = require('@chainlink/external-adapter');

// Example external adapter for Verdikta AI evaluation
const inputParams = {
    cid: ['cid', 'hash'],
    mode: false // Optional mode parameter
};

const customParams = (data) => {
    const validator = new Validator(data, inputParams);
    if (validator.error) throw validator.error;
    
    return {
        cid: validator.validated.data.cid,
        mode: validator.validated.data.mode || '0'
    };
};

const createRequest = async (input, callback) => {
    try {
        const { cid, mode } = customParams(input);
        
        // Determine if this is commit or reveal phase
        const isCommitPhase = mode.startsWith('1:');
        const isRevealPhase = mode.startsWith('2:');
        
        let responseData;
        
        if (isCommitPhase) {
            // Commit phase: return hash of actual evaluation
            const actualEvaluation = await performAIEvaluation(cid);
            const salt = generateRandomSalt();
            const commitment = computeCommitment(actualEvaluation, salt);
            
            responseData = {
                data: [commitment], // Single value for commit
                result: commitment
            };
            
            // Store evaluation and salt for reveal phase
            storeForReveal(input.id, actualEvaluation, salt);
            
        } else if (isRevealPhase) {
            // Reveal phase: return actual evaluation and salt
            const { evaluation, salt } = retrieveStored(input.id);
            const cleanCid = extractJustificationCID(evaluation);
            
            responseData = {
                data: evaluation.likelihoods,
                result: evaluation.likelihoods,
                cid: `${cleanCid}:${salt.toString(16)}`
            };
            
        } else {
            // Legacy mode: direct evaluation
            const evaluation = await performAIEvaluation(cid);
            responseData = {
                data: evaluation.likelihoods,
                result: evaluation.likelihoods,
                cid: evaluation.justificationCID
            };
        }
        
        callback(200, Requester.success(input.id, responseData));
        
    } catch (error) {
        console.error('Oracle request failed:', error);
        callback(500, Requester.errored(input.id, error));
    }
};

// AI evaluation function (placeholder)
async function performAIEvaluation(cid) {
    // Implementation would:
    // 1. Fetch data from IPFS using the CID
    // 2. Send to AI service for evaluation
    // 3. Return structured response
    
    return {
        likelihoods: [750, 250], // Example: 75% likelihood for first option
        justificationCID: 'QmNewJustificationHash'
    };
}

function computeCommitment(evaluation, salt) {
    const crypto = require('crypto');
    const encoded = ethers.utils.defaultAbiCoder.encode(
        ['uint256[]', 'uint256'],
        [evaluation.likelihoods, salt]
    );
    const hash = crypto.createHash('sha256').update(encoded).digest();
    // Return first 128 bits as integer
    return BigInt('0x' + hash.toString('hex').substring(0, 32));
}

module.exports.createRequest = createRequest;
```

## Access Control Mechanism

### Allowlist Enforcement

The ArbiterOperator enforces access control through ReputationKeeper contracts:

1. **Request Validation**: Before emitting `OracleRequest`, checks if requester is approved
2. **Flexible Gatekeeping**: Multiple ReputationKeeper contracts can be registered
3. **Gate Disable**: If no ReputationKeepers are registered, all requests are allowed
4. **Double Validation**: Additional check during fulfillment for security

### Configuration States

| State | ReputationKeepers | Behavior |
|-------|------------------|----------|
| **Open** | None registered | All requests allowed |
| **Gated** | ≥1 registered | Only approved contracts allowed |
| **Multi-Keeper** | Multiple registered | Approved by ANY keeper |

## Interface Specification

### IArbiterOperator Interface

```solidity
interface IArbiterOperator is IERC165 {
    // Multi-word fulfillment
    function fulfillOracleRequestV(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4 callbackFunctionId,
        uint256 expiration,
        bytes calldata data
    ) external returns (bool success);
    
    // Allowlist queries
    function isReputationKeeper(address rkAddr) external view returns (bool);
    function isReputationKeeperListEmpty() external view returns (bool);
}
```

### Interface ID Calculation

The interface ID `0xd9f812f9` is computed as:
```
bytes4(keccak256("fulfillOracleRequestV(bytes32,uint256,address,bytes4,uint256,bytes)"))
^ bytes4(keccak256("isReputationKeeper(address)"))
^ bytes4(keccak256("isReputationKeeperListEmpty()"))
```

## Security Considerations

### Access Control Security
- **Pre-emission Validation**: Prevents unauthorized requests from reaching the oracle node
- **Dual Validation**: Additional check during fulfillment prevents bypass attempts
- **Owner Controls**: Only operator owner can modify ReputationKeeper list

### Callback Security
- **Gas Limits**: Enforces minimum gas requirements for callback execution
- **Execution Monitoring**: Detailed event logging for callback success/failure
- **Error Isolation**: Callback failures don't affect operator state

### Integration Security
- **Interface Verification**: Operators must implement IArbiterOperator interface
- **Version Compatibility**: Maintains compatibility with standard Chainlink infrastructure
- **Upgrade Path**: Reputation Keeper list can be updated without operator redeployment

## Best Practices

### For Oracle Operators

1. **Register Multiple Keepers**: Add redundant ReputationKeeper contracts for resilience
2. **Monitor Events**: Track callback success rates and investigate failures
3. **Gas Management**: Ensure adequate gas limits for complex callbacks
4. **Regular Updates**: Keep ReputationKeeper list current with network changes

### For Contract Developers

1. **Interface Detection**: Always verify operator supports IArbiterOperator interface
2. **Approval Verification**: Check contract approval status before making requests
3. **Error Handling**: Implement robust handling for callback failures
4. **Gas Estimation**: Provide sufficient gas for multi-word response processing

### For System Administrators

1. **Operator Monitoring**: Track operator performance and availability
2. **Access Control Audits**: Regularly review approved contract lists
3. **Network Health**: Monitor overall system connectivity and response times
4. **Upgrade Coordination**: Plan operator updates to minimize service disruption

## Troubleshooting

### Common Issues

**"Operator: requester not approved"**
```javascript
// Check if contract is approved by any ReputationKeeper
const keepers = await getRegisteredReputationKeepers(operatorAddress);
for (const keeper of keepers) {
    const approved = await keeper.isContractApproved(contractAddress);
    if (approved) {
        console.log(`Approved by keeper: ${keeper}`);
        break;
    }
}
```

**"Oracle not ArbiterOperator type"**
```javascript
// Verify operator implements correct interface
const operator = new ethers.Contract(address, OPERATOR_ABI, provider);
const isArbiter = await operator.supportsInterface('0xd9f812f9');
console.log('Is ArbiterOperator:', isArbiter);
```

**"Callback execution failed"**
- Check gas limits in oracle job specification
- Verify callback function signature matches request
- Review event logs for detailed error information

### Diagnostic Queries

```solidity
// Check operator configuration
function diagnoseOperator(address operatorAddr) external view returns (
    bool isArbiterOperator,
    bool hasReputationKeepers,
    address[] memory registeredKeepers
) {
    ArbiterOperator op = ArbiterOperator(operatorAddr);
    
    isArbiterOperator = op.supportsInterface(type(IArbiterOperator).interfaceId);
    hasReputationKeepers = !op.isReputationKeeperListEmpty();
    
    // Note: registeredKeepers would need additional enumeration logic
    // This is simplified for the example
}
``` 