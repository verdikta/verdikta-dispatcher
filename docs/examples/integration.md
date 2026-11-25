# Smart Contract Integration Walkthrough

A complete walkthrough of a client contract that calls the v2 ReputationAggregator, pays for the evaluation in ETH, and moves its round from the request to the result.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch ([`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol)). v2 is not deployed yet: use the aggregator address set at the v2 deployment. The contracts on this page were compiled with solc 0.8.30, and the client contract and the Node script were run together against the v2 contracts on Hardhat's in-process network, with the repository's `TestOperator` standing in for the arbiters. The repository's [DemoClient](https://github.com/verdikta/verdikta-dispatcher/tree/beacon/demoClient) still speaks v1 (a 7-argument request and `maxTotalFee(fee)`) and has not been ported, so this page no longer walks through it; the `VerdiktaClient` below takes its place.

## Architecture

A client contract talks to the Verdikta system through the aggregator. The client never talks to arbiters directly: the aggregator draws the jury through the ReputationKeeper, dispatches the requests, aggregates the answers and pays everyone.

```
Your Client Contract
    │
    ├── reads maxTotalFee(maxFee, minFee, withBeacons, K, P) to size the prepayment
    ├── calls requestAIEvaluationWithApproval{value: ...}(..., withBeacons, jury)
    ├── calls drawJury(aggId) from block B+2 (it is the requester, so it earns the draw reward)
    ├── reads getRoundInfo(aggId), getJury(aggId), getEvaluation(aggId)
    ├── calls settle(aggId) on a dead round
    └── calls withdrawEth() to collect its credit
        │
        ▼
ReputationAggregator
    │
    ├── holds the prepayment for the round
    ├── draws the jury via ReputationKeeper (and JuryBeacons, if asked)
    ├── dispatches Chainlink requests (which carry no LINK)
    ├── closes the commit phase, promotes M commits, aggregates N reveals
    ├── reports every juror's outcome to the keeper at settlement
    └── credits fees, bonuses, rewards and the requester's refund
        in its ethOwed ledger
```

Anyone may call `drawJury`, `closeCommits`, `promote` and `settle`. In practice your application sends them, from the client contract or from an account it runs, because nothing else is guaranteed to.

## The Client Contract

`VerdiktaClient` tracks one request at a time, as the v1 DemoClient did. Put the [interface from Integration Examples](index.md#the-interface) above it in the same file.

```solidity
contract VerdiktaClient {
    IReputationAggregator public immutable agg;
    address public immutable owner;
    string[] private cids;
    bytes32 public currentAggId;

    uint256 public constant MAX_FEE = 15e13;     // fee ceiling: 0.00015 ETH per arbiter
    uint256 public constant BASE_COST = 8e9;     // below the ceiling
    uint64 public constant CLASS = 128;

    event Requested(bytes32 id);
    event Result(bytes32 id, uint256[] scores, string justif);
    event Failed(bytes32 id, uint8 phase);

    constructor(address aggregator, string memory cid) {
        agg = IReputationAggregator(aggregator);
        owner = msg.sender;
        cids.push(cid);
    }

    // Small: 6 drawn, 5 promoted, 4 counted, a cluster of 3, 300 s from the draw
    function jury() public pure returns (IReputationAggregator.Jury memory) {
        return IReputationAggregator.Jury({K: 6, M: 5, N: 4, P: 3, timeout: 300});
    }

    // Worst-case ETH to send with request()
    function quote() external view returns (uint256) {
        return agg.maxTotalFee(MAX_FEE, 0, false, 6, 3);
    }

    // Escrow only: funded with the ETH sent with this call and with
    // any credit this contract already holds in the aggregator
    function request() external payable {
        require(currentAggId == bytes32(0), "already pending");
        currentAggId = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids,       // IPFS CIDs of the query package
            "",         // no addendum text
            500,        // alpha: equal weight on quality and timeliness
            MAX_FEE,
            0,          // no fee floor
            BASE_COST,
            5,          // maxFeeBasedScalingFactor
            CLASS,
            false,      // no beacons
            jury()
        );
        emit Requested(currentAggId);
    }

    // From block B+2. Anyone may call it; this contract is the requester, so a
    // draw through it within 30 s credits it the draw reward (2 x MAX_FEE)
    function draw(bytes32 aggId) external {
        agg.drawJury(aggId);
    }

    // Publish the result, or clear a round that failed. A round that is still
    // open at its deadline is dead: settle it first, which credits the refund
    function publish() external {
        bytes32 id = currentAggId;
        require(id != bytes32(0), "nothing pending");
        (uint256[] memory s, string memory j, bool valid) = agg.getEvaluation(id);
        if (valid) {
            emit Result(id, s, j);
            currentAggId = bytes32(0);
            return;
        }
        (uint8 phase, , , , , , , , uint256 deadline, , , ) = agg.getRoundInfo(id);
        if (phase >= 3 && phase <= 5 && block.timestamp > deadline) {
            agg.settle(id);
            phase = 8;
        }
        if (phase == 8 || phase == 9) {
            emit Failed(id, phase);
            currentAggId = bytes32(0);
            return;
        }
        revert("not ready");
    }

    // Pull this contract's credit out of the aggregator and pay it to the owner
    function reclaim() external {
        require(msg.sender == owner, "not owner");
        agg.withdrawEth();
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "transfer failed");
    }

    receive() external payable {}
}
```

## Step-by-Step Integration Guide

### Step 1: Choose the Jury

Every request carries its own jury, `Jury {K, M, N, P, timeout}`:

| Field | Meaning | Small |
|-------|---------|-------|
| `K` | arbiters drawn, each paid its fee at the draw | 6 |
| `M` | commits promoted to reveal, drawn at random from all commits | 5 |
| `N` | reveals counted; the N-th finalizes the round | 4 |
| `P` | cluster size; the cluster's mean is the result and its members earn the bonus | 3 |
| `timeout` | seconds from the draw to the round's deadline | 300 |

The aggregator checks it on every request and reverts with `BadJury()` unless `K ≥ M ≥ N ≥ P ≥ 1`, `N ≤ 40`, `P ≥ 2` unless `N = 1`, `K ≤ maxJury()` and `K ≤` the keeper's `shortlistSize()`, and `tPlus() < timeout ≤ maxTimeout()`, with the timeout at most one day (86,400 s) whatever `maxTimeout()` says. The bounty program's presets (Small 6/5/4/3/300 s, Medium 8/5/4/3/300 s, Large 21/16/13/10/300 s, Jumbo 50/38/27/17/600 s with beacons) are sized against collusion in [TODO.md item 15](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/TODO.md); a larger jury costs more and is harder to steer. See [Security Model](../advanced/security.md#collusion-and-jury-size).

If fewer than K arbiters are eligible, the draw does not fail: it repeats the eligible ones (slot k holds pick k mod m). A repeated arbiter is paid and scored once per slot and can decide a thin round alone, so check the pool before relying on a round: the keeper's `eligibleCount(class, maxFee)` counts the arbiters eligible now.

### Step 2: Fund the Request

Every request is funded with `maxTotalFee(maxFee, minFee, withBeacons, K, P)`, the worst case for one round:

```
eff        = min(maxFee, maxOracleFee())          the fee ceiling
juror      = max(eff, minFee)                     the most a juror (or a beacon) can be paid
prepayment = juror × (K + B × P [+ beacon quorum]) + eff × (drawRewardFees + promoteRewardFees)
```

With the default settings (bonus multiplier B = 3, draw reward 2, promote reward 1) and the client's Small jury at a ceiling of 0.00015 ETH, that is `0.00015 × (6 + 9) + 0.00015 × 3` = 0.0027 ETH, which is what `quote()` returns. [Fee Mechanisms](../advanced/fees.md) works through the arithmetic and what comes back.

The aggregator takes from the caller's existing credit (`ethOwed(caller)`) only what the ETH sent does not cover, and returns any excess to credit. If the two together are too little, the request reverts with `InsufficientPayment()`.

**Option A: pass on what the caller sends (the pattern above).** The caller reads `quote()` and sends that amount.

**Option B: pay from the contract's own balance.**

```solidity
uint256 required = agg.maxTotalFee(MAX_FEE, 0, false, 6, 3);
uint256 credit = agg.ethOwed(address(this));
uint256 value = required > credit ? required - credit : 0;
aggId = agg.requestAIEvaluationWithApproval{value: value}(/* ... */);
```

See `FeeManagedIntegration` in the [Integration Examples](index.md#2-fee-management).

In both cases **the client contract is the requester**. Whatever the round does not spend is credited to the client contract in the aggregator, not to the user who called it.

### Step 3: Submit the Request

```solidity
bytes32 aggId = agg.requestAIEvaluationWithApproval{value: value}(
    cids,               // string[] - IPFS CIDs of the query package(s)
    addendumText,       // string   - optional additional context
    alpha,              // uint256  - reputation weight (0-1000)
    maxFee,             // uint256  - fee ceiling per arbiter, in ETH wei
    minFee,             // uint256  - fee floor per juror, in ETH wei (0 = none)
    estimatedBaseCost,  // uint256  - base cost for fee weighting, in ETH wei
    maxFeeScaling,      // uint256  - max fee advantage for cheap arbiters
    requestedClass,     // uint64   - arbiter class to use
    withBeacons,        // bool     - draw the jury with beacon values too
    jury                // Jury     - K, M, N, P, timeout
);
```

| Parameter | VerdiktaClient value | Notes |
|-----------|----------------------|-------|
| `cids` | one CID | 1 to 10 CIDs, each at most 100 bytes, pointing to query packages the arbiters can read |
| `alpha` | 500 | 0 to 1000. Higher values give timeliness more weight, lower values give quality more weight |
| `maxFee` | 0.00015 ETH (`15e13`) | Arbiters posting more are not eligible. A value above `maxOracleFee()` (0.0004 ETH by default) is lowered to it. It sizes the prepayment, not the price |
| `minFee` | 0 | Each juror is paid `max(posted fee, minFee)`, and its bonus scales off that. It may exceed the ceiling |
| `estimatedBaseCost` | `8e9` wei | Must be below the ceiling in effect, or `BadInput()` |
| `maxFeeScaling` | 5 | How much to prefer cheaper arbiters, 1 to 65,535 |
| `requestedClass` | 128 | A class that registered arbiters list |
| `withBeacons` | false | Reverts if set while the aggregator has no beacon contract. See [Oracle Selection](../advanced/oracle-selection.md#beacons) |
| `jury` | Small | Step 1 |

The request only escrows and records the query in its block, B. It also settles rounds that are due, in queue order, until `settlePerRequest()` (2) × its own K jury slots are spent (the last round settled may overshoot by its own K), so its gas varies: estimate it and add headroom.

### Step 4: Draw the Jury

From block B+2, `drawJury(aggId)` draws the jury from `keccak256(aggId, blockhash(B+1))` and the keeper's state as of block B, and sends the K commit requests. The result does not depend on who calls it or when. It pays a draw reward of 2 × the ceiling: to the requester if it draws within 30 seconds (`requesterDrawPriority()`), otherwise to whoever draws after 30 seconds; a third party drawing earlier earns nothing, and the reward then stays in the requester's refund. Since the client contract is the requester, draw through its `draw()` passthrough.

Two limits apply:

- **Seal the seed in time.** `blockhash(B+1)` stays readable for 8,191 blocks (about 27 minutes on Base). `drawJury` stores it, and so does `sealSeed(aggId)`.
- **Draw within a day.** After that `drawJury` reverts with `DrawExpired()`.

A round that misses either can only be closed with `cancelUnsealed(aggId)`, and its whole prepayment goes to the arbiter pool: a refund would be a free re-roll of the jury.

With `withBeacons`, the first `drawJury` starts the beacon stage and the jury is drawn by a second call once the beacon values are in (or the 120-second beacon deadline has passed, which ends the round with no result).

### Step 5: Move the Round On

After the draw the jurors commit. The commit phase closes by itself at the M+-th commit (M+ = M + ⌈(K − M)/2⌉, 6 for Small), or with any commit that brings the count to at least M once T+ (`tPlus()`, 155 seconds) has passed since the draw. If no commit arrives after T+, someone has to call `closeCommits(aggId)`. From two blocks after the close, someone calls `promote(aggId)`, which draws M of the commits at random and asks them to reveal; its caller earns 1 × the ceiling. Promoted jurors get at least `revealWindow()` (120 seconds) to reveal, and the N-th counted reveal finalizes the round.

`getRoundInfo(aggId)` returns everything a driver needs: the phase, `requestBlock`, `sealedHash`, `closeBlock`, the escrow amounts, `deadline` and `windowEnd` (both 0 until the draw), `commits` and `requestTime`. The [round lifecycle table](index.md#the-round-lifecycle) gives the call due in each phase. This Node script drives a `VerdiktaClient` round with the `readStatus` helper from [Integration Examples](index.md#frontend-integration-examples) (saved as `verdikta.js`):

```javascript
// drive.mjs: node drive.mjs <clientAddress> <aggId>   (RPC_URL and PRIVATE_KEY in the environment)
import { ethers } from 'ethers';
import { AGGREGATOR_ABI, readStatus } from './verdikta.js';

