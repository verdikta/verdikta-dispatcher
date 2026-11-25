# ArbiterOperator Contract

The ArbiterOperator is a specialized Chainlink operator contract that enforces access control for Verdikta's oracle network. It extends the standard Chainlink operator with reputation-based allowlists and multi-word response capabilities.

!!! note "Checked against the code"
    Revised on 2026-11-25 against [`ArbiterOperator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/arbiterOperator/contracts/ArbiterOperator.sol), v2's [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) and [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol), and [`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md), on the `beacon` branch. The operator contract is unchanged in v2: deployed operators keep working. What changes for an operator's owner and node is listed under [Working with v2](#working-with-v2).

## Overview

The ArbiterOperator serves as the gateway between the Verdikta network and Chainlink infrastructure by:

- **Access Control**: Only approved contracts can request oracle services
- **Multi-word Responses**: Supports complex data structures in responses
- **Reputation Integration**: Works with ReputationKeeper allowlists, and answers the keeper's checks for health-call senders (`isAuthorizedSender`) and the payee (`owner()`)
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
| `payment` | `uint256` | Payment amount in LINK tokens. The v2 aggregator sends its requests with a payment of 0: arbiters are paid in ETH by the aggregator (see below) |
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

// The whole allowlist
function getReputationKeepers() external view returns (address[] memory)
```

`addReputationKeeper` reverts with `"RK: not contract"` for an address without code, `"RK: exists"` for one already listed, and `"RK: interface"` if a static call to `isContractApproved(address)` on it fails. The v2 keeper keeps that function, so it can be added.

### Inherited Functions Verdikta Relies On

```solidity
// From OperatorMod / AuthorizedReceiver
function owner() external view returns (address)
function isAuthorizedSender(address sender) external view returns (bool)
function setAuthorizedSenders(address[] calldata senders) external   // owner or authorized sender
```

- **`owner()`**:
    - is the payee: the aggregator credits every base fee, bonus and beacon payment to the operator's `owner()`, read with a 30,000-gas stipend at the draw;
    - may register the arbiter in the keeper, and receives the stake when it exits;
    - an operator whose `owner()` cannot be read gets no slot (`SlotSkipped`, reason 1).
- **`isAuthorizedSender`**: the keeper accepts health answers (`answerHealthCall`, `rotateChain`, `requestHealthCall`) only from the operator's `owner()` or an authorized sender. The node answers from its Chainlink node key, so that key must be an authorized sender (`setAuthorizedSenders`), as it already is for fulfilling requests.

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

The v2 keeper registers an arbiter with a stake and a hash-chain head. The caller must be the operator's owner (or the keeper's owner) and pays the stake.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IOperatorGate {
    function isReputationKeeper(address rkAddr) external view returns (bool);
    function isReputationKeeperListEmpty() external view returns (bool);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReputationKeeperV2 {
    function stakeRequirement() external view returns (uint256);
    function registerArbiter(address oracle, bytes32 jobId, uint64 fee, uint64[] calldata classes, bytes32 chainHead) external;
}

// Meant to be the operator's owner (operator.transferOwnership to it, then acceptOwnership)
contract OracleRegistration {
    IOperatorGate public immutable operator;
    IReputationKeeperV2 public immutable reputationKeeper;
    IERC20 public immutable verdiktaToken;

    constructor(address _operator, address _keeper, address _token) {
        operator = IOperatorGate(_operator);
        reputationKeeper = IReputationKeeperV2(_keeper);
        verdiktaToken = IERC20(_token);
    }

    function registerWithSystem(bytes32 jobId, uint64 feeWei, uint64[] calldata classes, bytes32 chainHead) external {
        // The operator must accept requests from contracts this keeper approves: either it lists
        // the keeper (addReputationKeeper) or its list is empty (gate off)
        require(
            operator.isReputationKeeper(address(reputationKeeper)) || operator.isReputationKeeperListEmpty(),
            "Operator doesn't recognize ReputationKeeper"
        );
        // The stake (100 VDKA by default) is pulled from this contract
        verdiktaToken.approve(address(reputationKeeper), reputationKeeper.stakeRequirement());
        // fee in wei of ETH; chainHead 0 lets the node's health job set the chain (starts frozen)
        reputationKeeper.registerArbiter(address(operator), jobId, feeWei, classes, chainHead);
    }

    function checkCompatibility() external view returns (bool) {
        return operator.supportsInterface(0xd9f812f9);   // IArbiterOperator
    }
}
```

