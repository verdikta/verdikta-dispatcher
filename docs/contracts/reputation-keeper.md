# ReputationKeeper Contract

The ReputationKeeper is the central registry and reputation management system for Verdikta oracles. It handles oracle registration, tracks performance scores, manages staking requirements, and implements sophisticated oracle selection algorithms.

## Overview

The ReputationKeeper serves as the backbone of the Verdikta network by:

- **Oracle Registry**: Maintaining a list of all registered oracles and their capabilities
- **Reputation Tracking**: Recording quality and timeliness scores for each oracle
- **Staking Management**: Enforcing stake requirements and handling slashing
- **Selection Algorithm**: Choosing optimal oracles based on reputation and fees
- **Access Control**: Ensuring only approved contracts can use oracles

## Key Features

### Composite Oracle Identity
Oracles are identified by a combination of `(address, jobId)`, allowing single operators to run multiple specialized services.

### Reputation Scoring
- **Quality Score**: Based on clustering accuracy and consensus participation
- **Timeliness Score**: Based on response speed and reliability
- **Historical Tracking**: Maintains rolling history of recent performance

### Economic Security
- **Stake Requirement**: 100 VDKA tokens minimum to register
- **Slashing Mechanism**: Automatic penalties for poor performance
- **Lock Periods**: Temporary restrictions after penalties

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
| `_jobId` | `bytes32` | Unique job identifier for this oracle service |
| `fee` | `uint256` | LINK fee required per request |
| `_classes` | `uint64[]` | Oracle classes/specializations (max 5) |

#### Requirements
- Caller must be oracle owner or contract owner
- Oracle must stake 100 VDKA tokens
- Oracle contract must implement `IArbiterOperator` interface
- At least one class must be specified

### Oracle Management

```solidity
// Deregister oracle and return stake
function deregisterOracle(address _oracle, bytes32 _jobId) external

// Pause/unpause oracle (owner only)
function setOracleActive(address _oracle, bytes32 _jobId, bool _active) external onlyOwner

// Update reputation scores (approved contracts only)
function updateScores(
    address _oracle,
    bytes32 _jobId,
    int8 qualityChange,
    int8 timelinessChange
) external
```

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
) external view returns (OracleIdentity[] memory)
```

#### Selection Algorithm
1. **Filter**: Active oracles with fee ≤ maxFee supporting requested class
2. **Shortlist**: Random subset if > 20 eligible oracles
3. **Score**: Calculate weighted reputation scores with fee adjustments
4. **Select**: Weighted random selection based on scores

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
```

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
    uint256 stakeAmount;      // VDKA tokens staked
    bool isActive;            // Available for selection
    bytes32 jobId;            // Job identifier
    uint256 fee;              // LINK fee per request
    uint256 callCount;        // Total requests served
    ScoreRecord[] recentScores; // Performance history
    uint256 lockedUntil;      // Lock expiration timestamp
    bool blocked;             // Blocked from selection
    uint64[] classes;         // Supported classes
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

## Usage Examples

### Oracle Registration

```solidity
pragma solidity ^0.8.21;

import "./ReputationKeeper.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract OracleManager {
    ReputationKeeper public reputationKeeper;
    IERC20 public verdiktaToken;
    
    constructor(address _keeper, address _token) {
        reputationKeeper = ReputationKeeper(_keeper);
        verdiktaToken = IERC20(_token);
    }
    
    function registerMyOracle(
        address oracleContract,
        bytes32 jobId,
        uint256 fee,
        uint64[] memory classes
    ) external {
        // Approve stake transfer
        uint256 stakeRequired = 100 * 10**18; // 100 VDKA
        verdiktaToken.approve(address(reputationKeeper), stakeRequired);
        
        // Register oracle
        reputationKeeper.registerOracle(
            oracleContract,
            jobId,
            fee,
            classes
        );
    }
    
    function updateOracleFee(
        address oracle,
        bytes32 jobId,
        uint256 newFee
    ) external {
        // Note: Fee updates require deregistering and re-registering
        reputationKeeper.deregisterOracle(oracle, jobId);
        
        uint64[] memory classes = getOracleClasses(oracle, jobId);
        uint256 stakeRequired = 100 * 10**18;
        verdiktaToken.approve(address(reputationKeeper), stakeRequired);
        
        reputationKeeper.registerOracle(oracle, jobId, newFee, classes);
    }
}
```

### Contract Integration

