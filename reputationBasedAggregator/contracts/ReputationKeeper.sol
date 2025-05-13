// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

///TODO import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
///TODO import "./IArbiterOperator.sol";   // same interface as above
///TODO bytes4 private constant _ARBITER_IFACE = type(IArbiterOperator).interfaceId;

/// @notice Minimal interface to query an oracle contract's owner.
interface IOracleOwner {
    function owner() external view returns (address);
}

/**
 * @title ReputationKeeper
 * @notice Tracks oracle reputations using composite keys (oracle address and jobID).
 */
contract ReputationKeeper is Ownable {
    // A composite identity for an oracle.
    struct OracleIdentity {
        address oracle;
        bytes32 jobId;
        uint64[] classes; // list of classes (up to 5) supported by this oracle
    }

    // A single record of (qualityScore, timelinessScore).
    struct ScoreRecord {
        int256 qualityScore;
        int256 timelinessScore;
    }

    // Information about each oracle identity.
    struct OracleInfo {
        int256 qualityScore;    // Score based on clustering accuracy
        int256 timelinessScore; // Score based on response timeliness
        uint256 stakeAmount;    // Amount of VDKA tokens staked
        bool isActive;          // Indicates if the oracle is available (true) or temporarily paused (false)
        bytes32 jobId;          // The job ID (redundant but stored for convenience)
        uint256 fee;            // LINK fee required for this job
        uint256 callCount;      // Number of times this oracle has been called
        ScoreRecord[] recentScores; // Rolling history of scores
        uint256 lockedUntil;    // Timestamp until which the oracle is locked (cannot be unregistered)
        bool blocked;           // If true, oracle is blocked from selection
        uint64[] classes;       // Classes for this oracle
    }
    
    // Per–contract usage data.
    struct ContractInfo {
        bool isApproved;      // Whether this contract is approved to use oracles
        // Mapping from composite oracle key to whether the contract used that oracle.
        mapping(bytes32 => bool) usedOracles;
    }
    
    // Group selection parameters into one struct to reduce stack usage.
    struct SelectionParams {
        uint256 alpha;
        uint256 maxFee;
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScalingFactor;
    }

    IERC20 public verdiktaToken;

    // Composite key (oracle, jobID) → OracleInfo.
    mapping(bytes32 => OracleInfo) public oracles;
    // Approved external contracts (for example, reputation aggregators).
    mapping(address => ContractInfo) public approvedContracts;
    // List of all registered oracle identities.
    OracleIdentity[] public registeredOracles;
    
    // The maximum number of historical score records to keep for each oracle.
    uint256 public maxScoreHistory = 10;

    uint256 public constant STAKE_REQUIREMENT = 100 * 10**18;  // 100 VDKA tokens
    uint256 public constant MAX_SCORE_FOR_SELECTION = 400;
    uint256 public constant MIN_SCORE_FOR_SELECTION = 1;
    
    // Configuration for slashing and locking.
    uint256 public slashAmountConfig = 10 * 10**18;  // 10 VDKA tokens (configurable)
    uint256 public lockDurationConfig = 2 hours;       // Lock period (configurable)
    int256 public severeThreshold = -40;               // Severe threshold (configurable)
    int256 public mildThreshold = -20;                 // Mild threshold (configurable)
    
    // The maximum number of oracles to weight in the second-stage selection.
    // Default is 20 but can be updated by the owner.
    uint256 public shortlistSize = 20;
    
    event OracleRegistered(address indexed oracle, bytes32 jobId, uint256 fee);
    event OracleDeregistered(address indexed oracle, bytes32 jobId);
    event ScoreUpdated(address indexed oracle, int256 newQualityScore, int256 newTimelinessScore);
    event OracleSlashed(address indexed oracle, bytes32 jobId, uint256 slashAmount, uint256 lockedUntil, bool blocked);
    event ContractApproved(address indexed contractAddress);
    event ContractRemoved(address indexed contractAddress);
    // Optional event for pausing/unpausing an oracle.
    event OracleActiveStatusUpdated(address indexed oracle, bytes32 jobId, bool isActive);
    
    /// @dev Generates a composite key from an oracle address and its job ID.
    function _oracleKey(address _oracle, bytes32 _jobId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_oracle, _jobId));
    }
    
    constructor(address _verdiktaToken) Ownable(msg.sender) {
        verdiktaToken = IERC20(_verdiktaToken);
    }
    
    /**
     * @notice Register an oracle under a specific job ID.
     */
    function registerOracle(
        address _oracle,
        bytes32 _jobId,
        uint256 fee,
        uint64[] memory _classes
    ) external {
        ///TODO require(IERC165(oracle).supportsInterface(_ARBITER_IFACE),
        ///TODO    "Oracle must be ArbiterOperator");
        bytes32 key = _oracleKey(_oracle, _jobId);
        // Ensure the oracle is not already registered.
        require(oracles[key].stakeAmount == 0, "Oracle already registered");
        require(fee > 0, "Fee must be greater than 0");
        require(_classes.length > 0, "At least one class must be provided");
        require(_classes.length <= 5, "A maximum of 5 classes allowed");
        
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
     * @notice Deregister an oracle identity.
     * Completely removes the oracle record from storage.
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
     * @notice Set an oracle's active status (pause/unpause).
     * Only the contract owner can perform this action.
     * When paused, isActive is set to false; when unpaused, it is set to true.
     */
    function setOracleActive(address _oracle, bytes32 _jobId, bool _active) external onlyOwner {
        bytes32 key = _oracleKey(_oracle, _jobId);
        OracleInfo storage info = oracles[key];
        require(info.stakeAmount > 0, "Oracle not registered");
        info.isActive = _active;
        emit OracleActiveStatusUpdated(_oracle, _jobId, _active);
    }
    
    /**
     * @notice Retrieve an oracle identity's info.
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
     * @notice Update reputation scores for an oracle identity.
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
        
        // Apply penalties if necessary.
        if (block.timestamp >= info.lockedUntil) {
            if (info.qualityScore < severeThreshold || info.timelinessScore < severeThreshold) {
                if (info.stakeAmount >= slashAmountConfig) {
                    info.stakeAmount -= slashAmountConfig;
                } else {
                    info.stakeAmount = 0;
                }
                info.lockedUntil = block.timestamp + lockDurationConfig;
                info.blocked = true;
                emit OracleSlashed(_oracle, _jobId, slashAmountConfig, info.lockedUntil, true);
            }
            else if (info.qualityScore < mildThreshold || info.timelinessScore < mildThreshold) {
                info.lockedUntil = block.timestamp + lockDurationConfig;
                info.blocked = false;
                emit OracleSlashed(_oracle, _jobId, 0, info.lockedUntil, false);
            }
        }
        
        if (info.recentScores.length == maxScoreHistory) {
            bool qualityWorsening = true;
            bool timelinessWorsening = true;
            for (uint256 i = 1; i < maxScoreHistory; i++) {
                if (info.recentScores[i].qualityScore >= info.recentScores[i - 1].qualityScore) {
                    qualityWorsening = false;
                }
                if (info.recentScores[i].timelinessScore >= info.recentScores[i - 1].timelinessScore) {
                    timelinessWorsening = false;
                }
            }
            if (qualityWorsening || timelinessWorsening) {
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
     * @notice Calculate the weighted selection score for an oracle identity.
     * Oracles that are blocked (and still within the lock period) are treated as having a score of 0.
     * Now accepts a single SelectionParams struct.
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
     * @notice Select a list of oracle identities based on their weighted scores.
     * Uses a two-stage approach:
     *  1. Filter eligible oracles (active, fee <= maxFee, not blocked, supporting the requested class).
     *  2. If eligible count > shortlistSize, randomly select a subset of size shortlistSize.
     *  3. Perform weighted selection on that shortlist.
     */
    function selectOracles(
        uint256 count,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass
    ) external view returns (OracleIdentity[] memory) {
        require(approvedContracts[msg.sender].isApproved, "Not approved to select oracles");
        require(estimatedBaseCost < maxFee, "Base cost must be less than max fee");
        require(maxFeeBasedScalingFactor >= 1, "Max scaling factor must be at least 1");
        
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
     * @dev Internal helper to perform weighted selection on a given shortlist.
     */
    function _weightedSelect(
        OracleIdentity[] memory shortlist,
        SelectionParams memory params,
        uint256 count
    ) internal view returns (OracleIdentity[] memory) {
        uint256 shortlistCount = shortlist.length;
        uint256 totalWeight = 0;
        uint256[] memory weights = new uint256[](shortlistCount);
        for (uint256 i = 0; i < shortlistCount; i++) {
            weights[i] = getSelectionScore(shortlist[i].oracle, shortlist[i].jobId, params);
            totalWeight += weights[i];
        }
        OracleIdentity[] memory selectedOracles = new OracleIdentity[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 seed = uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, i)));
            uint256 selection = seed % totalWeight;
            uint256 sum = 0;
            for (uint256 j = 0; j < shortlistCount; j++) {
                sum += weights[j];
                if (sum > selection) {
                    selectedOracles[i] = shortlist[j];
                    break;
                }
            }
            if (selectedOracles[i].oracle == address(0)) {
                selectedOracles[i] = shortlist[0];
            }
        }
        return selectedOracles;
    }
    
    /**
     * @notice Records that a set of oracle identities were used by an approved contract.
     */
    function recordUsedOracles(OracleIdentity[] calldata _oracleIdentities) external {
        require(approvedContracts[msg.sender].isApproved, "Not approved to record oracles");
        for (uint256 i = 0; i < _oracleIdentities.length; i++) {
            bytes32 key = _oracleKey(_oracleIdentities[i].oracle, _oracleIdentities[i].jobId);
            approvedContracts[msg.sender].usedOracles[key] = true;
        }
    }
    
    function setMaxScoreHistory(uint256 _maxScoreHistory) external onlyOwner {
        require(_maxScoreHistory > 0, "maxScoreHistory must be > 0");
        maxScoreHistory = _maxScoreHistory;
    }
    
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
    
    // Owner setters for slashing configuration.
    function setSlashAmount(uint256 _slashAmount) external onlyOwner {
        slashAmountConfig = _slashAmount;
    }
    
    function setLockDuration(uint256 _lockDuration) external onlyOwner {
        lockDurationConfig = _lockDuration;
    }
    
    function setSevereThreshold(int256 _threshold) external onlyOwner {
        severeThreshold = _threshold;
    }
    
    function setMildThreshold(int256 _threshold) external onlyOwner {
        mildThreshold = _threshold;
    }

    /**
     * @notice Updates the reference to the VerdiktaToken contract.
     */
    function setVerdiktaToken(address _newVerdiktaToken) external onlyOwner {
        require(_newVerdiktaToken != address(0), "Invalid token address");
        verdiktaToken = IERC20(_newVerdiktaToken);
    }

    // Return the count of registered oracles.
    function getRegisteredOraclesCount() external view returns (uint256) {
        return registeredOracles.length;
    }

    /**
     * @dev Internal helper: Check if the given classes array contains the requested class.
     */
    function _hasClass(uint64[] memory classes, uint64 requestedClass) internal pure returns (bool) {
        for (uint256 i = 0; i < classes.length; i++) {
            if (classes[i] == requestedClass) {
                return true;
            }
        }
        return false;
    }

    function getOracleClasses(uint256 index) public view returns (uint64[] memory) {
        require(index < registeredOracles.length, "Index out of bounds");
        return registeredOracles[index].classes;
    }

    function getOracleClassesByKey(address _oracle, bytes32 _jobId) public view returns (uint64[] memory) {
        for (uint256 i = 0; i < registeredOracles.length; i++) {
            if (registeredOracles[i].oracle == _oracle && registeredOracles[i].jobId == _jobId) {
                return registeredOracles[i].classes;
            }
        }
        revert("Oracle not found");
    }

    /**
     * @notice Set a new shortlist size for oracle selection.
     * Only the owner can update this value.
     */
    function setShortlistSize(uint256 newSize) external onlyOwner {
        require(newSize > 0, "Shortlist size must be > 0");
        shortlistSize = newSize;
    }
    
    /**
     * @notice Approve a contract to use oracles.
     */
    function approveContract(address contractAddress) external onlyOwner {
        approvedContracts[contractAddress].isApproved = true;
        emit ContractApproved(contractAddress);
    }
    
    /**
     * @notice Remove a contract's approval.
     */
    function removeContract(address contractAddress) external onlyOwner {
        approvedContracts[contractAddress].isApproved = false;
        emit ContractRemoved(contractAddress);
    }
}

