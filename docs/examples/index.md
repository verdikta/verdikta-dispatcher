# Integration Examples

This section provides examples for integrating with the Verdikta Dispatcher smart contracts. Choose the example that best matches your use case and technical requirements.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch: [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol), [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol) and [`JuryBeacons.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/JuryBeacons.sol). v2 is not deployed yet, so no v2 address exists: use the address set at the v2 deployment. Every Solidity example on this page was compiled with solc 0.8.30, the JavaScript helpers and the Hardhat test were run against the v2 contracts on Hardhat's in-process network (with the repository's `TestOperator` standing in for the arbiters' operators), and the React and Vue examples were syntax-checked. The examples use the ReputationAggregator, which is paid in ETH sent with the request: there is no LINK to hold and no token to approve. For the v1 interface (7-argument request, `maxTotalFee(fee)`, `finalizeEvaluationTimeout`) see the `aggregator-v0.1.0` tag; [MIGRATION.md](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md) lists every change.

## What Changed in v2

- **The jury goes with each request.** Every request carries a `Jury {K, M, N, P, timeout}`: K arbiters drawn, M of their commits promoted, N reveals counted, a cluster of P, and the round timeout in seconds from the draw. One aggregator serves every jury size. Read a round's jury back with `getJury(aggId)`.
- **The quote takes the jury.** `maxTotalFee(maxFee, minFee, withBeacons, K, P)`.
- **The request only escrows.** The jury is drawn by a separate call, `drawJury(aggId)`, from two blocks after the request. The round then needs `closeCommits` (sometimes) and `promote` before the arbiters reveal. Anyone may send each of these calls; the draw and `promote` pay their caller.
- **A dead round is closed with `settle(aggId)`** after its deadline (it replaces v1's `finalizeEvaluationTimeout`), and anyone may call it. Every new request also settles due rounds.

The [Round Lifecycle](#the-round-lifecycle) below gives the calls in order. [Fee Mechanisms](../advanced/fees.md) explains the quote and the refunds, and the [ReputationAggregator](../contracts/reputation-aggregator.md) page and the [API reference](../api/index.md) list every function, event and error.

## Before You Start

The examples share a few values.

| Value | Used here | Where it comes from |
|-------|-----------|---------------------|
| Jury | Small: `K 6, M 5, N 4, P 3`, timeout 300 s | The bounty program's class presets ([`shared/classPresets.js`](https://github.com/verdikta/verdikta-applications/blob/beacon/example-bounty-program/shared/classPresets.js)): Small 6/5/4/3/300 s, Medium 8/5/4/3/300 s, Large 21/16/13/10/300 s, Jumbo 50/38/27/17/600 s with beacons. They are application presets, not protocol constants: any jury the aggregator accepts will do (see below) |
| Fee ceiling per arbiter (`maxFee`) | 0.00015 ETH (`15e13` wei) | Arbiters that post a higher fee are not eligible. A value above the contract's `maxOracleFee()` (0.0004 ETH by default) is lowered to it |
| Fee floor (`minFee`) | 0 (none) | Each juror is paid at least this. See [Fee Mechanisms](../advanced/fees.md#the-fee-floor) |
| Base cost (`estimatedBaseCost`) | `8e9` wei | Must be below the fee ceiling in effect, or the request reverts with `BadInput()` |
| Arbiter class (`requestedClass`) | 128 | Must be a class that registered arbiters list. v1's arbiters on Base listed 128; v2 arbiters register their classes again |
| Beacons (`withBeacons`) | false | The bounty program sets it for Jumbo only. See [Oracle Selection](../advanced/oracle-selection.md#beacons) |
| ETH to send | `maxTotalFee(maxFee, minFee, withBeacons, K, P)` | For Small at the ceiling above: `15e13 × (6 + 3 × 3) + 15e13 × (2 + 1)` = 0.0027 ETH. A worst-case budget: the rest comes back as credit |
| Aggregator | set at the v2 deployment | [Deployment Guide](../deployment/index.md) |

A jury the aggregator accepts satisfies `K ≥ M ≥ N ≥ P ≥ 1`, `N ≤ 40`, `P ≥ 2` unless `N = 1`, `K ≤ maxJury()` (50 by default) and `K ≤` the keeper's `shortlistSize()` (60), and `tPlus() < timeout ≤ maxTimeout()` (155 s and 3,600 s by default), with the timeout never above one day (86,400 s) whatever `maxTimeout()` says. Anything else reverts with `BadJury()`.

Three more points apply to every example:

- **The evidence CIDs must point to query packages the arbiters can read.** A CID of an arbitrary file gets no answer and the round fails.
- **A contract that makes the request is the requester.** The unspent prepayment is credited to the contract, not to the user who called it, and only the requester earns the draw reward in the first 30 seconds. A client contract therefore needs to call `drawJury` itself (or through a passthrough, as below) and to do something with its credit.
- **Somebody has to move the round on.** Nothing happens after the request until `drawJury` is called. Your application should send the calls itself rather than wait for a third party.

## The Round Lifecycle

`getRoundInfo(aggId)` returns the phase and the timing a client needs. The calls, in order:

| Phase | Meaning | Next call | When |
|-------|---------|-----------|------|
| 1 draw | escrowed, awaiting the draw | `drawJury(aggId)` | from block `requestBlock + 2`, and within a day of the request |
| 2 beacons | beacon stage (requests with `withBeacons` only) | `drawJury(aggId)` again | once `JuryBeacons.result(aggregator, aggId)` is ready (state 2) or expired (state 3) |
| 3 commit | jurors commit | `closeCommits(aggId)` | only if the phase is still open after `windowEnd` (the request's T+ after the draw; 0 until the draw) with at least M commits; the M+-th commit closes it by itself |
| 4 closing | commit phase closed | `promote(aggId)` | from block `closeBlock + 2` |
| 5 reveal | promoted jurors reveal | none | the N-th counted reveal finalizes the round |
| 6 final | result readable | `settle(aggId)` (optional) | after `deadline` |
| 7 settled, 8 failed, 9 cancelled | closed | none | |

A round that is still in phase 3, 4 or 5 at its `deadline` is dead: `settle(aggId)` closes it as failed and reports the jurors' outcomes to the keeper. A round still in phase 1 or 2 a day after the request can only be closed with `cancelUnsealed(aggId)`, and its whole prepayment then goes to the treasury. See [Fee Mechanisms](../advanced/fees.md#refunds-and-the-treasury) for where the money goes in each case.

## The Interface

The Solidity examples below use this interface. Put it in the same file, above the example contract.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IReputationAggregator {
    /// K drawn, M promoted, N counted, P clustered; timeout in seconds from the draw
    struct Jury {
        uint8 K;
        uint8 M;
        uint8 N;
        uint8 P;
        uint40 timeout;
    }

    // Payable: the ETH that funds the round travels with the call. Only escrows:
    // the jury is drawn by drawJury from block B+2
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxFee,
        uint256 minFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass,
        bool withBeacons,
        Jury calldata jury
    ) external payable returns (bytes32 aggId);

    // Worst-case ETH (wei) for one round with this fee ceiling, floor, beacon flag and jury
    function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P)
        external view returns (uint256);

    // The round's steps. Anyone may call each of them
    function drawJury(bytes32 aggId) external;
    function closeCommits(bytes32 aggId) external;
    function promote(bytes32 aggId) external;
    function settle(bytes32 aggId) external;
    function cancelUnsealed(bytes32 aggId) external;

    function getRoundInfo(bytes32 aggId)
        external view returns (
            uint8 phase,
            uint256 requestBlock,
            bytes32 sealedHash,
            uint256 closeBlock,
            uint256 received,
            uint256 baseFees,
            uint256 bonuses,
            uint256 rewards,
            uint256 deadline,
            uint256 windowEnd,
            uint256 commits,
            uint256 requestTime
        );

    function getJury(bytes32 aggId)
        external view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout);

    // valid from finalization (phase 6), before settlement
    function getEvaluation(bytes32 aggId)
        external view returns (uint256[] memory likelihoods, string memory justifications, bool valid);

    // every counted reveal's score for one outcome, for a Q-of-N rule
    function getOutcomeScores(bytes32 aggId, uint256 outcome)
        external view returns (uint256[] memory scores, bool valid);

    function isFailed(bytes32 aggId) external view returns (bool);

    // ETH (wei) the aggregator holds for an address: refunds, rewards, arbiter earnings
    function ethOwed(address payee) external view returns (uint256);

    // Send the caller's whole ethOwed balance to the caller
    function withdrawEth() external;
}
```

## Quick Start Examples

### 1. Simple Content Moderation

A basic content filter. The caller sends the prepayment with the call, and the contract draws the jury itself so that it keeps the draw reward.

```solidity
contract ContentModerator {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_FEE = 15e13;   // 0.00015 ETH per arbiter at most
    uint256 public constant BASE_COST = 8e9;   // below MAX_FEE

    mapping(bytes32 => string) public contentOf;    // request => content CID
    mapping(string => bool) public approvedContent;

    event ModerationRequested(bytes32 indexed requestId, string contentCid);
    event ModerationResult(bytes32 indexed requestId, string contentCid, bool approved);

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    // Small: 6 drawn, 5 promoted, 4 counted, a cluster of 3, 300 s from the draw
    function jury() public pure returns (IReputationAggregator.Jury memory) {
        return IReputationAggregator.Jury({K: 6, M: 5, N: 4, P: 3, timeout: 300});
    }

    // Worst-case ETH to send with moderateContent()
    function quote() external view returns (uint256) {
        return aggregator.maxTotalFee(MAX_FEE, 0, false, 6, 3);
    }

    function moderateContent(string calldata contentCid) external payable returns (bytes32 requestId) {
        string[] memory evidence = new string[](1);
        evidence[0] = contentCid;

        // Reverts with InsufficientPayment() if msg.value, plus any credit this
        // contract already holds in the aggregator, is less than quote()
        requestId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence,
            "Content moderation check",
            500,        // alpha: equal weight on quality and timeliness
            MAX_FEE,
            0,          // no fee floor
            BASE_COST,
            5,          // max fee scaling
            128,        // arbiter class
            false,      // no beacons
            jury()
        );

        contentOf[requestId] = contentCid;
        emit ModerationRequested(requestId, contentCid);
    }

    // From two blocks after the request. This contract is the requester, so a
    // draw through it within 30 s earns the draw reward (2 x MAX_FEE) as credit
    function draw(bytes32 requestId) external {
        aggregator.drawJury(requestId);
    }

    // Call once the aggregator has emitted FulfillAIEvaluation for requestId
    function recordResult(bytes32 requestId) external {
        string memory contentCid = contentOf[requestId];
        require(bytes(contentCid).length > 0, "Unknown request");

        (uint256[] memory likelihoods, , bool valid) = aggregator.getEvaluation(requestId);
        require(valid, "Evaluation not ready");

        // This example assumes a query package with two outcomes, "approve" first.
        // What each position means is defined by your own query package.
        bool approved = likelihoods[0] > likelihoods[1];
        approvedContent[contentCid] = approved;
        delete contentOf[requestId];
        emit ModerationResult(requestId, contentCid, approved);
    }
}
```

The draw is not the only step. Unless the M+-th commit closes the commit phase by itself, someone calls `closeCommits`, and someone calls `promote`. Any account can send those straight to the aggregator; the [JavaScript helpers](#frontend-integration-examples) below do it.

### 2. Dispute Resolution System

A dispute with an amount at stake. The ETH the caller sends covers two things, and the contract keeps them apart: the evaluation prepayment goes to the aggregator, the amount in dispute stays in the contract. A dead round is closed with `settle`, and the dispute's money goes back to the plaintiff.

```solidity
contract DisputeResolver {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    struct Dispute {
        address plaintiff;
        address defendant;
        uint256 amount;       // ETH in dispute, held by this contract
        bool resolved;
    }

    mapping(bytes32 => Dispute) public disputes;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function _jury() internal pure returns (IReputationAggregator.Jury memory) {
        return IReputationAggregator.Jury({K: 8, M: 5, N: 4, P: 3, timeout: 300});   // Medium
    }

    function prepayment() public view returns (uint256) {
        return aggregator.maxTotalFee(MAX_FEE, 0, false, 8, 3);
    }

    function createDispute(string[] calldata evidence, address defendant)
        external payable returns (bytes32 evalId)
    {
        uint256 pre = prepayment();
        require(msg.value > pre, "Send the prepayment plus the amount in dispute");

        evalId = aggregator.requestAIEvaluationWithApproval{value: pre}(
            evidence, "Dispute resolution request", 500, MAX_FEE, 0, BASE_COST, 5, 128, false, _jury()
        );

        disputes[evalId] = Dispute({
            plaintiff: msg.sender,
            defendant: defendant,
            amount: msg.value - pre,
            resolved: false
        });
    }

    function draw(bytes32 evalId) external {
        aggregator.drawJury(evalId);
    }

    // Pay out once there is a result, or return the money once the round has failed
    function resolve(bytes32 evalId) external {
        Dispute storage d = disputes[evalId];
        require(d.plaintiff != address(0) && !d.resolved, "Unknown or resolved");

        (uint256[] memory likelihoods, , bool valid) = aggregator.getEvaluation(evalId);
        address to;
        if (valid) {
            // outcome 0: the plaintiff is right (defined by the query package)
            to = likelihoods[0] > likelihoods[1] ? d.plaintiff : d.defendant;
        } else {
            (uint8 phase, , , , , , , , uint256 deadline, , , ) = aggregator.getRoundInfo(evalId);
            // a dead round (commit, closing or reveal at its deadline): close it first
            if (phase >= 3 && phase <= 5 && block.timestamp > deadline) aggregator.settle(evalId);
            require(aggregator.isFailed(evalId), "Evaluation not ready");
            to = d.plaintiff;
        }
        d.resolved = true;
        (bool ok, ) = to.call{value: d.amount}("");
        require(ok, "Transfer failed");
    }
}
```

`isFailed` is true only for phase 8. A round cancelled with `cancelUnsealed` (phase 9) has neither a result nor `isFailed`; draw promptly and it cannot happen.

### 3. Arbitration That Favors Quality, With a Fee Floor

The request parameters steer which arbiters are selected and what each is paid. This example gives quality more weight than timeliness, accepts every arbiter up to the contract's own fee ceiling, and sets a fee floor, so every juror is paid at least 0.0001 ETH whatever it posts.

```solidity
contract QualityArbitration {
    IReputationAggregator public immutable aggregator;

    // The contract's own ceiling, maxOracleFee(), is 0.0004 ETH by default.
    // A higher value passed here is lowered to it.
    uint256 public constant MAX_FEE = 4e14;
    uint256 public constant MIN_FEE = 1e14;    // each juror is paid at least this

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function _jury() internal pure returns (IReputationAggregator.Jury memory) {
        return IReputationAggregator.Jury({K: 21, M: 16, N: 13, P: 10, timeout: 300});   // Large
    }

    // 4e14 x (21 + 3 x 10) + 4e14 x (2 + 1) = 0.0216 ETH with the default settings
    function quote() external view returns (uint256) {
        return aggregator.maxTotalFee(MAX_FEE, MIN_FEE, false, 21, 10);
    }

    function createDispute(string[] calldata evidence, string calldata description)
        external payable returns (bytes32 aggId)
    {
        aggId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence,
            description,
            400,        // alpha below 500: more weight on quality than on timeliness
            MAX_FEE,    // accept every arbiter that posts up to the ceiling
            MIN_FEE,
            8e9,        // base cost
            5,          // max scaling
            128,        // arbiter class
            false,
            _jury()
        );
    }
}
```

A higher ceiling means a larger prepayment, not a higher cost: each juror is paid `max(its posted fee, minFee)`, and the rest comes back. See [Oracle Selection](../advanced/oracle-selection.md) for how the fee enters the selection weight.

## Integration Patterns

### Event-Driven Architecture

An off-chain service watches the aggregator's events (`FulfillAIEvaluation`, `EvaluationFailed`) and calls `processResults`.

```solidity
contract EventDrivenIntegration {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    mapping(bytes32 => address) public requesterOf;

    event EvaluationRequested(bytes32 indexed requestId, address requester);
    event EvaluationCompleted(bytes32 indexed requestId, uint256[] results);
    event EvaluationFailed(bytes32 indexed requestId);

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function submitForEvaluation(string[] calldata evidence) external payable returns (bytes32 requestId) {
        requestId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence, "", 500, MAX_FEE, 0, BASE_COST, 5, 128, false,
            IReputationAggregator.Jury({K: 6, M: 5, N: 4, P: 3, timeout: 300})
        );

        requesterOf[requestId] = msg.sender;
        emit EvaluationRequested(requestId, msg.sender);
    }

    function draw(bytes32 requestId) external {
        aggregator.drawJury(requestId);
    }

    function processResults(bytes32 requestId) external {
        require(requesterOf[requestId] != address(0), "Unknown or processed request");

        (uint256[] memory likelihoods, , bool valid) = aggregator.getEvaluation(requestId);

        if (valid) {
            delete requesterOf[requestId];
            emit EvaluationCompleted(requestId, likelihoods);
            _handleResults(requestId, likelihoods);
        } else if (aggregator.isFailed(requestId)) {
            delete requesterOf[requestId];
            emit EvaluationFailed(requestId);
        } else {
            revert("Evaluation not ready");
        }
    }

    function _handleResults(bytes32 requestId, uint256[] memory likelihoods) internal {
        // Implementation specific to your use case
    }
}
```

### Factory Pattern: One Jury per Dispute Type

One aggregator serves every jury size, so a contract can choose the jury per request. The presets here are the bounty program's.

```solidity
contract DisputeFactory {
    IReputationAggregator public immutable aggregator;

    struct DisputeConfig {
        IReputationAggregator.Jury jury;
        bool withBeacons;
        uint256 maxFee;         // fee ceiling per arbiter, in ETH wei
        uint256 minFee;         // fee floor per juror, in ETH wei (0 = none)
        uint256 alpha;          // 0-1000, higher values give timeliness more weight
        uint64 arbiterClass;
    }

    mapping(string => DisputeConfig) internal disputeTypes;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
        disputeTypes["small"] = DisputeConfig(IReputationAggregator.Jury(6, 5, 4, 3, 300), false, 15e13, 0, 500, 128);
        disputeTypes["large"] = DisputeConfig(IReputationAggregator.Jury(21, 16, 13, 10, 300), false, 4e14, 1e14, 400, 128);
        disputeTypes["jumbo"] = DisputeConfig(IReputationAggregator.Jury(50, 38, 27, 17, 600), true, 4e14, 1e14, 400, 128);
    }

    // Worst-case ETH to send with createDispute() for this type
    function quote(string calldata disputeType) public view returns (uint256) {
        DisputeConfig storage c = disputeTypes[disputeType];
        require(c.maxFee > 0, "Invalid dispute type");
        return aggregator.maxTotalFee(c.maxFee, c.minFee, c.withBeacons, c.jury.K, c.jury.P);
    }

    function createDispute(
        string calldata disputeType,
        string[] calldata evidence,
        string calldata description
    ) external payable returns (bytes32) {
        DisputeConfig storage c = disputeTypes[disputeType];
        require(c.maxFee > 0, "Invalid dispute type");

        return aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence, description, c.alpha, c.maxFee, c.minFee, 8e9, 5, c.arbiterClass, c.withBeacons, c.jury
        );
    }

    // With beacons, call it twice: to start the beacon stage, then to draw
    function draw(bytes32 aggId) external {
        aggregator.drawJury(aggId);
    }
}
```

The Jumbo type sets `withBeacons`. Its quote then includes the beacon quorum (2 by default), and it reverts if the aggregator has no beacon contract set.

## Frontend Integration Examples

Both framework examples below use ethers v6 and this module, `verdikta.js`. It sends a request, reads the round, and sends whichever step is due. The `error` lines let ethers name the aggregator's custom errors when a call reverts.

```javascript
import { ethers } from 'ethers';

export const AGGREGATOR_ABI = [
    'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury) payable returns (bytes32 aggId)',
    'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
    'function ethOwed(address payee) view returns (uint256)',
    'function beacons() view returns (address)',
    'function drawJury(bytes32 aggId)',
    'function closeCommits(bytes32 aggId)',
    'function promote(bytes32 aggId)',
    'function settle(bytes32 aggId)',
    'function cancelUnsealed(bytes32 aggId)',
    'function withdrawEth()',
    'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
    'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
    'function getEvaluation(bytes32 aggId) view returns (uint256[] likelihoods, string justifications, bool valid)',
    'function getOutcomeScores(bytes32 aggId, uint256 outcome) view returns (uint256[] scores, bool valid)',
    'function isFailed(bytes32 aggId) view returns (bool)',
    'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
    'event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward)',
    'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
    'event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase)',
    'event RoundSettled(bytes32 indexed aggRequestId, bool failed)',
    'error InsufficientPayment()',
    'error BadInput()',
    'error BadJury()',
    'error KeeperNotSet()',
    'error WrongPhase()',
    'error TooEarly()',
    'error NotDue()',
    'error SeedExpired()',
    'error DrawExpired()',
    'error NothingOwed()',
    'error EnforcedPause()'
];

const BEACONS_ABI = [
    'function result(address aggregator, bytes32 aggId) view returns (uint8 state, bytes32 mix, uint256 readyAt, address[] payees)'
];

export const PHASES = ['', 'draw', 'beacons', 'commit', 'closing', 'reveal', 'final', 'settled', 'failed', 'cancelled'];
const DAY = 86400n;          // drawJury's limit after the request (DRAW_GRACE)
const HISTORY = 8191n;       // blocks for which blockhash(B+1) stays readable (EIP-2935)

// The bounty program's presets (application settings, not protocol constants)
export const JURIES = {
    small:  { K: 6,  M: 5,  N: 4,  P: 3,  timeout: 300 },
    medium: { K: 8,  M: 5,  N: 4,  P: 3,  timeout: 300 },
    large:  { K: 21, M: 16, N: 13, P: 10, timeout: 300 },
    jumbo:  { K: 50, M: 38, N: 27, P: 17, timeout: 600 }   // with beacons
};

// Worst case for one round, and the ETH to send once the sender's credit is used
export async function quote(contract, from, { maxFee, minFee = 0n, withBeacons = false, jury }) {
    const required = await contract.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P);
    const credit = await contract.ethOwed(from);
    return { required, credit, value: required > credit ? required - credit : 0n };
}

// Sends one request and returns its ID. The request only escrows: the jury is drawn later
export async function sendRequest(contract, signer, cids, description, options = {}) {
    const jury = options.jury ?? JURIES.small;
    const maxFee = options.maxFee ?? ethers.parseEther('0.00015');   // fee ceiling per arbiter
    const minFee = options.minFee ?? 0n;                             // fee floor per juror
    const withBeacons = options.withBeacons ?? false;
    const args = [
        cids,
        description,
        options.alpha ?? 500,
        maxFee,
        minFee,
        options.baseCost ?? 8_000_000_000n,                           // 8e9 wei, below maxFee
        options.scalingFactor ?? 5,
        options.arbiterClass ?? 128,
        withBeacons,
        jury
    ];

    const { value } = await quote(contract, await signer.getAddress(), { maxFee, minFee, withBeacons, jury });

    // The request also settles due rounds, so its gas varies: add headroom
    const estimate = await contract.requestAIEvaluationWithApproval.estimateGas(...args, { value });
    const tx = await contract.requestAIEvaluationWithApproval(...args, { value, gasLimit: (estimate * 150n) / 100n });
    const receipt = await tx.wait();

    const topic = contract.interface.getEvent('RequestAIEvaluation').topicHash;
    const log = receipt.logs.find(
        l => l.address.toLowerCase() === contract.target.toLowerCase() && l.topics[0] === topic
    );
    if (!log) throw new Error('Request ID not found in transaction receipt');
    return { requestId: log.topics[1], transactionHash: tx.hash, valueSent: value };
}

// The round's phase, its jury, its result if any, and the call that is due now (or null)
export async function readStatus(contract, requestId) {
    const provider = contract.runner.provider;
    const [r, jury, latest] = await Promise.all([
        contract.getRoundInfo(requestId),
        contract.getJury(requestId),
        provider.getBlock('latest')
    ]);
    const phase = Number(r.phase);
    const block = BigInt(latest.number) + 1n;   // the earliest block a transaction sent now lands in
    const now = BigInt(latest.timestamp);
    const status = { phase, status: PHASES[phase] ?? 'unknown', jury, info: r, next: null };

    if (phase === 1 || phase === 2) {
        const sealed = r.sealedHash !== ethers.ZeroHash;
        if (sealed ? now > r.requestTime + DAY : block > r.requestBlock + 1n + HISTORY) {
            status.next = 'cancelUnsealed';                 // undrawable: prepay goes to the treasury
        } else if (phase === 1 && block >= r.requestBlock + 2n) {
            status.next = 'drawJury';
        } else if (phase === 2) {
            const beacons = new ethers.Contract(await contract.beacons(), BEACONS_ABI, provider);
            const [state] = await beacons.result(contract.target, requestId);
            if (state === 2n || state === 3n) status.next = 'drawJury';   // ready, or quorum missed
        }
    } else if (phase >= 3 && phase <= 6 && now > r.deadline) {
        status.next = 'settle';                             // after the deadline (a dead round fails)
    } else if (phase === 3 && now > r.windowEnd && r.commits >= jury.M) {
        status.next = 'closeCommits';
    } else if (phase === 4 && block >= r.closeBlock + 2n) {
        status.next = 'promote';
    }

    if (phase === 6 || phase === 7) {
        const [likelihoods, justifications] = await contract.getEvaluation(requestId);
        status.likelihoods = likelihoods.map(l => Number(l));
        status.justificationCIDs = justifications.split(',');
    }
    return status;
}

// Send the call that is due, if any. Returns its name, or null
export async function advance(contract, requestId) {
    const { next } = await readStatus(contract, requestId);
    if (!next) return null;
    const tx = await contract[next](requestId);
    await tx.wait();
    return next;
}
```

The draw and `promote` pay their caller: `drawJury` pays 2 × the round's fee ceiling (to the requester only in the first 30 seconds after the request, or after the beacon quorum), and `promote` pays 1 × the ceiling. The payment is credit in `ethOwed`, like a refund. In a client, run `advance` every few seconds from the request until the round is final; `settle` after the deadline is optional for a finished round (it reports the jurors' outcomes to the keeper; new requests may also do it, but only within their settlement budget, so don't count on them) and needed for a dead one, which only then becomes `failed` and refunds.

### React Hook for Dispute Management

```javascript
import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContract, useSigner } from './web3-hooks';
import { AGGREGATOR_ABI, sendRequest, readStatus, advance } from './verdikta';

export function useVerdiktaDispatcher(contractAddress) {
    const signer = useSigner();
    const contract = useContract(contractAddress, AGGREGATOR_ABI, signer);
    const [disputes, setDisputes] = useState({});
    const [loading, setLoading] = useState(false);

    const update = useCallback((requestId, fields) => {
        setDisputes(prev => ({ ...prev, [requestId]: { ...prev[requestId], ...fields } }));
    }, []);

    // Moves the round on (drawJury, closeCommits, promote, settle) until it is closed
    const monitorDispute = useCallback((requestId) => {
        const step = async () => {
            try {
                const sent = await advance(contract, requestId);
                const result = await readStatus(contract, requestId);
                update(requestId, { ...result, lastCall: sent, updatedAt: Date.now() });

                // stop once there is a result or the round is closed
                if (['final', 'settled', 'failed', 'cancelled'].includes(result.status)) return;
                setTimeout(step, 5000);
            } catch (error) {
                console.error('Error monitoring dispute:', error);
                setTimeout(step, 15000);   // e.g. another account sent the same call first
            }
        };
        step();
    }, [contract, update]);

    const submitDispute = useCallback(async (evidence, description, options = {}) => {
        if (!contract) throw new Error('Contract not available');

        setLoading(true);
        try {
            const { requestId, transactionHash, valueSent } =
                await sendRequest(contract, signer, evidence, description, options);

            update(requestId, {
                requestId,
                evidence,
                description,
                status: 'draw',
                submittedAt: Date.now(),
                transactionHash,
                valueSent: ethers.formatEther(valueSent)
            });

            monitorDispute(requestId);
            return requestId;
        } finally {
            setLoading(false);
        }
    }, [contract, signer, update, monitorDispute]);

    // Take the signer's credit (refunds and rewards) out of the aggregator
    const withdrawCredit = useCallback(async () => {
        const tx = await contract.withdrawEth();
        return tx.wait();
    }, [contract]);

    return { submitDispute, withdrawCredit, disputes, loading, contract };
}
```

`./web3-hooks` stands for your application's own hooks that return the connected signer and an `ethers.Contract`. `./verdikta` is the module above.

### Vue.js Composition API Example

```javascript
import { ref, computed, onMounted } from 'vue';
import { ethers } from 'ethers';
import { AGGREGATOR_ABI, JURIES, sendRequest, readStatus, advance } from './verdikta';

// uploadToIPFS: your own function that stores a query package and returns its CID
export function useVerdiktaIntegration(contractAddress, uploadToIPFS) {
    const contract = ref(null);
    const signer = ref(null);
    const disputes = ref({});
    const loading = ref(false);
    const error = ref(null);

    const openDisputes = computed(() =>
        Object.values(disputes.value).filter(d => !['final', 'settled', 'failed', 'cancelled'].includes(d.status))
    );
    const completedDisputes = computed(() =>
        Object.values(disputes.value).filter(d => d.likelihoods)
    );

    onMounted(async () => {
        try {
            const { ethereum } = window;
            if (!ethereum) throw new Error('MetaMask not found');
            const provider = new ethers.BrowserProvider(ethereum);
            signer.value = await provider.getSigner();
            contract.value = new ethers.Contract(contractAddress, AGGREGATOR_ABI, signer.value);
        } catch (err) {
            error.value = err.message;
        }
    });

    const monitorEvaluation = (requestId) => {
        const step = async () => {
            try {
                await advance(contract.value, requestId);
                const result = await readStatus(contract.value, requestId);
                disputes.value[requestId] = { ...disputes.value[requestId], ...result, updatedAt: new Date() };
                if (['final', 'settled', 'failed', 'cancelled'].includes(result.status)) return;
                setTimeout(step, 5000);
            } catch (err) {
                console.error('Monitoring error:', err);
                setTimeout(step, 15000);
            }
        };
        step();
    };

    const submitEvaluation = async (evidenceFiles, description, size = 'small') => {
        if (!contract.value) throw new Error('Contract not initialized');
        loading.value = true;
        error.value = null;
        try {
            const cids = await Promise.all(evidenceFiles.map(file => uploadToIPFS(file)));
            const { requestId, transactionHash } = await sendRequest(
                contract.value, signer.value, cids, description,
                { jury: JURIES[size], withBeacons: size === 'jumbo' }
            );
            disputes.value[requestId] = {
                requestId, evidence: cids, description, status: 'draw', submittedAt: new Date(), transactionHash
            };
            monitorEvaluation(requestId);
            return requestId;
        } catch (err) {
            error.value = err.message;
            throw err;
        } finally {
            loading.value = false;
        }
    };

    return { disputes, openDisputes, completedDisputes, loading, error, submitEvaluation };
}
```

## Testing Examples

### Unit Tests with Hardhat

The repository's test fixtures deploy the v2 contracts and drive a round the way arbiter nodes would. Save this file as `reputationBasedAggregator/test/example.test.js` and run `npx hardhat test test/example.test.js` in `reputationBasedAggregator/`.

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");

describe("ReputationAggregator v2 integration (ETH)", function () {
    const SMALL = H.jury(6, 5, 4, 3, 300);
    let core, arbs, user, driver;

    beforeEach(async function () {
        await H.installHistory();                     // EIP-2935 stand-in
        core = await H.deployCore();                  // keeper, aggregator, JuryBeacons
        arbs = await H.registerArbiters(core, 8);     // posted fee H.FEE (1e13 wei)
        [, user] = await ethers.getSigners();
        driver = new RoundDriver(core, arbs, user, { jury: SMALL });
    });

    it("quotes K + B x P fees plus the draw and promote rewards", async function () {
        const q = await core.agg.maxTotalFee(H.MAX_FEE, 0, false, SMALL.K, SMALL.P);
        expect(q).to.equal(H.MAX_FEE * (6n + 3n * 3n) + H.MAX_FEE * (2n + 1n));
    });

    it("reverts a jury the aggregator does not accept", async function () {
        const bad = H.jury(6, 5, 4, 1, 300);          // P = 1 with N = 4
        const value = await core.agg.maxTotalFee(H.MAX_FEE, 0, false, 6, 1);
        await expect(core.agg.connect(user).requestAIEvaluationWithApproval(
            ["QmTest"], "", 500, H.MAX_FEE, 0, H.BASE_COST, 5, 1, false, bad, { value }
        )).to.be.revertedWithCustomError(core.aggLib, "BadJury");
    });

    it("runs a round and credits the refund and the draw reward to the requester", async function () {
        const round = await driver.fullRound({ settle: false });     // drawn by the requester
        const [, , valid] = await core.agg.getEvaluation(round.aggId);
        expect(valid).to.be.true;

        const info = await core.agg.getRoundInfo(round.aggId);
        const drawReward = 2n * H.MAX_FEE;
        const promoteReward = H.MAX_FEE;                             // went to the promote caller
        expect(info.rewards).to.equal(drawReward + promoteReward);
        expect(info.baseFees).to.equal(6n * H.FEE);
        expect(info.bonuses).to.equal(3n * 3n * H.FEE);
        const refund = info.received - info.baseFees - info.bonuses - info.rewards;
        expect(await core.agg.ethOwed(user.address)).to.equal(refund + drawReward);
    });

    it("closes a dead round with settle and refunds the requester", async function () {
        const round = await driver.request();                        // drawn; nobody commits
        await expect(core.agg.settle(round.aggId)).to.be.revertedWithCustomError(core.agg, "NotDue");
        await time.increase(SMALL.timeout + 1);
        await core.agg.settle(round.aggId);
        expect(await core.agg.isFailed(round.aggId)).to.be.true;

        const info = await core.agg.getRoundInfo(round.aggId);
        const credit = info.received - info.baseFees - info.rewards + 2n * H.MAX_FEE;   // refund + draw reward
        expect(await core.agg.ethOwed(user.address)).to.equal(credit);
        await expect(core.agg.connect(user).withdrawEth())
            .to.changeEtherBalances([user, core.agg], [credit, -credit]);
    });
});
```

The repository's own tests ([`test/aggregator.flow.test.js`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/test/aggregator.flow.test.js), [`test/beacons.test.js`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/test/beacons.test.js)) cover the failure paths, beacons and solvency.

## Best Practices

### 1. Error Handling

The aggregator reports its conditions as custom errors (for example `InsufficientPayment()`, and `BadJury()` from its library), which `catch Error(string memory)` does not catch. The keeper's `NoEligibleArbiters()` never reaches the requester: the request only escrows, and a draw that finds no eligible arbiter fails the round and refunds. A dead round becomes failed only when someone calls `settle()`, so the contract below makes that call itself once the deadline has passed.

```solidity
contract RobustIntegration {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    enum EvaluationStatus { None, Pending, Completed, Failed }

    struct SafeEvaluation {
        EvaluationStatus status;
        address requester;
        uint256 submittedAt;
    }

    mapping(bytes32 => SafeEvaluation) public evaluations;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function safeSubmitEvaluation(string[] calldata evidence, string calldata description)
        external payable returns (bytes32)
    {
        try aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence, description, 500, MAX_FEE, 0, BASE_COST, 5, 128, false,
            IReputationAggregator.Jury({K: 6, M: 5, N: 4, P: 3, timeout: 300})
        ) returns (bytes32 requestId) {
            evaluations[requestId] = SafeEvaluation({
                status: EvaluationStatus.Pending,
                requester: msg.sender,
                submittedAt: block.timestamp
            });
            return requestId;
        } catch (bytes memory data) {
            // Custom errors of the aggregator, for example InsufficientPayment() or
            // BadJury(): pass them on unchanged so the caller can decode them
            assembly {
                revert(add(data, 32), mload(data))
            }
        }
    }

    function processEvaluation(bytes32 requestId) external {
        SafeEvaluation storage evaluation = evaluations[requestId];
        require(evaluation.status == EvaluationStatus.Pending, "Not pending");

        (uint256[] memory likelihoods, string memory justifications, bool valid) =
            aggregator.getEvaluation(requestId);
        if (valid) {
            evaluation.status = EvaluationStatus.Completed;
            _handleSuccess(requestId, likelihoods, justifications);
            return;
        }

        (uint8 phase, , , , , , , , , , , ) = aggregator.getRoundInfo(requestId);
        if (phase >= 3 && phase <= 5) {
            // Still open. Past the deadline, close it here: this credits the
            // refund to this contract. Before the deadline settle reverts NotDue()
            aggregator.settle(requestId);
        } else if (phase != 8 && phase != 9) {
            revert("Not ready");               // phase 1 or 2: still to be drawn
        }
        evaluation.status = EvaluationStatus.Failed;
        _handleFailure(requestId);
    }

    function _handleSuccess(bytes32 requestId, uint256[] memory likelihoods, string memory justifications) internal {
        // Implementation specific to your use case
    }

    function _handleFailure(bytes32 requestId) internal {
        // Handle a round that failed or was cancelled
    }
}
```

### 2. Fee Management

A contract that pays for its requests from its own ETH. It sends only what the round needs beyond the credit it already holds in the aggregator, and it can move its ETH out again.

```solidity
contract FeeManagedIntegration {
    IReputationAggregator public immutable aggregator;
    address public immutable owner;

    uint256 public constant MAX_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;
    uint8 public constant K = 6;
    uint8 public constant P = 3;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
        owner = msg.sender;
    }

    // Fund the contract by sending ETH to it. Withdrawals from the
    // aggregator arrive here as well.
    receive() external payable {}

    // ETH this contract would have to add for one more request
    function shortfall() public view returns (uint256) {
        uint256 required = aggregator.maxTotalFee(MAX_FEE, 0, false, K, P);
        uint256 credit = aggregator.ethOwed(address(this));
        return required > credit ? required - credit : 0;
    }

    function submitWithFeeManagement(string[] calldata evidence, string calldata description)
        external onlyOwner returns (bytes32)
    {
        // The aggregator uses this contract's credit first (refunds and draw
        // rewards of earlier rounds), so only the rest has to be sent
        uint256 value = shortfall();
        require(address(this).balance >= value, "Insufficient ETH balance");

        return aggregator.requestAIEvaluationWithApproval{value: value}(
            evidence, description, 500, MAX_FEE, 0, BASE_COST, 5, 128, false,
            IReputationAggregator.Jury({K: K, M: 5, N: 4, P: P, timeout: 300})
        );
    }

    function draw(bytes32 aggId) external {
        aggregator.drawJury(aggId);
    }

    // Move the credit out of the aggregator and everything to the owner
    function withdrawAll() external onlyOwner {
        if (aggregator.ethOwed(address(this)) > 0) {
            aggregator.withdrawEth();
        }
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "Transfer failed");
    }
}
```

## Legacy Contracts

[ReputationSingleton](../contracts/reputation-singleton.md) and [SimpleContract](../contracts/simple-contract.md) are legacy contracts that are paid in LINK: the requester approves LINK for the contract before the request, and no ETH is sent with it. They were written for the v1 keeper and are not part of v2. Their own pages carry their examples.

## Next Steps

- **[Frontend Integration](frontend.md)**: Detailed frontend examples
- **[Smart Contract Integration](integration.md)**: A v2 client contract step by step
- **[ReputationAggregator](../contracts/reputation-aggregator.md)**: The contract, its settings and its fee structure
- **[Deployment Guide](../deployment/index.md)**: How to deploy and configure contracts
- **[API Reference](../api/index.md)**: Complete contract interfaces