```solidity
pragma solidity ^0.8.21;

contract MyDispatcher {
    ReputationKeeper public reputationKeeper;
    
    modifier onlyApproved() {
        require(
            reputationKeeper.isContractApproved(address(this)),
            "Contract not approved"
        );
        _;
    }
    
    function selectOracles(uint256 count, uint64 oracleClass) 
        external 
        onlyApproved 
        returns (ReputationKeeper.OracleIdentity[] memory) 
    {
        return reputationKeeper.selectOracles(
            count,
            500,        // 50% weight on timeliness
            0.1 ether,  // max 0.1 LINK fee
            0.01 ether, // base cost
            5,          // max 5x scaling
            oracleClass
        );
    }
    
    function recordOraclePerformance(
        address oracle,
        bytes32 jobId,
        bool goodQuality,
        bool onTime
    ) external onlyApproved {
        int8 qualityChange = goodQuality ? int8(1) : int8(-2);
        int8 timelinessChange = onTime ? int8(1) : int8(-1);
        
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
        
        return {
            isActive,
            qualityScore: Number(qualityScore),
            timelinessScore: Number(timelinessScore),
            callCount: Number(callCount),
            fee: ethers.formatEther(fee),
            stakeAmount: ethers.formatEther(stakeAmount),
            lockedUntil: new Date(Number(lockedUntil) * 1000),
            blocked,
            isLocked: Date.now() < Number(lockedUntil) * 1000
        };
    }
    
    async getAvailableOracles(oracleClass, maxFee = "0.1") {
        try {
            const oracles = await this.contract.selectOracles(
                100, // Large number to get all available
                500, // Balanced alpha
                ethers.parseEther(maxFee),
                ethers.parseEther("0.01"),
                5,
                oracleClass
            );
            
            // Get details for each oracle
            const oracleDetails = await Promise.all(
                oracles.map(async ({ oracle, jobId, classes }) => {
                    const details = await this.getOracleDetails(oracle, jobId);
                    return {
                        address: oracle,
                        jobId,
                        classes,
                        ...details
                    };
                })
            );
            
            return oracleDetails.sort((a, b) => 
                (b.qualityScore + b.timelinessScore) - (a.qualityScore + a.timelinessScore)
            );
            
        } catch (error) {
            console.error("Error fetching oracles:", error);
            return [];
        }
    }
    
    async monitorOraclePerformance(oracleAddress, jobId) {
        const filter = this.contract.filters.ScoreUpdated(oracleAddress);
        
        this.contract.on(filter, (oracle, qualityScore, timelinessScore, event) => {
            console.log(`Oracle ${oracle} performance updated:`, {
                qualityScore: Number(qualityScore),
                timelinessScore: Number(timelinessScore),
                blockNumber: event.blockNumber
            });
        });
        
        // Return cleanup function
        return () => this.contract.off(filter);
    }
}
```

## Reputation System

### Scoring Mechanism

**Quality Score**:
- `+1` for participating in consensus cluster
- `-2` for providing outlier responses
- `-5` for severe quality issues

**Timeliness Score**:
- `+1` for timely responses
- `-1` for delayed responses  
- `-3` for timeouts

### Penalty System

**Mild Penalties** (Score < -20):
- Lock period: 2 hours
- No stake slashing
- Oracle remains selectable after lock expires

**Severe Penalties** (Score < -40):
- Lock period: 2 hours
- Stake slashing: 10 VDKA tokens
- Oracle blocked from selection during lock

**Pattern Penalties**:
- Consistent score decline over 10 requests
- Automatic slashing and blocking
- Score history reset

### Selection Algorithm

```
weighted_score = (1000 - alpha) * quality_score + alpha * timeliness_score
final_score = weighted_score * fee_weighting_factor

fee_weighting_factor = min(
    max_scaling_factor,
    (max_fee - base_cost) / (oracle_fee - base_cost)
)
```

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `STAKE_REQUIREMENT` | 100 VDKA | Minimum stake to register |
| `slashAmountConfig` | 10 VDKA | Amount slashed for penalties |
| `lockDurationConfig` | 2 hours | Lock period after penalties |
| `severeThreshold` | -40 | Score threshold for severe penalties |
| `mildThreshold` | -20 | Score threshold for mild penalties |
| `maxScoreHistory` | 10 | Rolling window for pattern detection |
| `shortlistSize` | 20 | Maximum oracles for final selection |

## Security Considerations

### Access Control
- Only oracle owners can register/deregister their oracles
- Only approved contracts can select oracles and update scores
- Only contract owner can approve/remove contracts

### Economic Security
- Stake requirements align oracle incentives
- Slashing provides concrete penalties for poor performance
- Lock periods prevent immediate re-registration after penalties

### Selection Fairness
- Weighted random selection prevents manipulation
- Fee-based weighting encourages competitive pricing
- Entropy mixing prevents predictable selections

## Best Practices

### For Oracle Operators
1. **Maintain High Scores**: Consistently provide quality, timely responses
2. **Monitor Performance**: Track reputation scores and address issues quickly
3. **Competitive Pricing**: Balance fees with service quality
4. **Multiple Classes**: Register for multiple oracle classes to increase utilization

### For Contract Developers
1. **Fair Scoring**: Implement objective performance measurement
2. **Prompt Updates**: Update scores immediately after evaluations
3. **Handle Edge Cases**: Gracefully handle oracle failures and timeouts
4. **Monitor Selection**: Track which oracles are being selected

### For System Administrators
1. **Regular Monitoring**: Watch for system-wide performance issues
2. **Parameter Tuning**: Adjust thresholds based on network conditions
3. **Contract Approval**: Carefully vet contracts before approval
4. **Emergency Procedures**: Have plans for handling severe system issues 