> **Warning**
> Draft — requires author review

# Smart Contract Integration Walkthrough

A complete integration walkthrough based on the [DemoClient](https://github.com/verdikta/verdikta-dispatcher/tree/master/demoClient) contract, showing how to call the Verdikta dispatcher from a client contract.

## Architecture

A client contract interacts with the Verdikta system through the aggregator interface. The client never talks to oracles directly — the aggregator (or singleton) handles oracle selection, request dispatch, and result aggregation.

```
Your Client Contract
    │
    ├── approves LINK for aggregator
    ├── calls requestAIEvaluationWithApproval(...)
    ├── reads getEvaluation(requestId)
    └── calls isFailed(requestId)
        │
        ▼
ReputationAggregator / ReputationSingleton
    │
    ├── selects oracles via ReputationKeeper
    ├── dispatches Chainlink requests
    ├── collects and aggregates responses
    └── pays oracle bonuses
```

## The DemoClient Contract

The DemoClient (`demoClient/contracts/DemoClient.sol`) demonstrates the minimal integration pattern.

### Contract Source

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint64 jobClass
    ) external returns (bytes32);

    function getEvaluation(bytes32)
        external view returns (uint256[] memory, string memory, bool);

    function isFailed(bytes32) external view returns (bool);
}

contract DemoClient {
    IReputationAggregator public immutable agg;
    IERC20 public immutable link;
    string[] private cids;
    bytes32 public currentAggId;
    bool internal linkApproved;

    event Requested(bytes32 id);
    event Result(bytes32 id, uint64[] scores, string justif);

    constructor(address aggregator, address linkToken) {
        agg = IReputationAggregator(aggregator);
        link = IERC20(linkToken);
        cids.push("QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS");
    }

    function approveAggregator() external {
        link.approve(address(agg), type(uint256).max);
        linkApproved = true;
    }

    function request() external {
        require(currentAggId == bytes32(0), "already pending");

        if (!linkApproved) {
            link.approve(address(agg), type(uint256).max);
            linkApproved = true;
        }

        currentAggId = agg.requestAIEvaluationWithApproval(
            cids,       // IPFS evidence CIDs
            "",         // no addendum text
            500,        // alpha: balanced quality/timeliness
            1e16,       // maxOracleFee: 0.01 LINK
            1e12,       // estimatedBaseCost: 0.000001 LINK
            5,          // maxFeeBasedScalingFactor
            128         // requestedClass (evaluation class)
        );
        emit Requested(currentAggId);
    }

    function publish() external {
        (uint256[] memory s, string memory j, bool has) =
            agg.getEvaluation(currentAggId);
        if (has) {
            emit Result(currentAggId, s, j);
            currentAggId = bytes32(0);
        } else if (agg.isFailed(currentAggId)) {
            currentAggId = bytes32(0);
        } else {
            revert("not ready");
        }
    }
}
```

## Step-by-Step Integration Guide

### Step 1: Define the Aggregator Interface

Your contract needs the `IReputationAggregator` interface. The same interface works for both `ReputationAggregator` and `ReputationSingleton` — they share the same entry point signature, result getter, and failure checker:

```solidity
interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint64 jobClass
    ) external returns (bytes32);

    function getEvaluation(bytes32)
        external view returns (uint256[] memory, string memory, bool);

    function isFailed(bytes32) external view returns (bool);

    function maxTotalFee(uint256 requestedMaxOracleFee)
        external view returns (uint256);
}
```

### Step 2: Approve LINK Spending

Before submitting a request, the aggregator must be approved to transfer LINK from your contract (or from the end user's wallet).

**Option A: Unlimited approval (DemoClient pattern)**

```solidity
link.approve(address(agg), type(uint256).max);
```

Simple but gives the aggregator unlimited LINK access. Suitable for contracts that hold LINK on behalf of users.

**Option B: Per-request approval**

```solidity
uint256 required = agg.maxTotalFee(maxOracleFee);
link.approve(address(agg), required);
```

More restrictive. **Important for ReputationAggregator**: the approval must persist through finalization, since bonus payments are pulled from the requester at that time (potentially minutes after the request). For ReputationSingleton, fees are pulled upfront so timing is less critical.

### Step 3: Submit a Request

```solidity
bytes32 requestId = agg.requestAIEvaluationWithApproval(
    cids,               // string[] - IPFS CIDs of evidence
    addendumText,       // string   - optional additional context
    alpha,              // uint256  - reputation weight (0-1000)
    maxOracleFee,       // uint256  - max LINK per oracle (wei)
    estimatedBaseCost,  // uint256  - base cost for fee weighting
    maxFeeScaling,      // uint256  - max fee advantage for cheap oracles
    requestedClass      // uint64   - oracle class to use
);
```

**Parameter guidance:**

| Parameter | Typical Value | Notes |
|-----------|--------------|-------|
| `alpha` | 500 | Balanced. Use 200–400 for quality focus, 600–800 for speed focus. |
| `maxOracleFee` | 0.01–0.05 LINK | Higher = more oracle options but more expensive. |
| `estimatedBaseCost` | 1% of `maxOracleFee` | Used for fee weighting math. Must be < `maxOracleFee`. |
| `maxFeeScaling` | 5–10 | How much to prefer cheaper oracles. Must be ≥ 1. |
| `requestedClass` | 128 | Must match a class registered by available oracles. |

### Step 4: Poll for Results

Results are available on-chain after the oracle(s) respond and the aggregation completes.

```solidity
(uint256[] memory likelihoods, string memory justificationCID, bool exists) =
    agg.getEvaluation(requestId);

