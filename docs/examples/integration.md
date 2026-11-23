# Smart Contract Integration Walkthrough

A complete integration walkthrough based on the [DemoClient](https://github.com/verdikta/verdikta-dispatcher/tree/master/demoClient) contract, showing how a client contract calls the ReputationAggregator and pays for the evaluation in ETH.

!!! note "Checked against the code"
    Rewritten on 2026-11-22 against [`demoClient/contracts/DemoClient.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/demoClient/contracts/DemoClient.sol), [`demoClient/scripts/query-demo.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/demoClient/scripts/query-demo.js) and [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationAggregator.sol). The DemoClient and the patterns below were deployed and run on a local fork of Base mainnet. The earlier version of this page described a DemoClient that held LINK and approved it for the aggregator. That contract is no longer in the repository: the DemoClient is funded with ETH, and nothing on this page needs LINK.

## Architecture

A client contract interacts with the Verdikta system through the aggregator. The client never talks to oracles directly — the aggregator handles oracle selection, request dispatch, result aggregation and payment.

```
Your Client Contract
    │
    ├── reads maxTotalFee(...) to size the prepayment
    ├── calls requestAIEvaluationWithApproval{value: ...}(...)
    ├── reads getEvaluation(requestId)
    ├── reads isFailed(requestId)
    └── calls withdrawEth() to collect its refunds
        │
        ▼
ReputationAggregator
    │
    ├── holds the prepayment for the round
    ├── selects oracles via ReputationKeeper
    ├── dispatches Chainlink requests (which carry no LINK)
    ├── collects and aggregates responses
    └── credits oracle fees, bonuses and the requester's refund
        in its ethOwed ledger
```

The function is still called `requestAIEvaluationWithApproval`, but there is no approval: the ETH that funds the round travels with the call.

## The DemoClient Contract

The DemoClient (`demoClient/contracts/DemoClient.sol`) demonstrates the minimal integration pattern.

### Contract Source

The contract as it is in the repository, with its comments shortened:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint64 jobClass
    ) external payable returns (bytes32);
    function getEvaluation(bytes32)
       external view returns (uint256[] memory, string memory, bool);
    function isFailed(bytes32) external view returns (bool);
    function maxTotalFee(uint256) external view returns (uint256);
    function withdrawEth() external;
}

contract DemoClient {
    IReputationAggregator public immutable agg;
    string[] private cids;
    bytes32 public currentAggId;

    event Requested(bytes32 id);
    event Result(bytes32 id, uint256[] scores, string justif);

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
        cids.push("QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS");
    }

    // Start an evaluation, funded with the ETH sent with this call and with
    // any credit this contract already holds in the aggregator
    function request() external payable {
        require(currentAggId == bytes32(0), "already pending");
        currentAggId = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids,       // IPFS CIDs of the query package
            "",         // no addendum text
            500,        // alpha: equal weight on quality and timeliness
            15e13,      // maxOracleFee: 0.00015 ETH per oracle at most
            8e9,        // estimatedBaseCost, in wei, below the fee ceiling
            5,          // maxFeeBasedScalingFactor
            128         // requestedClass
        );
        emit Requested(currentAggId);
    }

    // Worst-case ETH to send with request()
    function quote() external view returns (uint256) {
        return agg.maxTotalFee(15e13);
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

    // Pull this contract's credit out of the aggregator, into this contract
    function reclaim() external {
        agg.withdrawEth();
    }

    // The reclaimed ETH arrives here
    receive() external payable {}
}
```

## Step-by-Step Integration Guide

### Step 1: Define the Aggregator Interface

Your contract needs an interface for the functions it calls. The request function must be declared `payable`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint64 jobClass
    ) external payable returns (bytes32);

    function getEvaluation(bytes32)
        external view returns (uint256[] memory, string memory, bool);

    function isFailed(bytes32) external view returns (bool);

    function maxTotalFee(uint256 requestedMaxOracleFee)
        external view returns (uint256);

    function ethOwed(address payee) external view returns (uint256);

    function getEthAccounting(bytes32 aggId)
        external view returns (
            uint256 ethReceived,
            uint256 baseCredited,
            uint256 bonusCredited,
            uint256 bonusMultiplierSnap,
            uint256 reserved
        );

    function responseTimeoutSeconds() external view returns (uint256);

    function finalizeEvaluationTimeout(bytes32 aggId) external;

    function withdrawEth() external;
}
```