The v2 keeper does not itself check the interface or the keeper list at registration (v1 did). An operator that does not list the keeper is registered, but every request to it reverts, so the aggregator skips its slot with `SlotSkipped(aggId, slot, 2)` and it earns nothing.

### Client Contract Example

A contract can also send a request straight to one operator, without the aggregator, as [SimpleContract](simple-contract.md) does. Such a request carries no `1:` or `2:` prefix, so the arbiter's node evaluates it directly (mode 0) and answers with its scores and justification CID: no commit, no reveal and no reputation. If the operator lists keepers, the client must be approved in one of them (`setApproved` on a v2 keeper). That approval also lets it select arbiters and report outcomes in that keeper, so a keeper owner should approve only contracts it trusts.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

interface IArbiterOperatorGate {
    function isReputationKeeperListEmpty() external view returns (bool);
}

contract VerdiktaClient is ChainlinkClient {
    using Chainlink for Chainlink.Request;
    
    IArbiterOperatorGate public arbiterOperator;
    bytes32 public jobId;
    uint256 public fee;
    
    constructor(
        address _operator,
        address _link,
        bytes32 _jobId,
        uint256 _fee
    ) {
        _setChainlinkToken(_link);
        arbiterOperator = IArbiterOperatorGate(_operator);
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
    
    function _isApprovedByReputationKeepers() internal pure returns (bool) {
        // Implementation would check isContractApproved(address(this)) on the operator's
        // keepers (getReputationKeepers()). This is simplified for the example
        return true;
    }
}
```

### Node.js Oracle Implementation

A sketch of the commit and reveal steps of an external adapter, in the v2 format. The real implementation is `external-adapter/src/handlers/evaluateHandler.js` on the arbiter's `beacon` branch. The job passes the request's `cid` and `aggId` parameters to the adapter.

```javascript
const crypto = require('crypto');
const { ethers } = require('ethers');   // v5, as the arbiter uses

const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS;   // the operator contract that fulfills

// v2 commit: keccak256(abi.encode(bytes32 aggId, address operator, uint256[] scores, uint256 salt)),
// all 32 bytes, sent in full as the single commit word
function commitmentHash(aggId, scores, saltHex) {
    const encoded = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256[]', 'uint256'],
        [aggId, OPERATOR_ADDRESS, scores, ethers.BigNumber.from('0x' + saltHex)]
    );
    return ethers.utils.keccak256(encoded);   // 0x + 64 hex
}

async function handleRequest({ cid, aggId }) {
    if (cid.startsWith('1:')) {
        // Commit: evaluate, then commit to the answer with a fresh 128-bit salt
        const { scores, justificationCid } = await performAIEvaluation(cid.slice(2));
        const salt = crypto.randomBytes(16).toString('hex');        // exactly 32 hex digits
        const hash = commitmentHash(aggId, scores, salt);
        store(hash.slice(2).toLowerCase(), { scores, justificationCid, salt });
        return { data: [hash], cid: '' };                            // one word, empty CID
    }
    if (cid.startsWith('2:')) {
        // Reveal: the request carries the full commit hash, 64 lowercase hex digits
        const entry = load(cid.slice(2).toLowerCase());
        return { data: entry.scores, cid: `${entry.justificationCid}:${entry.salt}` };
    }
    // No prefix (mode 0): a direct request, as SimpleContract sends; answer without commit/reveal
    const { scores, justificationCid } = await performAIEvaluation(cid);
    return { data: scores, cid: justificationCid };
}