if (exists) {
    // likelihoods: array of scores from the evaluation
    // justificationCID: IPFS CID(s) of the justification text
    //   (ReputationAggregator returns comma-separated CIDs from clustered oracles)
    processResult(likelihoods, justificationCID);
} else if (agg.isFailed(requestId)) {
    handleFailure();
} else {
    // Still pending - check again later
}
```

### Step 5: Handle Timeouts

If the evaluation exceeds `responseTimeoutSeconds` (default: 300s), anyone can finalize it:

```solidity
agg.finalizeEvaluationTimeout(requestId);
```

After this call, `isFailed(requestId)` returns `true`. For the ReputationAggregator, timeout finalization also applies reputation penalties to non-responsive oracles and may still produce partial results if enough responses arrived.

## Deployment

The DemoClient is deployed using `hardhat-deploy`:

```bash
cd demoClient
npm install

# Edit deploy/01_demo_client.js:
# - Set AGGREGATOR to your deployed aggregator address
# - Set LINK_TOKEN to the LINK token address for your network

npx hardhat deploy --network base_sepolia
```

## Running a Demo Query

After deploying the DemoClient:

```bash
# 1. Fund the DemoClient with LINK
npx hardhat run scripts/transfer-link.js --network base_sepolia -- <demoClientAddress> 0.5

# 2. Run a query (submits request, polls for results, publishes)
npx hardhat run scripts/query-demo.js --network base_sepolia -- <demoClientAddress>
```

The `query-demo.js` script:
1. Checks for any pending request (`currentAggId != 0`)
2. If pending: polls `getEvaluation()` every 20 seconds until results arrive
3. If no pending: calls `request()` with 3M gas limit, then polls for results
4. On completion: calls `publish()` to emit the `Result` event and clear state

## Common Integration Patterns

### One-Request-at-a-Time (DemoClient Pattern)

Track a single active request. Simple state management.

```solidity
bytes32 public currentRequestId;

function submit(...) external {
    require(currentRequestId == bytes32(0), "already pending");
    currentRequestId = agg.requestAIEvaluationWithApproval(...);
}

function collect() external {
    require(currentRequestId != bytes32(0), "no pending request");
    (uint256[] memory scores, , bool exists) = agg.getEvaluation(currentRequestId);
    require(exists || agg.isFailed(currentRequestId), "not ready");
    // process...
    currentRequestId = bytes32(0);
}
```

### Multiple Concurrent Requests

Track requests by ID in a mapping.

```solidity
mapping(bytes32 => RequestData) public requests;

function submit(...) external returns (bytes32) {
    bytes32 id = agg.requestAIEvaluationWithApproval(...);
    requests[id] = RequestData({requester: msg.sender, ...});
    return id;
}
```

### User-Funded Requests

Pull LINK from the end user rather than holding LINK in your contract.

```solidity
function submit(string[] calldata cids) external {
    uint256 needed = agg.maxTotalFee(maxFee);
    link.transferFrom(msg.sender, address(this), needed);
    link.approve(address(agg), needed);
    bytes32 id = agg.requestAIEvaluationWithApproval(cids, "", 500, maxFee, baseCost, 5, 128);
    // store id...
}
```

**Note:** For ReputationAggregator, the approval must persist through finalization for bonus payments. Consider approving more than `maxTotalFee` or using a larger allowance.

## Error Handling

See the [Error Reference](../api/errors.md) for all possible revert conditions. The most common integration errors:

- **`"No active oracles available..."`** — No oracles match your class/fee criteria. Increase `maxOracleFee` or verify oracles are registered for your requested class.
- **LINK transfer failures** (`FeeTransferFailed`, `BonusTransferFailed`) — Ensure LINK approval is sufficient and persists through finalization.
- **`"already pending"`** (DemoClient) — Clear the previous request via `publish()` before submitting a new one.
- **`"Base cost must be less than max fee"`** — `estimatedBaseCost` must be strictly less than `maxOracleFee`.

## Next Steps

- [Frontend Integration](frontend.md) — How to interact with the contracts from a web frontend
- [Fee Mechanisms](../advanced/fees.md) — Understanding LINK costs
- [Oracle Selection](../advanced/oracle-selection.md) — How oracle parameters affect selection
- [Deployment Guide](../deployment/index.md) — Deploying your own contracts
