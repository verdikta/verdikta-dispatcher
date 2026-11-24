# ReputationKeeper Contract

The ReputationKeeper is the registry of Verdikta oracles. It records each oracle's stake, fee, classes and two reputation scores, and it chooses the oracles for a request by weighted random selection. An oracle on this page is what other pages call an arbiter: one job on an [ArbiterOperator](arbiter-operator.md) contract.

!!! note "Checked against the code"
    This page was checked on 2026-11-23 against `reputationBasedAggregator/contracts/ReputationKeeper.sol` and against the keepers the ReputationAggregator uses on Base (`0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0`) and Base Sepolia (`0xE09821277D9af702F7910a57e85EaC6D83e4d794`). Every value given as "on chain" was read that day with the function named beside it. The keeper's owner can change all of them except the stake, so read them again before you rely on one. The examples were compiled and run on a local fork of Base mainnet.

## Overview

The ReputationKeeper:

- **Oracle Registry**: keeps the list of registered oracles with their fees and classes
- **Reputation Tracking**: keeps a quality score and a timeliness score for each oracle
- **Staking**: takes a stake of 100 wVDKA for each registration and returns what is left of it on deregistration
- **Selection**: chooses oracles for a request, weighted by reputation and fee
- **Access Control**: lets only approved contracts select oracles and record them as used

wVDKA is the Wrapped Verdikta token the keeper's `verdiktaToken()` returns: `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` on Base and `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` on Base Sepolia.

## Key Features

### Composite Oracle Identity
Oracles are identified by a combination of `(address, jobId)`, so one operator contract can register several jobs. Each pair has its own stake, fee, classes and scores.

### Reputation Scoring
- **Quality Score**: follows whether the oracle's answers were in the consensus cluster
- **Timeliness Score**: follows whether the oracle answered in time
- **Historical Tracking**: the last `maxScoreHistory` pairs of scores are kept (25 on chain) and used to detect a steady decline