This interface is for the ReputationAggregator. The legacy [ReputationSingleton](../contracts/reputation-singleton.md) has a request function of the same name that is not payable and is paid in LINK, so a client written for one does not work with the other.

### Step 2: Fund the Request

Every request must be funded with `maxTotalFee(maxOracleFee)`, the worst case for one round:

```
ceiling    = min(maxOracleFee, the contract's maxOracleFee())
prepayment = ceiling × (K + B × P)
```

With the settings of 2026-11-22 (K = 6 oracles polled, bonus multiplier B = 3, cluster size P = 2) the prepayment is 12 × the ceiling. The DemoClient's ceiling of 0.00015 ETH gives 0.0018 ETH, which is what `quote()` returns.

The aggregator takes the amount first from the credit the caller already holds (`ethOwed(caller)`) and requires the rest as the ETH sent with the call. If the two together are too little, the request reverts with `InsufficientPayment()`.

**Option A: pass on what the caller sends (DemoClient pattern)**

```solidity
function request() external payable {
    currentAggId = agg.requestAIEvaluationWithApproval{value: msg.value}(/* ... */);
}
```

The caller reads `quote()` and sends that amount. Simple, and the contract needs no ETH of its own.

**Option B: pay from the contract's own balance**

```solidity
uint256 required = agg.maxTotalFee(maxOracleFee);
uint256 credit = agg.ethOwed(address(this));
uint256 value = required > credit ? required - credit : 0;
requestId = agg.requestAIEvaluationWithApproval{value: value}(/* ... */);
```

The contract is funded in advance and sends only what its credit does not cover. See `FeeManagedIntegration` in the [Integration Examples](index.md#2-fee-management).

In both cases **the client contract is the requester**. Whatever the round does not spend is credited to the client contract in the aggregator, not to the user who called it.

### Step 3: Submit a Request

```solidity
bytes32 requestId = agg.requestAIEvaluationWithApproval{value: value}(
    cids,               // string[] - IPFS CIDs of the query package(s)
    addendumText,       // string   - optional additional context
    alpha,              // uint256  - reputation weight (0-1000)
    maxOracleFee,       // uint256  - highest fee per oracle, in ETH wei
    estimatedBaseCost,  // uint256  - base cost for fee weighting, in ETH wei
    maxFeeScaling,      // uint256  - max fee advantage for cheap oracles
    requestedClass      // uint64   - oracle class to use
);
```

**Parameter guidance:**

| Parameter | DemoClient value | Notes |
|-----------|------------------|-------|
| `cids` | one CID | 1 to 10 CIDs, each at most 100 bytes. They must point to query packages the oracles can read; see the comment above `CID` in [`scripts/single-query.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/scripts/single-query.js) |
| `alpha` | 500 | 0 to 1000. Higher values give timeliness more weight, lower values give quality more weight |
| `maxOracleFee` | 0.00015 ETH (`15e13`) | Must be at least the fee the oracles charge: 0.00002 ETH for every oracle on Base mainnet and Base Sepolia on 2026-11-22 (the ReputationKeeper's `getOracleInfo(operator, jobId)`). A value above the contract's `maxOracleFee()` (0.0004 ETH) is lowered to it. It sets the size of the prepayment, not the price |
| `estimatedBaseCost` | `8e9` wei | Used for fee weighting. Must be lower than the fee ceiling in effect |
| `maxFeeScaling` | 5 | How much to prefer cheaper oracles. Must be at least 1 |
| `requestedClass` | 128 | Must be a class that registered oracles list. On 2026-11-22 all 40 oracles on Base mainnet listed class 128 |

The request selects oracles at random, so the gas it uses differs from what was estimated beforehand. Send it with a gas limit above the estimate: the repository's `single-query.js` adds 50%. On forks of the two networks on 2026-11-22, `DemoClient.request()` used about 3.3 million gas on Base mainnet and was estimated at about 3.1 million on Base Sepolia.

### Step 4: Poll for Results

Results are available on-chain after enough oracles have responded and the aggregation has completed.

```solidity
(uint256[] memory likelihoods, string memory justificationCIDs, bool exists) =
    agg.getEvaluation(requestId);

if (exists) {
    // likelihoods: one score per outcome of the query package
    // justificationCIDs: comma-separated IPFS CIDs, one per clustered oracle
    processResult(likelihoods, justificationCIDs);
} else if (agg.isFailed(requestId)) {
    handleFailure();
} else {
    // Still open: either in progress, or past its timeout and not yet
    // finalized (see Step 5)
}
```

### Step 5: Handle Timeouts

A round that has not completed within `responseTimeoutSeconds()` (300 seconds on Base mainnet and 900 on Base Sepolia on 2026-11-22) is not closed automatically. It stays open, with `isFailed()` false and the unspent part of the prepayment reserved, until someone calls:

```solidity
agg.finalizeEvaluationTimeout(requestId);
```

Anyone can make this call once the timeout has passed; before that it reverts with `NotTimedOut()`. It closes the round as failed (`isFailed(requestId)` returns `true`), applies reputation penalties to the oracles that did not respond and credits the unspent prepayment back to the requester. The base fees credited to the polled oracles when the request was made stay with them. Nothing is retried: send a new request if you still need the evaluation.

The DemoClient shows why this matters. Its `publish()` reverts with "not ready" for as long as the round is open, so after a timeout the DemoClient can neither publish nor start a new request until someone has called `finalizeEvaluationTimeout()` on the aggregator.

### Step 6: Collect Refunds

Refunds are credits in the aggregator's `ethOwed` ledger, in the name of the client contract. There are two things to do with a credit:

- **Leave it.** It pays for the contract's next request before new ETH is asked for. After a completed round at the DemoClient's settings the credit was 0.00156 ETH, so the next request needed 0.00024 ETH; after a timed-out round the credit was 0.00168 ETH and the next request needed 0.00012 ETH.
- **Withdraw it.** `agg.withdrawEth()` sends the caller's whole credit to the caller, so the client contract must make the call and must be able to receive ETH.

!!! warning "The DemoClient's `reclaim()` keeps the ETH in the DemoClient"
    `reclaim()` calls `withdrawEth()`, and the ETH arrives in the DemoClient contract. The DemoClient has no function that sends ETH out, and `request()` forwards only the ETH sent with that call, not the contract's own balance. ETH reclaimed this way stays in the DemoClient contract. With the DemoClient as it is, leave the credit in the aggregator. In your own client, add a way to pay the ETH out, as in the example below.

A client that can pay its refunds out:

```solidity
contract RefundingClient {
    IReputationAggregator public immutable agg;
    address public immutable owner;

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
        owner = msg.sender;
    }

    function request(string[] calldata cids) external payable returns (bytes32) {
        return agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, 15e13, 8e9, 5, 128
        );
    }

    function reclaim() external {
        require(msg.sender == owner, "Not owner");
        agg.withdrawEth();                                   // credit -> this contract
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "Transfer failed");                      // this contract -> owner
    }

    receive() external payable {}
}
```

## Deployment

The DemoClient is deployed using `hardhat-deploy`:

```bash
cd demoClient
npm install

