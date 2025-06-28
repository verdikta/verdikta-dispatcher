// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./IArbiterOperator.sol";   // same interface as above

/// @notice Minimal interface to query an oracle contract's owner.
interface IOracleOwner {
    function owner() external view returns (address);
}

/**
 * @title ReputationKeeper
 * @author Verdikta Team
 * @notice Manages oracle registration, reputation tracking, and selection for the Verdikta network
 * @dev Central registry for oracle reputation management using composite keys (oracle address + jobID).
 *      Implements staking, slashing, reputation scoring, and weighted oracle selection algorithms.
 */
contract ReputationKeeper is Ownable {
    
    /**
     * @notice Composite identifier for an oracle instance
     * @dev Uniquely identifies an oracle by address, job ID, and supported evaluation classes
     */
    struct OracleIdentity {
        address oracle;     /// @dev Address of the oracle contract
        bytes32 jobId;      /// @dev Chainlink job ID for this oracle
        uint64[] classes;   /// @dev List of evaluation classes (up to 5) supported by this oracle
    }

    bytes4 private constant ARBITERIFACE = type(IArbiterOperator).interfaceId;
    uint256 public selectionCounter;
    bytes16[2] public entropyBuf;    // updated by aggregators - 0=latest, 1=prev-block
    uint256 public entropyBlock;     // block.number when last updated

    /**
     * @notice Historical score record for tracking oracle performance trends
     * @dev Used to detect consistent performance degradation over time
     */
    struct ScoreRecord {
        int256 qualityScore;        /// @dev Quality score at this point in time
        int256 timelinessScore;     /// @dev Timeliness score at this point in time
    }

    /**
     * @notice Complete information about a registered oracle
     * @dev Stores all oracle metadata, scores, staking, and status information
     */
    struct OracleInfo {
        int256 qualityScore;        /// @dev Score based on clustering accuracy and response quality
        int256 timelinessScore;     /// @dev Score based on response timeliness and availability
        uint256 stakeAmount;        /// @dev Amount of VDKA tokens currently staked by this oracle
        bool isActive;              /// @dev Whether the oracle is available (true) or paused (false)
        bytes32 jobId;              /// @dev The job ID (redundant but stored for convenience)
        uint256 fee;                /// @dev LINK fee required for this job
        uint256 callCount;          /// @dev Number of times this oracle has been called
        ScoreRecord[] recentScores; /// @dev Rolling history of recent score snapshots
        uint256 lockedUntil;        /// @dev Timestamp until which the oracle is locked (cannot be unregistered)
        bool blocked;               /// @dev If true, oracle is blocked from selection due to poor performance
        uint64[] classes;           /// @dev Evaluation classes supported by this oracle
    }
    
    /**
     * @notice Contract approval and usage tracking data
     * @dev Tracks which contracts are approved to use oracles and which oracles they've used
     */
    struct ContractInfo {
        bool isApproved;            /// @dev Whether this contract is approved to use oracles
        mapping(bytes32 => bool) usedOracles; /// @dev Mapping from oracle key to usage status
    }
    
    /**
     * @notice Parameters for oracle selection algorithm
     * @dev Groups selection parameters to reduce stack usage in complex functions
     */
    struct SelectionParams {
        uint256 alpha;                      /// @dev Reputation weight factor (0-1000)
        uint256 maxFee;                     /// @dev Maximum fee willing to pay per oracle
        uint256 estimatedBaseCost;          /// @dev Estimated base cost for the evaluation
        uint256 maxFeeBasedScalingFactor;   /// @dev Maximum scaling factor for fee-based weighting
    }

    IERC20 public verdiktaToken;

    // Composite key (oracle, jobID) → OracleInfo.
    mapping(bytes32 => OracleInfo) public oracles;
    // Approved external contracts (for example, reputation aggregators).
    mapping(address => ContractInfo) public approvedContracts;
    // List of all registered oracle identities.
    OracleIdentity[] public registeredOracles;
    
    // The maximum number of historical score records to keep for each oracle.
    uint256 public maxScoreHistory = 27;

    uint256 public constant STAKE_REQUIREMENT = 100 * 10**18;  // 100 VDKA tokens
    uint256 public constant MAX_SCORE_FOR_SELECTION = 400;
    uint256 public constant MIN_SCORE_FOR_SELECTION = 1;
    
    // Configuration for slashing and locking.
    uint256 public slashAmountConfig = 0 * 10**18;     // 0 VDKA tokens (configurable)
    uint256 public lockDurationConfig = 2 hours;       // Lock period (configurable)
    int256 public severeThreshold = -60;               // Severe threshold (configurable)
    int256 public mildThreshold = -30;                 // Mild threshold (configurable)
    
    // The maximum number of oracles to weight in the second-stage selection.
    uint256 public shortlistSize = 25;
    
    event OracleRegistered(address indexed oracle, bytes32 jobId, uint256 fee);
    event OracleDeregistered(address indexed oracle, bytes32 jobId);
    event ScoreUpdated(address indexed oracle, int256 newQualityScore, int256 newTimelinessScore);
    event OracleSlashed(address indexed oracle, bytes32 jobId, uint256 slashAmount, uint256 lockedUntil, bool blocked);
    event ContractApproved(address indexed contractAddress);
    event ContractRemoved(address indexed contractAddress);
    // Optional event for pausing/unpausing an oracle.
    event OracleActiveStatusUpdated(address indexed oracle, bytes32 jobId, bool isActive);
    event EntropyPushed(bytes16 entropy, uint256 blockNumber);
    
    /// @dev Generates a composite key from an oracle address and its job ID.
    function _oracleKey(address _oracle, bytes32 _jobId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_oracle, _jobId));
    }
    
    constructor(address _verdiktaToken) Ownable(msg.sender) {
        verdiktaToken = IERC20(_verdiktaToken);
        entropyBuf[0] = 0x0;
        entropyBuf[1] = 0x0;
        entropyBlock  = block.number;
    }
    
    /**
     * @notice Register an oracle with the reputation system
     * @dev Requires VDKA token staking and oracle contract compliance. Only oracle owner or contract owner can register.
     * @param _oracle Address of the oracle contract (must implement IArbiterOperator)
     * @param _jobId Chainlink job ID for this oracle instance
     * @param fee LINK fee required for using this oracle
     * @param _classes Array of evaluation classes this oracle supports (1-5 classes allowed)
     */
    function registerOracle(
        address _oracle,
        bytes32 _jobId,
        uint256 fee,
        uint64[] memory _classes
    ) external {
        require(_oracle != address(0), "Oracle is a zero address");
        require(_oracle.code.length > 0, "Oracle address has no code");
        require(IERC165(_oracle).supportsInterface(ARBITERIFACE), "Oracle not ArbiterOperator type");
        IArbiterOperator op = IArbiterOperator(_oracle);
        require(op.isReputationKeeperListEmpty() || op.isReputationKeeper(address(this)), "Oracle does not support Reputation Keeper");

        bytes32 key = _oracleKey(_oracle, _jobId);
        // Ensure the oracle is not already registered.
        require(oracles[key].stakeAmount == 0, "Oracle is already registered");
        require(fee > 0, "Fee must be greater than 0");
        require(_classes.length > 0, "At least one class must be provided");
        require(_classes.length <= 5, "A maximum of 5 classes are allowed");
        
        require(
            msg.sender == owner() || msg.sender == IOracleOwner(_oracle).owner(),
            "Not authorized to register oracle"
        );
        
        // Transfer the stake from the registering party.
        verdiktaToken.transferFrom(msg.sender, address(this), STAKE_REQUIREMENT);
        
        // Initialize the oracle info.
        OracleInfo storage info = oracles[key];
        info.qualityScore = 0;
        info.timelinessScore = 0;
        info.stakeAmount = STAKE_REQUIREMENT;
        info.isActive = true; // Available by default
        info.jobId = _jobId;
        info.fee = fee;
        info.callCount = 0;
        info.lockedUntil = 0;
        info.blocked = false;
        info.classes = _classes;
        
        // Record the identity if not already present.
        bool exists = false;
        for (uint256 i = 0; i < registeredOracles.length; i++) {
            if (registeredOracles[i].oracle == _oracle && registeredOracles[i].jobId == _jobId) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            registeredOracles.push(OracleIdentity({
                oracle: _oracle, 
                jobId: _jobId,
                classes: _classes
            }));
        }
        
        emit OracleRegistered(_oracle, _jobId, fee);
    }
    
    /**
     * @notice Deregister an oracle and remove it from the reputation system
     * @dev Completely removes oracle record and returns staked tokens. Only callable by oracle owner or contract owner.
     * @param _oracle Address of the oracle contract to deregister
     * @param _jobId Job ID of the oracle instance to deregister
     */
    function deregisterOracle(address _oracle, bytes32 _jobId) external {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        // Check that the oracle is registered by ensuring stakeAmount is nonzero.
        require(info.stakeAmount > 0, "Oracle not registered");
        require(
            msg.sender == owner() || msg.sender == IOracleOwner(_oracle).owner(),
            "Not authorized to deregister oracle"
        );
        require(block.timestamp >= info.lockedUntil, "Oracle is locked and cannot be unregistered");
        
        // Return the staked tokens.
        verdiktaToken.transfer(msg.sender, info.stakeAmount);
        
        // Remove the oracle record completely.
        delete oracles[key];
        
        // Remove the oracle identity from the registeredOracles array using swap and pop.
        for (uint256 i = 0; i < registeredOracles.length; i++) {
            if (registeredOracles[i].oracle == _oracle && registeredOracles[i].jobId == _jobId) {
                registeredOracles[i] = registeredOracles[registeredOracles.length - 1];
                registeredOracles.pop();
                break;
            }
        }
        
        emit OracleDeregistered(_oracle, _jobId);
    }
    
    /**
     * @notice Set an oracle's active status (pause/unpause)
     * @dev Only the contract owner can perform this action. Paused oracles are excluded from selection.
     * @param _oracle Address of the oracle contract
     * @param _jobId Job ID of the oracle instance
     * @param _active True to activate/unpause, false to deactivate/pause
     */
    function setOracleActive(address _oracle, bytes32 _jobId, bool _active) external onlyOwner {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        require(info.stakeAmount > 0, "Oracle not registered");
        info.isActive = _active;
        emit OracleActiveStatusUpdated(_oracle, _jobId, _active);
    }
    
    /**
     * @notice Get comprehensive information about a registered oracle
     * @dev Returns all oracle metadata, scores, staking, and status information
     * @param _oracle Address of the oracle contract
     * @param _jobId Job ID of the oracle instance
     * @return isActive Whether the oracle is currently active and available for selection
     * @return qualityScore Current quality score based on response accuracy
     * @return timelinessScore Current timeliness score based on response speed
     * @return callCount Total number of times this oracle has been called
     * @return jobId The job ID (returned for convenience)
     * @return fee LINK fee required for using this oracle
     * @return stakeAmount Amount of VDKA tokens currently staked
     * @return lockedUntil Timestamp until which oracle is locked (0 if not locked)
     * @return blocked Whether oracle is blocked from selection due to poor performance
     */
    function getOracleInfo(address _oracle, bytes32 _jobId)
        external
        view
        returns (
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
    {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        return (
            info.isActive,
            info.qualityScore,
            info.timelinessScore,
            info.callCount,
            info.jobId,
            info.fee,
            info.stakeAmount,
            info.lockedUntil,
            info.blocked
        );
    }
    
    /**
     * @notice Update reputation scores for an oracle after evaluation completion
     * @dev Called by approved aggregator contracts to reward/penalize oracle performance.
     *      Automatically applies slashing and blocking for poor performance.
     * @param _oracle Address of the oracle contract
     * @param _jobId Job ID of the oracle instance
     * @param qualityChange Change to apply to quality score (positive = reward, negative = penalty)
     * @param timelinessChange Change to apply to timeliness score (positive = reward, negative = penalty)
     */
    function updateScores(
        address _oracle, 
        bytes32 _jobId,
        int8 qualityChange,
        int8 timelinessChange
    ) external {
        bytes32 key = _oracleKey(_oracle, _jobId);
        require(approvedContracts[msg.sender].usedOracles[key], "Oracle not used by this contract");
        
        OracleInfo storage info = oracles[key];
        info.callCount++;
        info.qualityScore += qualityChange;
        info.timelinessScore += timelinessChange;

        // Record score history.
        info.recentScores.push(ScoreRecord({
            qualityScore: info.qualityScore,
            timelinessScore: info.timelinessScore
        }));
        if (info.recentScores.length > maxScoreHistory) {
            for (uint256 i = 0; i < info.recentScores.length - 1; i++) {
                info.recentScores[i] = info.recentScores[i + 1];
            }
            info.recentScores.pop();
        }
        
        // Apply penalties if necessary. Auto-unblock if appropriate.
        if (block.timestamp >= info.lockedUntil) {
            if (info.blocked) info.blocked = false;   // auto-unblock
            if (info.qualityScore < severeThreshold || info.timelinessScore < severeThreshold) {
                if (info.stakeAmount >= slashAmountConfig) {
                    info.stakeAmount -= slashAmountConfig;
                } else {
                    info.stakeAmount = 0;
                }
                info.lockedUntil = block.timestamp + lockDurationConfig;
                info.blocked = true;
                if(info.qualityScore < severeThreshold) {
                    info.qualityScore = mildThreshold;
                }
                if(info.timelinessScore < severeThreshold) {
                    info.timelinessScore = mildThreshold;
                }
                emit OracleSlashed(_oracle, _jobId, slashAmountConfig, info.lockedUntil, true);
            }
            else if (info.qualityScore < mildThreshold || info.timelinessScore < mildThreshold) {
                info.lockedUntil = block.timestamp + lockDurationConfig;
                info.blocked = false;
                emit OracleSlashed(_oracle, _jobId, 0, info.lockedUntil, false);
            }
        }
        
        if (info.recentScores.length == maxScoreHistory) {
            bool worsening = true;
            for (uint256 i = 1; i < maxScoreHistory; i++) {
                if (info.recentScores[i].qualityScore >= info.recentScores[i - 1].qualityScore &&
                    info.recentScores[i].timelinessScore >= info.recentScores[i - 1].timelinessScore) {
                    worsening = false;
                }
            }
            if (worsening) {
                if (info.stakeAmount >= slashAmountConfig) {
                    info.stakeAmount -= slashAmountConfig;
                } else {
                    info.stakeAmount = 0;
                }
                info.lockedUntil = block.timestamp + lockDurationConfig;
                info.blocked = true;
                emit OracleSlashed(_oracle, _jobId, slashAmountConfig, info.lockedUntil, true);
                delete info.recentScores;
            }
        }
        
        emit ScoreUpdated(_oracle, info.qualityScore, info.timelinessScore);
    }
    
    /**
     * @notice Calculate the weighted selection score for an oracle
     * @dev Combines reputation scores with fee weighting to determine selection probability.
     *      Blocked or inactive oracles return score of 0.
     * @param _oracle Address of the oracle contract
     * @param _jobId Job ID of the oracle instance
     * @param params Selection parameters including alpha, fees, and scaling factors
     * @return Weighted selection score (higher = more likely to be selected)
     */
    function getSelectionScore(
        address _oracle,
        bytes32 _jobId,
        SelectionParams memory params
    ) public view returns (uint256) {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        
        // If the oracle is paused (isActive false), it won't be selected.
        if (!info.isActive) return 0;
        if (info.blocked && block.timestamp < info.lockedUntil) return 0;
        
        int256 weightedScore = (int256(1000 - params.alpha) * info.qualityScore +
                                 int256(params.alpha) * info.timelinessScore) / 1000;
        if (weightedScore < int256(MIN_SCORE_FOR_SELECTION)) {
            weightedScore = int256(MIN_SCORE_FOR_SELECTION);
        }
        if (weightedScore > int256(MAX_SCORE_FOR_SELECTION)) {
            weightedScore = int256(MAX_SCORE_FOR_SELECTION);
        }
        
        uint256 oracleFee = info.fee;
        uint256 feeWeightingFactor = 1e18;
        if (oracleFee > params.estimatedBaseCost && params.maxFee > params.estimatedBaseCost) {
            uint256 numerator = (params.maxFee - params.estimatedBaseCost) * 1e18;
            uint256 denominator = oracleFee - params.estimatedBaseCost;
            uint256 ratio = numerator / denominator;
            uint256 maxScaling = params.maxFeeBasedScalingFactor * 1e18;
            if (ratio > maxScaling) {
                feeWeightingFactor = maxScaling;
            } else if (ratio > 1e18) {
                feeWeightingFactor = ratio;
            }
        }
        
        uint256 finalScore = uint256(weightedScore) * feeWeightingFactor / 1e18;
        return finalScore;
    }
    
    /**
     * @notice Select oracles for evaluation using reputation-weighted algorithm
     * @dev Uses two-stage selection: eligibility filtering, optional shortlisting, then weighted selection.
     *      Selection is based on reputation scores, fees, and availability.
     * @param count Number of oracles to select
     * @param alpha Reputation weight factor (0-1000, where 1000 = 100% reputation-based)
     * @param maxFee Maximum fee willing to pay per oracle (in LINK wei)
     * @param estimatedBaseCost Estimated base cost for the evaluation
     * @param maxFeeBasedScalingFactor Maximum scaling factor for fee-based selection weighting
     * @param requestedClass Evaluation class required (oracles must support this class)
     * @return Array of selected oracle identities
     */
    function selectOracles(
        uint256 count,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass
    ) external returns (OracleIdentity[] memory) {
        require(approvedContracts[msg.sender].isApproved, "Not approved to select oracles");
        require(estimatedBaseCost < maxFee, "Base cost must be less than max fee");
        require(maxFeeBasedScalingFactor >= 1, "Max scaling factor must be at least 1");
        selectionCounter++; // bump once per call 
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < registeredOracles.length; i++) {
            OracleIdentity storage id = registeredOracles[i];
            bytes32 key = _oracleKey(id.oracle, id.jobId);
            if (
                oracles[key].isActive &&
                oracles[key].fee <= maxFee &&
                (!(oracles[key].blocked && block.timestamp < oracles[key].lockedUntil)) &&
                _hasClass(id.classes, requestedClass)
            ) {
                eligibleCount++;
            }
        }
        require(eligibleCount > 0, "No active oracles available with fee <= maxFee and requested class");
        
        OracleIdentity[] memory eligibleOracles = new OracleIdentity[](eligibleCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < registeredOracles.length; i++) {
            OracleIdentity storage id = registeredOracles[i];
            bytes32 key = _oracleKey(id.oracle, id.jobId);
            if (
                oracles[key].isActive &&
                oracles[key].fee <= maxFee &&
                (!(oracles[key].blocked && block.timestamp < oracles[key].lockedUntil)) &&
                _hasClass(id.classes, requestedClass)
            ) {
                eligibleOracles[idx] = id;
                idx++;
            }
        }
        
        // Determine the shortlist.
        OracleIdentity[] memory shortlist;
        if (eligibleCount > shortlistSize) {
            shortlist = new OracleIdentity[](shortlistSize);
            for (uint256 i = 0; i < shortlistSize; i++) {
                uint256 randIndex = i + (uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, i))) % (eligibleCount - i));
                OracleIdentity memory temp = eligibleOracles[i];
                eligibleOracles[i] = eligibleOracles[randIndex];
                eligibleOracles[randIndex] = temp;
                shortlist[i] = eligibleOracles[i];
            }
        } else {
            shortlist = eligibleOracles;
        }
        
        SelectionParams memory params = SelectionParams({
            alpha: alpha,
            maxFee: maxFee,
            estimatedBaseCost: estimatedBaseCost,
            maxFeeBasedScalingFactor: maxFeeBasedScalingFactor
        });
        
        return _weightedSelect(shortlist, params, count);
    }
    
    /**
     * @dev Internal helper to perform weighted selection on a given shortlist (while avoiding duplicates if possible).
     */