const CLIENT_ABI = [
    'function agg() view returns (address)',
    'function draw(bytes32 aggId)'
];

// Sends each call when it is due, until the round has a result or is closed
export async function driveRound(signer, clientAddress, aggId, { intervalMs = 5000, log = console.log } = {}) {
    const client = new ethers.Contract(clientAddress, CLIENT_ABI, signer);
    const agg = new ethers.Contract(await client.agg(), AGGREGATOR_ABI, signer);
    for (;;) {
        const st = await readStatus(agg, aggId);
        if (st.next) {
            try {
                // the draw goes through the client, which is the requester and earns the reward
                const tx = st.next === 'drawJury' ? await client.draw(aggId) : await agg[st.next](aggId);
                await tx.wait();
                log(`${st.status}: sent ${st.next}`);
            } catch (e) {
                log(`${st.status}: ${st.next} failed (${e.shortMessage ?? e.message}); retrying`);
            }
            continue;
        }
        if (['final', 'settled', 'failed', 'cancelled'].includes(st.status)) return st;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const [clientAddress, aggId] = process.argv.slice(2);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, new ethers.JsonRpcProvider(process.env.RPC_URL));
    const st = await driveRound(signer, clientAddress, aggId);
    console.log(st.status, st.likelihoods ?? '');
}
```

A call can fail because another account sent the same step first (it then reverts with `WrongPhase()`); the script reads the phase again and carries on.

### Step 6: Read the Result

The result is readable from finalization (phase 6), before settlement:

```solidity
(uint256[] memory likelihoods, string memory justificationCIDs, bool valid) =
    agg.getEvaluation(aggId);