// Placeholders
async function performAIEvaluation(cidAndAddendum) {
    // 1. fetch the query package(s) from IPFS, 2. run the models, 3. upload the justification.
    // Scores are on the 0..1,000,000 scale. A question that asks for one number gets [score]
    return { scores: [750000, 250000], justificationCid: 'QmJustification' };
}
const memory = new Map();
function store(k, v) { memory.set(k, v); }   // persist this in a real node
function load(k) { return memory.get(k); }
```

Each request gets one answer: a malformed reveal still uses up the request, and there is no retry. A commit in v1's format (the first 16 bytes of `sha256(abi.encode(operator, scores, salt))`) is accepted but can never be revealed.

## Working with v2

The operator contract is unchanged in v2, but every operator owner and node has work to do ([`MIGRATION.md`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md)):

1. **Add the v2 keeper to the gate**: `addReputationKeeper(<v2 keeper>)`, unless the list is empty. The v2 keeper answers `isContractApproved(requester)` (its `approvedContracts`, set with `setApproved`) and approves the v2 aggregator at deployment. Without the keeper on the list, every dispatch from the v2 aggregator reverts and the aggregator skips the slot.
2. **Register again** in the v2 keeper with `registerArbiter(operator, jobId, fee, classes, chainHead)`. The stake is pulled from the caller. See [ReputationKeeper](reputation-keeper.md#registration).
3. **Switch the commit and reveal format** when the v2 aggregator goes live:

    | | v1 | v2 |
    |--|----|----|
    | Commit request `cid` | `1:<cids>[:addendum]` | same |
    | Commit word | first 16 bytes of `sha256(abi.encode(operator, scores, salt))` | `keccak256(abi.encode(aggId, operator, scores, salt))`, all 32 bytes |
    | Salt | 80 bits, 20 hex | 128 bits, 32 hex, fresh per commit |
    | Reveal request `cid` | `2:<32 hex>` | `2:<64 hex>`, the full commit hash in lowercase |
    | Reveal answer | scores (at least 2), `"<cid>:<salt>"` | scores (1 to 20 values), `"<cid>:<32 hex salt>"` |
    | `aggId` parameter | a hash | `bytes32(roundId)`, sequential, as `0x` + 64 hex |

    The callback is still `fulfill(bytes32 requestId, uint256[] response, string cid)`, delivered through `fulfillOracleRequestV`.
4. **Answer health calls.** The keeper emits `HealthCall(key, sentAt)`. The node answers with `answerHealthCall` or `rotateChain` within 60 s, from an authorized sender of this operator, or the arbiter is frozen. A beacon call is the same health call.
5. **Raise the job's gas limit.** The N-th counted reveal finalizes the round and pays for clustering: up to 6.9M gas at Jumbo with 20 outcomes. The operator also requires at least 400,000 gas left for the callback.

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
| **Gated** | ≥1 registered | Only approved contracts allowed. A keeper approves a contract with `setApproved` (v2) or `approveContract` (v1) |
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
- **Interface Verification**: The v1 keeper required the IArbiterOperator interface at registration. The v2 keeper requires only code and an `owner()`, so check the interface yourself if it matters to you
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
const operator = new ethers.Contract(operatorAddress,
    ['function getReputationKeepers() view returns (address[])'], provider);
for (const addr of await operator.getReputationKeepers()) {
    const keeper = new ethers.Contract(addr, ['function isContractApproved(address) view returns (bool)'], provider);
    if (await keeper.isContractApproved(contractAddress)) {
        console.log(`Approved by keeper: ${addr}`);
        break;
    }
}
// None: the keeper's owner calls setApproved(contractAddress, true) on a v2 keeper,
// or the operator's owner adds a keeper that approves it (addReputationKeeper)
```

**"Oracle not ArbiterOperator type"** (v1 keeper only: the v2 keeper's `registerArbiter` does not check the interface)
```javascript
// Verify operator implements correct interface
const operator = new ethers.Contract(address, OPERATOR_ABI, provider);
const isArbiter = await operator.supportsInterface('0xd9f812f9');
console.log('Is ArbiterOperator:', isArbiter);
```

**The v2 aggregator skips the slot (`SlotSkipped(aggId, slot, 2)`)**
- The operator's keeper list does not include the v2 keeper: `addReputationKeeper(<v2 keeper>)`
- The operator reverted or used up the dispatch stipend (`dispatchGas()` on the aggregator, 250,000)

**`NotAuthorizedResponder()` from the keeper on a health answer**
- Send the answer from the operator's `owner()` or an address in `getAuthorizedSenders()`

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
    registeredKeepers = op.getReputationKeepers();
}
``` 