function _weightedSelect(
    OracleIdentity[] memory shortlist,
    SelectionParams memory params,
    uint256 count
) internal view returns (OracleIdentity[] memory) {

    // Pick arbiter-provided entropy from earlier block to prevent manipulation
    bytes16 chosenEntropy =
        (block.number == entropyBlock) ? entropyBuf[1] : entropyBuf[0];

    uint256 n = shortlist.length;

    // Pre-compute weights once
    uint256[] memory weights = new uint256[](n);
    uint256 totalWeight = 0;
    for (uint256 i; i < n; ++i) {
        weights[i] = getSelectionScore(
            shortlist[i].oracle,
            shortlist[i].jobId,
            params
        );
        totalWeight += weights[i];
    }

    // Keep a copy of the *full* total for later reuse
    uint256 fullWeight = totalWeight;

    OracleIdentity[] memory selected = new OracleIdentity[](count);
    bool[] memory taken = new bool[](n);

    /* ---------- 1st pass: unique selections ---------- */
    uint256 uniqueDraws = count > n ? n : count;
    for (uint256 k; k < uniqueDraws; ++k) {
        bytes32 seed = keccak256(
            abi.encodePacked(chosenEntropy, block.prevrandao, block.timestamp, selectionCounter, k)
        );
        uint256 pivot = uint256(seed) % totalWeight;

        uint256 acc = 0;
        uint256 j;
        for (j = 0; j < n; ++j) {
            if (taken[j]) continue;
            acc += weights[j];
            if (acc > pivot) break;
        }
        selected[k] = shortlist[j];
        taken[j] = true;

        // Burn this weight so it can’t be drawn again in the unique phase
        totalWeight -= weights[j];
    }

    /* ---------- 2nd pass: duplicates allowed (only if needed) ---------- */
    if (count > n) {
        for (uint256 k = uniqueDraws; k < count; ++k) {
            bytes32 seed = keccak256(
                abi.encodePacked(chosenEntropy, block.prevrandao, block.timestamp, k)
            );
            uint256 pivot = uint256(seed) % fullWeight;   // use *full* weight

            uint256 acc = 0;
            for (uint256 j; j < n; ++j) {
                acc += weights[j];
                if (acc > pivot) {
                    selected[k] = shortlist[j];
                    break;              // duplicates now permitted
                }
            }
        }
    }
    return selected;
}
    
    /**
     * @notice Record that specific oracles were used by an approved contract
     * @dev Enables these oracles to have their scores updated by the calling contract later.
     *      Must be called before updateScores can be used.
     * @param _oracleIdentities Array of oracle identities that were used for evaluation
     */
    function recordUsedOracles(OracleIdentity[] calldata _oracleIdentities) external {
        require(approvedContracts[msg.sender].isApproved, "Not approved to record oracles");
        for (uint256 i = 0; i < _oracleIdentities.length; i++) {
            bytes32 key = _oracleKey(_oracleIdentities[i].oracle, _oracleIdentities[i].jobId);
            approvedContracts[msg.sender].usedOracles[key] = true;
        }
    }
    
    /**
     * @notice Set the maximum number of historical score records to maintain per oracle
     * @dev Controls memory usage and affects trend analysis for performance degradation detection
     * @param _maxScoreHistory Maximum number of score records to keep (must be > 0)
     */
    function setMaxScoreHistory(uint256 _maxScoreHistory) external onlyOwner {
        require(_maxScoreHistory > 0, "maxScoreHistory must be > 0");
        maxScoreHistory = _maxScoreHistory;
    }
    
    /**
     * @notice Get the recent score history for an oracle
     * @dev Returns historical performance data used for trend analysis
     * @param _oracle Address of the oracle contract
     * @param _jobId Job ID of the oracle instance
     * @return Array of recent score records showing performance over time
     */
    function getRecentScores(address _oracle, bytes32 _jobId)
        external
        view
        returns (ScoreRecord[] memory)
    {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        uint256 len = info.recentScores.length;
        ScoreRecord[] memory scores = new ScoreRecord[](len);
        for (uint256 i = 0; i < len; i++) {
            scores[i] = info.recentScores[i];
        }
        return scores;
    }
    
    /**
     * @notice Set the amount of VDKA tokens to slash for poor performance
     * @dev Amount slashed when oracles fall below performance thresholds
     * @param _slashAmount Amount of VDKA tokens to slash (in wei)
     */
    function setSlashAmount(uint256 _slashAmount) external onlyOwner {
        slashAmountConfig = _slashAmount;
    }
    
    /**
     * @notice Set the duration for which poorly performing oracles are locked
     * @dev Locked oracles cannot be unregistered and may be blocked from selection
     * @param _lockDuration Lock duration in seconds
     */
    function setLockDuration(uint256 _lockDuration) external onlyOwner {
        lockDurationConfig = _lockDuration;
    }
    
    /**
     * @notice Set the severe performance threshold for slashing and blocking
     * @dev Oracles below this threshold are slashed and blocked from selection
     * @param _threshold Severe threshold value (negative number)
     */
    function setSevereThreshold(int256 _threshold) external onlyOwner {
        severeThreshold = _threshold;
    }
    
    /**
     * @notice Set the mild performance threshold for temporary locking
     * @dev Oracles below this threshold are temporarily locked but not slashed
     * @param _threshold Mild threshold value (negative number)  
     */
    function setMildThreshold(int256 _threshold) external onlyOwner {
        mildThreshold = _threshold;
    }

    /**
     * @notice Update the VDKA token contract address used for staking
     * @dev Changes the token contract used for oracle staking and slashing
     * @param _newVerdiktaToken Address of the new VDKA token contract
     */
    function setVerdiktaToken(address _newVerdiktaToken) external onlyOwner {
        require(_newVerdiktaToken != address(0), "Invalid token address");
        verdiktaToken = IERC20(_newVerdiktaToken);
    }

    /**
     * @notice Manually block a specific oracle for a given duration
     * @dev    Only callable by the contract owner.
     *         While blocked, the oracle is excluded from selection
     *         (`selectOracles`, `getSelectionScore`) exactly the same way
     *         as when it is auto-blocked for poor performance.
     *
     * @param _oracle   The oracle contract address
     * @param _jobId    The job-ID of that oracle instance
     * @param _duration How long to block it, **in seconds**.
     *                  Pass 0 to use the current `lockDurationConfig`.
     */
    function manualBlockOracle(
        address _oracle,
        bytes32 _jobId,
        uint256 _duration
    ) external onlyOwner {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        require(info.stakeAmount > 0, "Oracle not registered");

        uint256 duration = _duration == 0 ? lockDurationConfig : _duration;
        require(duration > 0, "Duration must be > 0");

        info.blocked     = true;
        info.lockedUntil = block.timestamp + duration;
    }

    /**
     * @notice Hard-reset all reputation data.
     *         Callable only by the contract owner.
     *
     *         This walks the whole `registeredOracles` array and can run
     *         out of gas if there are “many” oracles.  
     */
    function resetAllReputations() external onlyOwner {
        // 1. Reset the global counter that shows up in oracle selection.
        selectionCounter = 0;

        // 2. Loop through every registered identity and zero out its data.
        uint256 len = registeredOracles.length;
        for (uint256 i; i < len; ++i) {
            OracleIdentity storage id = registeredOracles[i];
            bytes32 key = _oracleKey(id.oracle, id.jobId);
            OracleInfo storage info = oracles[key];

            info.qualityScore     = 0;
            info.timelinessScore  = 0;
            info.callCount        = 0;

            // clear the sliding window completely
            delete info.recentScores;

            // unblock & unlock so the oracle can be picked again immediately
            info.blocked     = false;
            info.lockedUntil = 0;
        }
    }

    /**
     * @notice Get the total number of registered oracles
     * @dev Returns the count of all oracle identities in the system
     * @return Total number of registered oracle identities
     */
    function getRegisteredOraclesCount() external view returns (uint256) {
        return registeredOracles.length;
    }

    /**
     * @dev Check if an oracle supports a specific evaluation class
     * @param classes Array of classes supported by the oracle
     * @param requestedClass The class being requested
     * @return bool True if the oracle supports the requested class
     */
    function _hasClass(uint64[] memory classes, uint64 requestedClass) internal pure returns (bool) {
        for (uint256 i = 0; i < classes.length; i++) {
            if (classes[i] == requestedClass) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Get the evaluation classes supported by an oracle at a specific index
     * @dev Returns classes for oracle at given index in registeredOracles array
     * @param index Index in the registeredOracles array
     * @return Array of evaluation classes supported by the oracle
     */
    function getOracleClasses(uint256 index) public view returns (uint64[] memory) {
        require(index < registeredOracles.length, "Index out of bounds");
        return registeredOracles[index].classes;
    }

    /**
     * @notice Get the evaluation classes supported by a specific oracle identity
     * @dev Returns classes for oracle identified by address and job ID
     * @param _oracle Address of the oracle contract
     * @param _jobId Job ID of the oracle instance
     * @return Array of evaluation classes supported by the oracle
     */
    function getOracleClassesByKey(address _oracle, bytes32 _jobId) public view returns (uint64[] memory) {
        for (uint256 i = 0; i < registeredOracles.length; i++) {
            if (registeredOracles[i].oracle == _oracle && registeredOracles[i].jobId == _jobId) {
                return registeredOracles[i].classes;
            }
        }
        revert("Oracle not found");
    }

    /**
     * @notice Set the maximum number of oracles to consider in second-stage selection
     * @dev Controls the shortlist size for weighted selection when many oracles are available
     * @param newSize Maximum shortlist size (must be > 0)
     */
    function setShortlistSize(uint256 newSize) external onlyOwner {
        require(newSize > 0, "Shortlist size must be > 0");
        shortlistSize = newSize;
    }
    
    /**
     * @notice Approve a contract to select and use oracles from the reputation system
     * @dev Only approved contracts can call selectOracles, recordUsedOracles, and updateScores
     * @param contractAddress Address of the contract to approve (typically an aggregator contract)
     */
    function approveContract(address contractAddress) external onlyOwner {
        approvedContracts[contractAddress].isApproved = true;
        emit ContractApproved(contractAddress);
    }

    /**
     * @notice Check if a contract is approved to use the reputation system
     * @dev Lightweight getter for contract approval status
     * @param contractAddress Address of the contract to check
     * @return bool True if the contract is approved, false otherwise
     */
    function isContractApproved(address contractAddress) external view returns (bool) {
        return approvedContracts[contractAddress].isApproved;
    }
    
    /**
     * @notice Revoke a contract's approval to use oracles
     * @dev Removes the contract's ability to select oracles and update scores
     * @param contractAddress Address of the contract to remove approval from
     */
    function removeContract(address contractAddress) external onlyOwner {
        approvedContracts[contractAddress].isApproved = false;
        emit ContractRemoved(contractAddress);
    }

    /**
     * @notice Update entropy buffer with new randomness from aggregator contracts
     * @dev Called by approved aggregators to provide entropy for oracle selection randomization.
     *      Maintains a 2-slot buffer to prevent manipulation from same-block calls.
     * @param e New entropy value to add to the buffer
     */
    function pushEntropy(bytes16 e) external {
        require(approvedContracts[msg.sender].isApproved, "not aggregator");

        if (block.number > entropyBlock) {
            entropyBuf[1] = entropyBuf[0];   // shift
            entropyBuf[0] = e;               // store newest
            entropyBlock  = block.number;
            emit EntropyPushed(e, entropyBlock);
        }
    }
}