# Edit deploy/01_demo_client.js:
# - Set AGGREGATOR to the ETH-funded aggregator of your network:
#   0xe8a385E473EA710c5a88Cc72681a16a26fe380e4 on Base Sepolia,
#   0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a on Base

npx hardhat deploy --network base_sepolia
```

The constructor takes one argument, the aggregator address. There is no LINK token address to set.

## Running a Demo Query

After deploying the DemoClient:

```bash
# Run a query (submits a request, polls for results, publishes)
HARDHAT_NETWORK=base_sepolia node scripts/query-demo.js <demoClientAddress>
```

The DemoClient is not funded in advance. The account that runs the script pays the prepayment with the request and needs ETH for it and for gas.

The `query-demo.js` script:

1. Checks for a pending request (`currentAggId != 0`)
2. If one is pending: publishes it if it has a result, clears it if it failed, otherwise polls `getEvaluation()` every 20 seconds
3. If none is pending: reads `quote()`, calls `request()` with that amount of ETH, then polls for results
4. On completion: calls `publish()` to emit the `Result` event and clear the state

Two things to know before running it:

- The script does not call `finalizeEvaluationTimeout()`. If the round times out, the script keeps polling until someone closes the round, for example with the aggregator project's [`scripts/refund.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/scripts/refund.js) (`AGG_ID=<id>`).
- `request()` needs the gas headroom described in [Step 3](#step-3-submit-a-request). If your copy of the script sends a fixed gas limit of 3,000,000, raise it: on forks of both networks on 2026-11-22 the request ran out of gas with that limit.

## Common Integration Patterns

The patterns below use the interface from Step 1.

### One-Request-at-a-Time (DemoClient Pattern)

Track a single active request. Simple state management.

```solidity
contract SingleRequestClient {
    IReputationAggregator public immutable agg;
    bytes32 public currentRequestId;

    uint256 public constant MAX_ORACLE_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    event Collected(bytes32 indexed requestId, bool failed, uint256[] scores);

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
    }

    function submit(string[] calldata cids) external payable {
        require(currentRequestId == bytes32(0), "already pending");
        currentRequestId = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, MAX_ORACLE_FEE, BASE_COST, 5, 128
        );
    }

    function collect() external {
        bytes32 id = currentRequestId;
        require(id != bytes32(0), "no pending request");
        (uint256[] memory scores, , bool exists) = agg.getEvaluation(id);
        bool failed = agg.isFailed(id);
        require(exists || failed, "not ready");
        // process...
        currentRequestId = bytes32(0);
        emit Collected(id, failed, scores);
    }
}
```

### Multiple Concurrent Requests

Track requests by ID in a mapping.

```solidity
contract ConcurrentClient {
    IReputationAggregator public immutable agg;

    struct RequestData {
        address requester;
        uint256 submittedAt;
    }

    mapping(bytes32 => RequestData) public requests;

    uint256 public constant MAX_ORACLE_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
    }

    function submit(string[] calldata cids) external payable returns (bytes32 id) {
        id = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, MAX_ORACLE_FEE, BASE_COST, 5, 128
        );
        requests[id] = RequestData({requester: msg.sender, submittedAt: block.timestamp});
    }
}
```

### User-Funded Requests with Refunds

The user pays for the request. Because the refund is credited to the client contract, the contract has to pass it on. This client ends up charging each user exactly what that user's round cost: it reads the round's accounting from the aggregator with `getEthAccounting()` and pays the unspent part back.

```solidity
contract UserFundedClient {
    IReputationAggregator public immutable agg;

    uint256 public constant MAX_ORACLE_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    mapping(bytes32 => address) public payerOf;

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
    }

    function submit(string[] calldata cids) external payable returns (bytes32 id) {
        require(msg.value == agg.maxTotalFee(MAX_ORACLE_FEE), "send exactly maxTotalFee");

        // Move the refunds of earlier rounds into this contract first. With
        // no credit left in the aggregator, this round is funded by this
        // user's ETH alone, and the round's accounting is this user's
        _pullCredit();

        id = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, MAX_ORACLE_FEE, BASE_COST, 5, 128
        );
        payerOf[id] = msg.sender;
    }

    // Pay the user back what the round did not spend. Call when the round
    // has completed or has been closed after a timeout
    function settle(bytes32 id) external {
        address payer = payerOf[id];
        require(payer != address(0), "unknown or settled");

        (, , bool exists) = agg.getEvaluation(id);
        require(exists || agg.isFailed(id), "not ready");

        (uint256 received, uint256 base, uint256 bonus, , ) = agg.getEthAccounting(id);
        uint256 refund = received - base - bonus;

        delete payerOf[id];
        _pullCredit();

        (bool ok, ) = payer.call{value: refund}("");
        require(ok, "Refund failed");
    }

    function _pullCredit() internal {
        if (agg.ethOwed(address(this)) > 0) {
            agg.withdrawEth();
        }
    }

    // Withdrawals from the aggregator arrive here
    receive() external payable {}
}
```

## Error Handling

See the [Error Reference](../api/errors.md) for all possible revert conditions. The most common integration errors:

- **`InsufficientPayment()`** — The ETH sent with the request, plus the client's credit in the aggregator, is less than `maxTotalFee(maxOracleFee)`.
- **`"No active oracles available with fee <= maxFee and requested class"`** — No oracle matches your class and fee ceiling. Use a class that oracles list and a `maxOracleFee` that is at least the fee they charge.
- **`"Base cost must be less than max fee"`** — `estimatedBaseCost` must be strictly less than the fee ceiling in effect.
- **`"already pending"`** (DemoClient) — Clear the previous request via `publish()` before submitting a new one.
- **`"not ready"`** (DemoClient) — The round is still open. If it has passed its timeout, call `finalizeEvaluationTimeout()` on the aggregator first.
- **`NothingOwed()`** — `withdrawEth()` was called by a contract that has no credit.

## Next Steps

- [Integration Examples](index.md) — More client contracts, a test and frontend hooks
- [Frontend Integration](frontend.md) — How to interact with the contracts from a web frontend
- [Fee Mechanisms](../advanced/fees.md) — What a request costs in ETH
- [Oracle Selection](../advanced/oracle-selection.md) — How oracle parameters affect selection
- [Deployment Guide](../deployment/index.md) — Deploying your own contracts