if (valid) {
    // likelihoods: the cluster's mean, one value per outcome of the query package
    // justificationCIDs: comma-separated IPFS CIDs, one per clustered arbiter
    processResult(likelihoods, justificationCIDs);
}

// Every counted juror's own score for one outcome, in reveal order, for a Q-of-N rule
(uint256[] memory scores, bool ok) = agg.getOutcomeScores(aggId, 0);

// The jury the round was requested with
(uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) = agg.getJury(aggId);
```

Scores are on the arbiters' 0 to 1,000,000 scale. A reveal may hold a single value; when that is the most common length, the round is clustered in one dimension.

### Step 7: Close a Dead Round

A round that is still in the commit, closing or reveal phase at its `deadline` has no result and never will. It stays open until someone calls:

```solidity
agg.settle(aggId);
```

Before the deadline `settle` reverts with `NotDue()`. It marks the round failed (`isFailed(aggId)` returns true), reports every juror's outcome to the keeper, and credits the unspent prepayment back, either to the requester or, when M commits arrived but the round was never promoted, in equal shares to the slots that committed (`CommitPayment`; the indivisible remainder goes to the arbiter pool). The base fees credited at the draw stay with the jurors. New requests also settle due rounds, in queue order until `settlePerRequest()` × their own K slots are spent, but the walk stops at the first round not yet past its deadline, so a round behind a long-timeout round waits for it: call `settle` yourself rather than rely on that. The refund waits until the round is settled. Nothing is retried: send a new request if you still need the evaluation. `VerdiktaClient.publish()` makes the call itself.

### Step 8: Collect the Credit

Refunds and the draw reward are credits in the aggregator's `ethOwed` ledger, in the name of the client contract. Either leave a credit, which pays for the contract's next request before new ETH is asked for, or withdraw it: `withdrawEth()` sends the caller's whole credit to the caller, so the client contract must make the call and must be able to receive and pass on ETH (`reclaim()` above).

At the Small settings above, with every juror posting 0.00002 ETH and the client drawing its own round, a completed round credits the client 0.00195 ETH of refund and 0.0003 ETH of draw reward, so it cost 0.00045 ETH, of which 0.00015 ETH was the promote reward of whoever promoted.

## Deployment

```bash
npx hardhat compile
```

Deploy `VerdiktaClient(aggregator, cid)` with your usual tool. Its constructor takes the aggregator address, set at the v2 deployment, and the CID of the query package. There is no LINK token address to set.

## Common Integration Patterns

The patterns below use the interface from [Integration Examples](index.md#the-interface).

### Multiple Concurrent Requests

Track requests by ID in a mapping. Each draw goes through the contract so that it keeps the draw rewards.

```solidity
contract ConcurrentClient {
    IReputationAggregator public immutable agg;

    struct RequestData {
        address requester;
        uint256 submittedAt;
    }

    mapping(bytes32 => RequestData) public requests;

    uint256 public constant MAX_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
    }

    function submit(string[] calldata cids, IReputationAggregator.Jury calldata jury)
        external payable returns (bytes32 id)
    {
        id = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, MAX_FEE, 0, BASE_COST, 5, 128, false, jury
        );
        requests[id] = RequestData({requester: msg.sender, submittedAt: block.timestamp});
    }

    function draw(bytes32 id) external {
        require(requests[id].requester != address(0), "unknown request");
        agg.drawJury(id);
    }
}
```

### User-Funded Requests with Exact Refunds

When users pay for their own requests, each user's refund should go back to that user. A client contract that makes every request itself cannot tell from the aggregator where a failed round's refund went: it may have gone to the committers or the arbiter pool, and a refund may land inside somebody else's request (which settles due rounds). The simple exact way is one small wallet contract per request: the wallet is the requester, so its credit is exactly what its round returned. This is the bounty program's `EvaluationWallet` pattern. (A refund beneficiary set in the request, TODO item 3, is not built.)

```solidity
contract RequestWallet {
    IReputationAggregator public immutable agg;
    address public immutable payer;
    address public immutable factory;
    bytes32 public aggId;

    constructor(IReputationAggregator agg_, address payer_) {
        agg = agg_;
        payer = payer_;
        factory = msg.sender;
    }

    function request(string[] calldata cids, IReputationAggregator.Jury calldata jury) external payable {
        require(msg.sender == factory && aggId == bytes32(0), "once, by the factory");
        aggId = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, 15e13, 0, 8e9, 5, 128, false, jury
        );
    }

    // anyone; within 30 s of the request this earns the draw reward for the payer
    function draw() external {
        agg.drawJury(aggId);
    }

    // after the round has closed: the refund (and the draw reward) go to the payer
    function reclaim() external {
        (uint8 phase, , , , , , , , , , , ) = agg.getRoundInfo(aggId);
        require(phase >= 6, "round open");
        if (agg.ethOwed(address(this)) > 0) agg.withdrawEth();
        (bool ok, ) = payer.call{value: address(this).balance}("");
        require(ok, "refund failed");
    }

    receive() external payable {}
}