The keeper only adds the changes it is given. The calling contract decides the amounts: see [Reputation System](#reputation-system).

### Economic Security
- **Stake Requirement**: 100 wVDKA for each registration (`STAKE_REQUIREMENT`, a constant)
- **Penalties**: an oracle whose score falls below a threshold is locked and, below the lower threshold, also left out of selection
- **Slashing**: a penalty deducts `slashAmountConfig` from the oracle's stake. That amount is 0 in the source and on both networks, so no stake is taken today
- **Lock Periods**: a locked oracle cannot deregister until the lock ends (`lockDurationConfig`, 24 hours on chain)

## Contract Interface

### Oracle Registration

```solidity
function registerOracle(
    address _oracle,
    bytes32 _jobId,
    uint256 fee,
    uint64[] memory _classes
) external
```

#### Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `_oracle` | `address` | ArbiterOperator contract address |
| `_jobId` | `bytes32` | Job identifier for this oracle service. The repository's `scripts/register-oracle.js` passes the 32-character Chainlink job id as its UTF-8 bytes |
| `fee` | `uint256` | Fee the oracle charges per request (must be greater than 0). The keeper stores it as a plain number and takes no payment itself: the contract that selects the oracle decides what the number means. The ReputationAggregator reads it as wei of ETH; the legacy ReputationSingleton reads it as LINK |
| `_classes` | `uint64[]` | Oracle classes/specializations (1 to 5) |

#### Requirements
- `_oracle` is a contract that reports the `IArbiterOperator` interface through `supportsInterface`
- The operator's own list of keepers is empty or contains this keeper (`isReputationKeeperListEmpty()`, `isReputationKeeper(address)`)
- The pair `(_oracle, _jobId)` is not registered yet
- `fee` is greater than 0, and there are 1 to 5 classes
- The caller is the keeper's owner or the `owner()` of the oracle contract
- The caller has approved the keeper for 100 wVDKA. The stake is taken from the caller with `transferFrom`

A new registration is active and starts with both scores at 0.

### Oracle Management

```solidity
// Remove the oracle and send what is left of its stake to the owner() of the oracle contract
function deregisterOracle(address _oracle, bytes32 _jobId) external

// Pause/unpause oracle (owner only)
function setOracleActive(address _oracle, bytes32 _jobId, bool _active) external onlyOwner

// Leave an oracle out of selection for _duration seconds; 0 means lockDurationConfig (owner only)
function manualBlockOracle(address _oracle, bytes32 _jobId, uint256 _duration) external onlyOwner
```

`deregisterOracle` can be called by the keeper's owner or by the `owner()` of the oracle contract. It reverts with "Oracle is locked and cannot be unregistered" until `lockedUntil` has passed. It deletes the oracle's record, including its scores, call count and score history, and the stake goes to the `owner()` of the oracle contract whoever made the call.

There is no function that changes the fee or the classes of a registered oracle. To change them, deregister and register again; the new registration starts with both scores at 0.

### Scores and Entropy

```solidity
// Mark oracles as used by the calling contract (approved contracts only)
function recordUsedOracles(OracleIdentity[] calldata _oracleIdentities) external

// Add to an oracle's scores (only a contract that recorded this oracle as used)
function updateScores(
    address _oracle,
    bytes32 _jobId,
    int8 qualityChange,
    int8 timelinessChange
) external

// Hand the keeper 16 bytes of randomness for later selections (approved contracts only)
function pushEntropy(bytes16 e) external
```

`updateScores` reverts with "Oracle not used by this contract" unless the caller has passed this oracle to `recordUsedOracles` before. It adds the two changes to the scores, adds 1 to `callCount`, appends the new pair of scores to the history and then applies the [penalty rules](#penalty-system).

`updateScores` checks only that record. `removeContract` stops a contract from selecting oracles and from recording new ones; it does not stop the contract from updating the scores of oracles it recorded while it was approved.

### Contract Approval

```solidity
// Approve contract to use oracles
function approveContract(address contractAddress) external onlyOwner

// Remove contract approval
function removeContract(address contractAddress) external onlyOwner

// Check if contract is approved
function isContractApproved(address contractAddress) external view returns (bool)
```

### Oracle Selection

```solidity
function selectOracles(
    uint256 count,
    uint256 alpha,
    uint256 maxFee,
    uint256 estimatedBaseCost,
    uint256 maxFeeBasedScalingFactor,
    uint64 requestedClass
) external returns (OracleIdentity[] memory)
```

`selectOracles` is not a `view` function: it adds 1 to `selectionCounter`. It answers only an approved contract and otherwise reverts with "Not approved to select oracles", so an account that is not approved cannot call it, not even as a read-only call. It also requires `estimatedBaseCost < maxFee` ("Base cost must be less than max fee") and `maxFeeBasedScalingFactor >= 1`.

| Parameter | Description |
|-----------|-------------|
| `count` | Number of identities to return |
| `alpha` | Weight of the timeliness score, from 0 to 1000. The quality score gets `1000 - alpha`. A value above 1000 makes the call revert |
| `maxFee` | Highest oracle fee accepted, in the same unit as the registered fees |
| `estimatedBaseCost` | Used only to weight cheaper oracles: see [Selection Weights](#selection-weights) |
| `maxFeeBasedScalingFactor` | Upper limit of the fee weighting |
| `requestedClass` | Class the oracle must have registered |

#### Selection Algorithm
1. **Filter**: oracles that are active, charge `fee <= maxFee`, list the requested class and are not blocked with a running lock. If none is left the call reverts with "No active oracles available with fee <= maxFee and requested class"
2. **Shortlist**: if more than `shortlistSize` oracles are left (20 on chain), a random `shortlistSize` of them
3. **Score**: each shortlisted oracle gets a weight from its scores and its fee (`getSelectionScore`)
4. **Select**: weighted random draws, without repeats while the shortlist has oracles left

The result always has `count` entries. If `count` is larger than the shortlist, the remaining draws are made with repeats, so the same oracle can appear more than once.

### Information Queries

```solidity
// Get oracle details
function getOracleInfo(address _oracle, bytes32 _jobId)
    external view returns (
        bool isActive,
        int256 qualityScore,
        int256 timelinessScore,
        uint256 callCount,
        bytes32 jobId,
        uint256 fee,
        uint256 stakeAmount,
        uint256 lockedUntil,
        bool blocked
    )

// Calculate selection score
function getSelectionScore(
    address _oracle,
    bytes32 _jobId,
    SelectionParams memory params
) public view returns (uint256)

// Recent pairs of scores, oldest first
function getRecentScores(address _oracle, bytes32 _jobId)
    external view returns (ScoreRecord[] memory)

// Walk the registry
function getRegisteredOraclesCount() external view returns (uint256)
function registeredOracles(uint256 index) external view returns (address oracle, bytes32 jobId)
function getOracleClasses(uint256 index) public view returns (uint64[] memory)
function getOracleClassesByKey(address _oracle, bytes32 _jobId) public view returns (uint64[] memory)
```

`getOracleInfo` returns the stored `blocked` flag as it is. The flag is cleared only by the next score update after the lock has ended, so treat an oracle as left out of selection only while `blocked` is true **and** `lockedUntil` is in the future. That is the test `selectOracles` and `getSelectionScore` use.

## Data Structures

### OracleIdentity
```solidity
struct OracleIdentity {
    address oracle;     // ArbiterOperator contract address
    bytes32 jobId;      // Job identifier
    uint64[] classes;   // Supported oracle classes
}
```

### OracleInfo
```solidity
struct OracleInfo {
    int256 qualityScore;      // Clustering/consensus score
    int256 timelinessScore;   // Response speed score
    uint256 stakeAmount;      // wVDKA tokens staked
    bool isActive;            // Available for selection
    bytes32 jobId;            // Job identifier
    uint256 fee;              // Fee per request, in the unit of the calling contract (wei of ETH for the ReputationAggregator)
    uint256 callCount;        // Number of score updates received
    ScoreRecord[] recentScores; // Performance history
    uint256 lockedUntil;      // Lock expiration timestamp
    bool blocked;             // Left out of selection while the lock runs
    uint64[] classes;         // Supported classes
}
```

### ScoreRecord
```solidity
struct ScoreRecord {
    int256 qualityScore;      // Quality score after an update
    int256 timelinessScore;   // Timeliness score after the same update
}
```

### SelectionParams
```solidity
struct SelectionParams {
    uint256 alpha;                      // Weight of the timeliness score (0-1000)
    uint256 maxFee;                     // Highest fee accepted per oracle
    uint256 estimatedBaseCost;          // Base cost used in the fee weighting
    uint256 maxFeeBasedScalingFactor;   // Upper limit of the fee weighting
}
```

## Events

```solidity
event OracleRegistered(address indexed oracle, bytes32 jobId, uint256 fee);
event OracleDeregistered(address indexed oracle, bytes32 jobId);
event ScoreUpdated(address indexed oracle, int256 newQualityScore, int256 newTimelinessScore);
event OracleSlashed(address indexed oracle, bytes32 jobId, uint256 slashAmount, uint256 lockedUntil, bool blocked);
event ContractApproved(address indexed contractAddress);
event ContractRemoved(address indexed contractAddress);
event OracleActiveStatusUpdated(address indexed oracle, bytes32 jobId, bool isActive);
event EntropyPushed(bytes16 entropy, uint256 blockNumber);
```

- `ScoreUpdated` is emitted by every `updateScores` call. It carries the address of the oracle contract but not the job id, so all jobs of one operator contract share it.
- `OracleSlashed` is emitted for every penalty, also when nothing is deducted. A mild penalty reports `slashAmount` 0 and `blocked` false; a severe or pattern penalty reports `slashAmountConfig` and `blocked` true.
- `EntropyPushed` is emitted only when the value is stored, which is at most once per block.
- The owner's settings functions, `manualBlockOracle`, `resetAllReputations` and `recordUsedOracles` emit no event.

## Usage Examples

### Oracle Registration

The keeper accepts a registration only from its own owner or from the `owner()` of the oracle contract, and it takes the stake from the caller. This is how the owner of an ArbiterOperator contract registers a job from their wallet, the way the repository's `scripts/register-oracle.js` does.

```javascript
import { ethers } from 'ethers';

const KEEPER_REGISTRATION_ABI = [
    'function verdiktaToken() view returns (address)',
    'function STAKE_REQUIREMENT() view returns (uint256)',
    'function registerOracle(address oracle, bytes32 jobId, uint256 fee, uint64[] classes)',
    'function deregisterOracle(address oracle, bytes32 jobId)',
    'function getOracleClassesByKey(address oracle, bytes32 jobId) view returns (uint64[])'
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];

// The keeper takes the stake from the caller: approve it first
async function approveStake(signer, keeper) {
    const token = new ethers.Contract(await keeper.verdiktaToken(), ERC20_ABI, signer);
    const stake = await keeper.STAKE_REQUIREMENT();          // 100 wVDKA
    const me = await signer.getAddress();
    const keeperAddress = await keeper.getAddress();

    if ((await token.balanceOf(me)) < stake) {
        throw new Error('Not enough wVDKA for the stake');
    }
    if ((await token.allowance(me, keeperAddress)) < stake) {
        await (await token.approve(keeperAddress, stake)).wait();
    }
}

// signer: the owner() of the ArbiterOperator contract
// jobIdString: the 32-character Chainlink job id, without dashes
// feeWei: for the ReputationAggregator, the fee in wei of ETH
async function registerOracle(signer, keeperAddress, oracleAddress, jobIdString, feeWei, classes) {
    const keeper = new ethers.Contract(keeperAddress, KEEPER_REGISTRATION_ABI, signer);

    const jobIdBytes = ethers.toUtf8Bytes(jobIdString);
    if (jobIdBytes.length !== 32) {
        throw new Error('The job id must be 32 characters long');
    }
    const jobId = ethers.hexlify(jobIdBytes);

    await approveStake(signer, keeper);
    await (await keeper.registerOracle(oracleAddress, jobId, feeWei, classes)).wait();
    return jobId;
}

// The keeper has no function that changes a fee: deregister and register again.
// This reverts while the oracle is locked, and the new registration starts with
// both scores, the call count and the score history at zero.
async function changeOracleFee(signer, keeperAddress, oracleAddress, jobId, newFeeWei) {
    const keeper = new ethers.Contract(keeperAddress, KEEPER_REGISTRATION_ABI, signer);
    const classes = [...(await keeper.getOracleClassesByKey(oracleAddress, jobId))];

    // The stake goes back to the owner() of the oracle contract
    await (await keeper.deregisterOracle(oracleAddress, jobId)).wait();

    await approveStake(signer, keeper);
    await (await keeper.registerOracle(oracleAddress, jobId, newFeeWei, classes)).wait();
}
```

A contract can register oracles too, if it is the `owner()` of the oracle contract and holds the wVDKA. Keep in mind that the ReputationAggregator credits an oracle's earnings to the `owner()` of the oracle contract, so such a contract must also be able to receive ETH and to call the aggregator's `withdrawEth()`.

### Contract Integration

A contract that uses the keeper the way the ReputationAggregator does: select oracles, record them as used, and update their scores later. The example declares the three keeper functions it calls, so it compiles on its own. If you import `reputationBasedAggregator/contracts/ReputationKeeper.sol` instead, compile with the optimizer and `viaIR` turned on, as the repository's `hardhat.config.js` does; without them the keeper fails with "Stack too deep".

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IReputationKeeper {
    struct OracleIdentity {
        address oracle;
        bytes32 jobId;
        uint64[] classes;
    }

    function selectOracles(
        uint256 count,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass
    ) external returns (OracleIdentity[] memory);

    function recordUsedOracles(OracleIdentity[] calldata oracleIdentities) external;

    function updateScores(
        address oracle,
        bytes32 jobId,
        int8 qualityChange,
        int8 timelinessChange
    ) external;
}

// The keeper's owner must first call approveContract(address(this)).
contract MyDispatcher {
    IReputationKeeper public immutable reputationKeeper;
    address public immutable admin;

    // A transaction's return value cannot be read off-chain, so log the selection
    event OracleChosen(address indexed oracle, bytes32 jobId);

    constructor(address _keeper) {
        reputationKeeper = IReputationKeeper(_keeper);
        admin = msg.sender;
    }

    // Without a check like this anyone could change oracle scores through this contract
    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    function selectOracles(uint256 count, uint64 oracleClass)
        external
        onlyAdmin
        returns (IReputationKeeper.OracleIdentity[] memory selected)
    {
        selected = reputationKeeper.selectOracles(
            count,
            500,        // equal weight on quality and timeliness
            4e14,       // highest fee accepted, in the same unit as the oracles' registered fees
                        // (wei of ETH for the ReputationAggregator: 4e14 = 0.0004 ETH)
            8e9,        // base cost, must be lower than the highest fee
            5,          // fee weighting of at most 5x
            oracleClass
        );

        // Without this, updateScores reverts with "Oracle not used by this contract"
        reputationKeeper.recordUsedOracles(selected);

        for (uint256 i = 0; i < selected.length; i++) {
            emit OracleChosen(selected[i].oracle, selected[i].jobId);
        }
    }

    function recordOraclePerformance(
        address oracle,
        bytes32 jobId,
        bool goodQuality,
        bool onTime
    ) external onlyAdmin {
        // Any int8 is accepted. These are the amounts the ReputationAggregator
        // used on 2026-11-23 (see "Scoring Mechanism" below).
        int8 qualityChange = goodQuality ? int8(60) : int8(-60);
        int8 timelinessChange = onTime ? int8(60) : int8(-20);

        reputationKeeper.updateScores(
            oracle,
            jobId,
            qualityChange,
            timelinessChange
        );
    }
}
```

### Frontend Queries

```javascript
import { ethers } from 'ethers';

const REPUTATION_KEEPER_ABI = [
    'function getOracleInfo(address oracle, bytes32 jobId) view returns (bool isActive, int256 qualityScore, int256 timelinessScore, uint256 callCount, bytes32 jobId, uint256 fee, uint256 stakeAmount, uint256 lockedUntil, bool blocked)',
    'function getRegisteredOraclesCount() view returns (uint256)',
    'function registeredOracles(uint256 index) view returns (address oracle, bytes32 jobId)',
    'function getOracleClassesByKey(address oracle, bytes32 jobId) view returns (uint64[])',
    'event ScoreUpdated(address indexed oracle, int256 newQualityScore, int256 newTimelinessScore)'
];

class ReputationManager {
    constructor(contractAddress, provider) {
        this.contract = new ethers.Contract(
            contractAddress,
            REPUTATION_KEEPER_ABI,
            provider
        );
    }

    async getOracleDetails(oracleAddress, jobId) {
        const [
            isActive,
            qualityScore,
            timelinessScore,
            callCount,
            jobIdReturned,
            fee,
            stakeAmount,
            lockedUntil,
            blocked
        ] = await this.contract.getOracleInfo(oracleAddress, jobId);

        const isLocked = Date.now() < Number(lockedUntil) * 1000;

        return {
            isActive,
            qualityScore: Number(qualityScore),
            timelinessScore: Number(timelinessScore),
            callCount: Number(callCount),
            feeWei: fee,
            fee: ethers.formatEther(fee),               // ETH, for the ReputationAggregator
            stakeAmount: ethers.formatEther(stakeAmount),
            lockedUntil: new Date(Number(lockedUntil) * 1000),
            blocked,
            isLocked,                                   // cannot deregister
            isExcluded: blocked && isLocked             // left out of selection
        };
    }

    // selectOracles changes state and answers only approved contracts, so a frontend
    // cannot call it. List the registry and filter it the way selectOracles does.
    async getAvailableOracles(oracleClass, maxFee = "0.0004") {
        const maxFeeWei = ethers.parseEther(maxFee);
        const count = Number(await this.contract.getRegisteredOraclesCount());

        const oracleDetails = await Promise.all(
            Array.from({ length: count }, async (_, index) => {
                const [oracle, jobId] = await this.contract.registeredOracles(index);
                const classes = (await this.contract.getOracleClassesByKey(oracle, jobId)).map(Number);
                const details = await this.getOracleDetails(oracle, jobId);
                return {
                    address: oracle,
                    jobId,
                    classes,
                    ...details
                };
            })
        );

        return oracleDetails
            .filter((o) =>
                o.isActive &&
                !o.isExcluded &&
                o.feeWei <= maxFeeWei &&
                o.classes.includes(Number(oracleClass))
            )
            .sort((a, b) =>
                (b.qualityScore + b.timelinessScore) - (a.qualityScore + a.timelinessScore)
            );
    }

    // ScoreUpdated carries the oracle contract's address but not the job id:
    // all jobs registered for one operator contract arrive here.
    async monitorOraclePerformance(oracleAddress) {
        const filter = this.contract.filters.ScoreUpdated(oracleAddress);

        // With a filter object, ethers v6 calls the listener with ONE argument,
        // the event. The values are in event.args.
        const listener = (event) => {
            const [oracle, qualityScore, timelinessScore] = event.args;
            console.log(`Oracle ${oracle} performance updated:`, {
                qualityScore: Number(qualityScore),
                timelinessScore: Number(timelinessScore),
                blockNumber: event.log.blockNumber
            });
        };
        await this.contract.on(filter, listener);

        // Return cleanup function
        return () => this.contract.off(filter, listener);
    }
}
```

## Reputation System

This section is a summary. [Reputation System](../advanced/reputation.md) and [Oracle Selection](../advanced/oracle-selection.md) describe the same rules step by step.

### Scoring Mechanism

The keeper has no scoring amounts of its own. `updateScores` adds whatever the calling contract passes, from −128 to +127 for each score in one call. Scores start at 0, have no upper or lower limit and do not decay.

The ReputationAggregator passes these amounts. They were read from the aggregator on both networks on 2026-11-23, and the aggregator's owner can change them with `setScoreDeltas`.

| What happened to the polled oracle | Quality | Timeliness | Read with |
|------------------------------------|---------|------------|-----------|
| Its reveal was used and is in the consensus cluster | +60 | +60 | `clusteredQualityScore()`, `clusteredTimelinessScore()` |
| Its reveal was used and is outside the cluster | −60 | 0 | `selectedQualityScore()`, `selectedTimelinessScore()` |
| It has no stored reveal when the round completes: it did not commit, committed too late to be asked for a reveal, was not among the first reveals, or its reveal was rejected | 0 | −20 | `committedQualityScore()`, `committedTimelinessScore()` |

With the live settings (6 oracles polled, 3 reveals used, 2 in the cluster) a completed round gives two oracles +60 and +60, one oracle −60 and 0, and three oracles 0 and −20.

When a round is closed with `finalizeEvaluationTimeout`, only the third row is applied: to the oracles with no commit if the commit phase timed out, and to the oracles with no stored reveal if the reveal phase timed out.

The aggregator has a fourth pair, `revealedQualityScore()` and `revealedTimelinessScore()` (0 and −20), for a reveal that is stored but not used. The current contract completes a round in the transaction that stores the last reveal it needs and rejects later ones, so no reveal is stored without being used.

An oracle that is not active when the round completes gets no score change.

### Penalty System

Penalties are applied inside `updateScores`, after the changes are added. The values are those in the source and on both networks; each has a getter of the same name.

The two threshold penalties are checked only when the oracle has no running lock (`block.timestamp >= lockedUntil`). At that moment a blocked oracle is unblocked first.

**Mild Penalty** (either score below `mildThreshold`, −300):

- Lock period: `lockDurationConfig`, 24 hours. The oracle cannot deregister during the lock
- No stake is deducted
- The oracle stays selectable

**Severe Penalty** (either score below `severeThreshold`, −900):

- Lock period: 24 hours
- `slashAmountConfig` is deducted from the oracle's stake. It is 0, so nothing is deducted today
- The oracle is blocked: it is left out of selection until the lock ends
- Each score that was below −900 is set to −300

**Pattern Penalty** (checked on every update, also during a lock):

- Applies when the history holds `maxScoreHistory` records (25) and every record is lower than the one before it in at least one of the two scores
- Same lock, deduction and block as the severe penalty; the scores are left as they are
- The score history is cleared

The keeper's owner can also block an oracle directly with `manualBlockOracle`, and can set all scores, call counts, histories, locks and blocks back to zero with `resetAllReputations`.

Deducted tokens stay in the keeper contract. The source has no function that moves them out.

### Selection Weights

`getSelectionScore` returns the weight of an oracle. It is 0 for an oracle that is not active or is blocked with a running lock.

```
weighted_score = ((1000 - alpha) * quality_score + alpha * timeliness_score) / 1000
weighted_score = limited to the range minScoreForSelection .. maxScoreForSelection   (60 .. 6000)

fee_weighting_factor = 1
if oracle_fee > base_cost and max_fee > base_cost:
    ratio = (max_fee - base_cost) / (oracle_fee - base_cost)
    if ratio > max_scaling_factor:  fee_weighting_factor = max_scaling_factor
    else if ratio > 1:              fee_weighting_factor = ratio

selection_score = weighted_score * fee_weighting_factor
```

- A new oracle, and any oracle whose weighted score is below 60, has a weighted score of 60. It can still be selected
- The highest weighted score is 6000, so reputation alone changes an oracle's weight by a factor of at most 100
- An oracle whose fee is at or below `base_cost` gets no fee weighting (factor 1)

The random draws use these inputs:

- **Shortlist** (only when more than `shortlistSize` oracles are eligible): `block.timestamp`, `block.prevrandao` and the position in the list
- **Weighted draws**: the entropy the keeper holds, `block.prevrandao`, `block.timestamp`, `selectionCounter` and the number of the draw. The draws with repeats do not use `selectionCounter`
- **Entropy**: approved contracts hand it in with `pushEntropy`. The ReputationAggregator derives it from the salts in the oracles' reveals and the previous block hash. The keeper stores at most one value per block and keeps the one before it; a selection in the same block as a push uses the older value

## Configuration Parameters

The values are the same in the source, on Base and on Base Sepolia (read on 2026-11-23 with the getter of the same name). Only the keeper's owner can call the setters.

| Parameter | Value | Setter | Description |
|-----------|-------|--------|-------------|
| `STAKE_REQUIREMENT` | 100 wVDKA | none (constant) | Stake taken for each registration |
| `slashAmountConfig` | 0 | `setSlashAmount` | Amount deducted from the stake by a severe or pattern penalty |
| `lockDurationConfig` | 86400 seconds (24 hours) | `setLockDuration` | Lock period after a penalty |
| `severeThreshold` | −900 | `setSevereThreshold` | Score below which the severe penalty applies |
| `mildThreshold` | −300 | `setMildThreshold` | Score below which the mild penalty applies |
| `maxScoreHistory` | 25 | `setMaxScoreHistory` | Number of score records kept and checked for a steady decline |
| `shortlistSize` | 20 | `setShortlistSize` | Largest number of oracles that enter the weighted draws |
| `minScoreForSelection` | 60 | `setMinScoreForSelection` | Lowest weighted score used in selection |
| `maxScoreForSelection` | 6000 | `setMaxScoreForSelection` | Highest weighted score used in selection |
| `verdiktaToken` | wVDKA (addresses in [Overview](#overview)) | `setVerdiktaToken` | Token taken as stake and paid back on deregistration |

## Security Considerations

### Access Control
- An oracle can be registered or deregistered by the `owner()` of the oracle contract or by the keeper's owner
- Only approved contracts can select oracles, record them as used and push entropy
- Only a contract that recorded an oracle as used can update its scores. Removing a contract's approval does not take this away for oracles it has already recorded
- Only the keeper's owner can approve and remove contracts

### Owner Powers
The keeper's owner (`owner()`) can do the following. The contract puts no delay on any of it:

- Pause, unpause and block any oracle, and reset the reputation of all oracles
- Change every value in [Configuration Parameters](#configuration-parameters) except the stake
- Change the staking token with `setVerdiktaToken`. The keeper then takes new stakes and pays refunds in the new token; tokens already staked in the old one stay in the keeper
- Deregister any oracle that is not locked. The stake still goes to the `owner()` of the oracle contract

### Economic Security
- Each registration puts 100 wVDKA at stake
- With `slashAmountConfig` at 0, a penalty costs an oracle selection and time, not stake: it is locked and, for a severe or pattern penalty, left out of selection for 24 hours
- A locked oracle cannot deregister. Without a lock, an oracle can deregister and register again, which returns its scores to 0

### Selection Fairness
- Selection is a weighted random draw: reputation and a lower fee raise an oracle's chance, and no eligible oracle has a weight of zero
- The inputs of the random draws are listed under [Selection Weights](#selection-weights). The shortlist step uses block values only; the weighted draws also use the entropy pushed by approved contracts
- If fewer oracles are eligible than are requested, the same oracle is returned more than once

## Best Practices

### For Oracle Operators
1. **Maintain High Scores**: Consistently provide quality, timely responses
2. **Monitor Performance**: Track reputation scores and address issues quickly
3. **Competitive Pricing**: Balance fees with service quality
4. **Multiple Classes**: Register for up to 5 oracle classes to increase utilization

### For Contract Developers
1. **Fair Scoring**: Implement objective performance measurement
2. **Record Before Scoring**: Call `recordUsedOracles` right after `selectOracles`, or score updates revert
3. **Handle Edge Cases**: Gracefully handle oracle failures and timeouts
4. **Monitor Selection**: Track which oracles are being selected

### For System Administrators
1. **Regular Monitoring**: Watch for system-wide performance issues
2. **Parameter Tuning**: Adjust thresholds based on network conditions
3. **Contract Approval**: Carefully vet contracts before approval
4. **Emergency Procedures**: Have plans for handling severe system issues