contract UserFundedClient {
    IReputationAggregator public immutable agg;
    mapping(bytes32 => RequestWallet) public walletOf;

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
    }

    function submit(string[] calldata cids) external payable returns (bytes32 id) {
        IReputationAggregator.Jury memory jury = IReputationAggregator.Jury({K: 6, M: 5, N: 4, P: 3, timeout: 300});
        require(msg.value == agg.maxTotalFee(15e13, 0, false, jury.K, jury.P), "send exactly maxTotalFee");
        RequestWallet w = new RequestWallet(agg, msg.sender);
        w.request{value: msg.value}(cids, jury);
        id = w.aggId();
        walletOf[id] = w;
    }
}
```

A finished round (phase 6) credited its refund at finalization, and nothing more is credited to the requester after that, so `reclaim()` at phase 6 is final. A failed round (phase 8) credited its refund at the draw or at settlement, unless it went to the committers or the arbiter pool. A cancelled round (phase 9) returns nothing.

## Error Handling

See the [Error Reference](../api/errors.md) for all revert conditions. The most common integration errors:

- **`InsufficientPayment()`**: the ETH sent with the request, plus the client's credit, is less than `maxTotalFee(maxFee, minFee, withBeacons, K, P)` for the request's jury.
- **`BadJury()`** (from `AggregatorLib`): the jury breaks one of the rules in [Step 1](#step-1-choose-the-jury). Include `error BadJury()` in your ABI to decode it.
- **`BadInput()`**: `estimatedBaseCost` is not below the ceiling in effect, `alpha` is above 1000, the scaling factor is 0 or above 65,535, or the escrow does not fit in 88 bits.
- **`TooEarly()`**: `drawJury` before block B+2 (or, in the beacon stage, before the quorum is in or the beacon deadline has passed), or `promote` before block C+2.
- **`WrongPhase()`**: the step is not due in this phase, for example `closeCommits` before T+ or with fewer than M commits, or a second `promote`.
- **`NotDue()`**: `settle` before the round's deadline.
- **`DrawExpired()`** / **`SeedExpired()`**: the draw came too late; only `cancelUnsealed` is left.
- **`NothingOwed()`**: `withdrawEth()` by an address with no credit.

There is no "no arbiters" error at request time. A draw that finds no eligible arbiter fails the round (phase 8) and refunds the requester.

## Next Steps

- [Integration Examples](index.md): more client contracts, a test and frontend hooks
- [Frontend Integration](frontend.md): how to drive a round from a web frontend
- [Fee Mechanisms](../advanced/fees.md): what a request costs in ETH
- [Oracle Selection](../advanced/oracle-selection.md): how the jury is drawn
- [Deployment Guide](../deployment/index.md): deploying the v2 contracts
