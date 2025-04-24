// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ReputationKeeper.sol";

/**
 * @title ReputationAggregator
 * @notice Aggregates responses from Chainlink oracles and updates reputation scores.
 *
 *         This contract supports only a user-funded flow. In this mode, the caller
 *         must pre-approve the contract for at least:
 *             maxOracleFee * (oraclesToPoll + clusterSize)
 *         The contract withdraws exactly the fee required for each oracle call (and later bonus payments).
 *         The caller also supplies parameters for oracle selection.
 */
contract ReputationAggregator is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    // ------------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------------
    uint256 public oraclesToPoll;       // Total oracles to poll (M)
    uint256 public requiredResponses;   // First N responses to consider (N)
    uint256 public clusterSize;         // Cluster size (P)
    uint256 public responseTimeoutSeconds = 300; // Timeout in seconds for responses (default: 5 minutes)
    uint256 public alpha = 500;         // Reputation weight

    // Owner-settable maximum fee for selecting oracles.
    uint256 public maxOracleFee;
    
    // Parameters for fee-based oracle selection.
    uint256 public baseFeePct = 1;      // Base fee percentage of maxOracleFee (default 1%)
    uint256 public maxFeeBasedScalingFactor = 10; // Maximum scaling factor

    // ------------------------------------------------------------------------
    // Limits for CID inputs (added)
    // ------------------------------------------------------------------------
    uint256 public constant MAX_CID_COUNT = 10;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    // Reference to the ReputationKeeper contract.
    ReputationKeeper public reputationKeeper;

    // ------------------------------------------------------------------------
    // Public events and debug events
    // ------------------------------------------------------------------------
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
    event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] aggregatedLikelihoods, string combinedJustificationCIDs);
    event OracleScoreUpdateSkipped(address indexed oracle, bytes32 indexed jobId, string reason);
    event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, address operator);
    event BonusPayment(address indexed operator, uint256 bonusFee);
    event DebugBonusTransfer(
        address indexed operator,
        uint256 bonusFee,
        uint256 balanceBefore,
        uint256 balanceAfter,
        bool success
    );
    event EvaluationTimedOut(bytes32 indexed aggregatorRequestId);

    // ------------------------------------------------------------------------
    // Structures
    // ------------------------------------------------------------------------
    struct Response {
        uint256[] likelihoods;
        string justificationCID;
        bytes32 requestId;
        bool selected;       // true if among the first N responses
        uint256 timestamp;
        address operator;
        uint256 pollIndex;   // Which poll slot (0..M-1) this response corresponds to
        bytes32 jobId;       // The job ID associated with the oracle
    }

    struct AggregatedEvaluation {
        Response[] responses;
        uint256[] aggregatedLikelihoods;
        uint256 responseCount;
        uint256 expectedResponses;
        uint256 requiredResponses;
        uint256 clusterSize;
        bool isComplete;
        mapping(bytes32 => bool) requestIds;  // Track valid request IDs
        ReputationKeeper.OracleIdentity[] polledOracles;
        uint256[] pollFees; // store the fee for each poll slot (for bonus payment)
        // In user-funded mode:
        bool userFunded;
        address requester;
        // --- New field: store only the combined clustered justifications ---
        string combinedJustificationCIDs;
        // --- New field: record when the evaluation was created ---
        uint256 startTimestamp;
    }

    // Mapping from aggregator-level requestId to its evaluation.
    mapping(bytes32 => AggregatedEvaluation) public aggregatedEvaluations;
    // Mapping from a Chainlink operator request id to aggregator request id.
    mapping(bytes32 => bytes32) public requestIdToAggregatorId;
    // Mapping from a Chainlink operator request id to the poll slot index.
    mapping(bytes32 => uint256) public requestIdToPollIndex;

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------
    constructor(address _link, address _reputationKeeper) Ownable(msg.sender) {
        _setChainlinkToken(_link);
        reputationKeeper = ReputationKeeper(_reputationKeeper);
        // Default configuration values:
        oraclesToPoll = 4;
        requiredResponses = 3;
        clusterSize = 2;
        responseTimeoutSeconds = 5 minutes;
        // Set a default maximum fee (e.g., 0.1 LINK)
        maxOracleFee = 0.1 * 10**18;
    }

    // ------------------------------------------------------------------------
    // Setters and getters for configuration
    // ------------------------------------------------------------------------
    function setResponseTimeout(uint256 _timeoutSeconds) external onlyOwner {
        responseTimeoutSeconds = _timeoutSeconds;
    }

    function setAlpha(uint256 _alpha) external onlyOwner {
        require(_alpha <= 1000, "Alpha must be between 0 and 1000");
        alpha = _alpha;
    }

    function getAlpha() external view returns (uint256) {
        return alpha;
    }

    function setMaxOracleFee(uint256 _maxOracleFee) external onlyOwner {
        maxOracleFee = _maxOracleFee;
    }
    
   /**
    * @notice Calculate the maximum total fee that might be required based on provided max oracle fee
    * @param requestedMaxOracleFee The requested maximum oracle fee which may be lower than the contract's maxOracleFee
    * @return The maximum total fee (min(requestedMaxOracleFee, maxOracleFee) * (oraclesToPoll + clusterSize))
    */
   function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
       uint256 effectiveMaxOracleFee = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
       return effectiveMaxOracleFee * (oraclesToPoll + clusterSize);
   } 

    /**
     * @notice Set the base fee percentage (as a percentage of maxOracleFee)
     * @param _baseFeePct The base fee percentage (1-100)
     */
    function setBaseFeePct(uint256 _baseFeePct) external onlyOwner {
        require(_baseFeePct > 0 && _baseFeePct <= 100, "Base fee percentage must be between 1-100");
        baseFeePct = _baseFeePct;
    }
    
    /**
     * @notice Set the maximum fee-based scaling factor
     * @param _maxFeeBasedScalingFactor The maximum scaling factor (must be at least 1)
     */
    function setMaxFeeBasedScalingFactor(uint256 _maxFeeBasedScalingFactor) external onlyOwner {
        require(_maxFeeBasedScalingFactor >= 1, "Max scaling factor must be at least 1");
        maxFeeBasedScalingFactor = _maxFeeBasedScalingFactor;
    }
    
    /**
     * @notice Calculate the estimated base cost based on the current baseFeePct
     * @return The estimated base cost in LINK tokens
     */
    function getEstimatedBaseCost() public view returns (uint256) {
        return (maxOracleFee * baseFeePct) / 100;
    }

    function setConfig(
        uint256 _oraclesToPoll,
        uint256 _requiredResponses,
        uint256 _clusterSize,
        uint256 _responseTimeout
    ) external onlyOwner {
        require(_oraclesToPoll >= _requiredResponses, "Invalid poll vs. required");
        require(_requiredResponses >= _clusterSize, "Invalid cluster size");
        require(_responseTimeout > 0, "Invalid timeout");

        oraclesToPoll = _oraclesToPoll;
        requiredResponses = _requiredResponses;
        clusterSize = _clusterSize;
        responseTimeoutSeconds = _responseTimeout;
    }

    // Expose Chainlink token setter.
    function setChainlinkToken(address _link) external onlyOwner {
        _setChainlinkToken(_link);
    }

    // Set reputationKeeper.
    function setReputationKeeper(address _reputationKeeper) external onlyOwner {
        reputationKeeper = ReputationKeeper(_reputationKeeper);
    }

    // ------------------------------------------------------------------------
    // New functionality:
    // requestAIEvaluationWithApproval: Initiates oracle requests using funds withdrawn via transferFrom.
    //
    // The caller must have approved this contract for at least:
    //     maxOracleFee * (oraclesToPoll + clusterSize)
    // The contract withdraws exactly the fee needed for each oracle call and bonus payment.
    // Additionally, the caller passes in values for oracle selection parameters.
    // ------------------------------------------------------------------------
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass   // <-- New parameter: requested oracle class
    ) 
        public 
        nonReentrant
        returns (bytes32) 
    {
        require(address(reputationKeeper) != address(0), "ReputationKeeper not set");
        require(cids.length > 0, "CIDs array must not be empty");
        require(cids.length <= MAX_CID_COUNT, "Too many CIDs provided");
        for (uint256 i = 0; i < cids.length; i++) {
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID string too long");
        }
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "Addendum text string too long");

        // Concatenate CIDs (comma delimited) and append the optional addendum string for oracle consumption.
        bytes memory concatenatedBytes;
        for (uint i = 0; i < cids.length; i++) 
            concatenatedBytes = abi.encodePacked(concatenatedBytes, cids[i], i < cids.length - 1 ? "," : "");
        string memory cidsConcatenated = string(concatenatedBytes);

        if (bytes(addendumText).length > 0) {
            cidsConcatenated = string(abi.encodePacked(cidsConcatenated, ":", addendumText));
        }

        bytes32 aggregatorRequestId = keccak256(
            abi.encodePacked(
                block.timestamp,
                msg.sender,
                cidsConcatenated
            )
        );

        AggregatedEvaluation storage aggEval = aggregatedEvaluations[aggregatorRequestId];
        aggEval.expectedResponses = oraclesToPoll;
        aggEval.requiredResponses = requiredResponses;
        aggEval.clusterSize = clusterSize;
        aggEval.isComplete = false;
        aggEval.userFunded = true;
        aggEval.requester = msg.sender;
        // Set the start timestamp to allow timeout checking later
        aggEval.startTimestamp = block.timestamp;

        // -------------------------------------------------------
        // Now call external selection function (view from Keeper)
        // -------------------------------------------------------
        ReputationKeeper.OracleIdentity[] memory selectedOracles = reputationKeeper.selectOracles(
            oraclesToPoll,
            _alpha,
            _maxOracleFee,
            _estimatedBaseCost,
            _maxFeeBasedScalingFactor,
            _requestedClass  // Pass the requested class to filter oracles
        );
        reputationKeeper.recordUsedOracles(selectedOracles);

        // -------------------------------------------------------
        // Interactions (transfers & sending requests)
        // -------------------------------------------------------
        for (uint256 i = 0; i < selectedOracles.length; i++) {
            aggEval.polledOracles.push(selectedOracles[i]);

            address operator = selectedOracles[i].oracle;
            bytes32 jobIdForOracle = selectedOracles[i].jobId;
            (bool isActive, , , , bytes32 jobIdReturned, uint256 fee, , , ) = reputationKeeper.getOracleInfo(operator, jobIdForOracle);
            require(isActive, "Selected oracle not active at time of polling");

            require(
                LinkTokenInterface(_chainlinkTokenAddress()).transferFrom(msg.sender, address(this), fee),
                "transferFrom for fee failed"
            );

            bytes32 operatorRequestId = _sendSingleOracleRequest(operator, jobIdReturned, fee, cidsConcatenated);
            requestIdToAggregatorId[operatorRequestId] = aggregatorRequestId;
            requestIdToPollIndex[operatorRequestId] = aggEval.polledOracles.length - 1;
            aggEval.requestIds[operatorRequestId] = true;

            aggEval.pollFees.push(fee);
        }

        emit RequestAIEvaluation(aggregatorRequestId, cids);
        return aggregatorRequestId;
    }

    // ------------------------------------------------------------------------
    // New function: Finalize an evaluation if the response timeout has been exceeded.
    // If not enough responses have been received when the timeout is reached, the function fails.
    // ------------------------------------------------------------------------
    function finalizeEvaluationTimeout(bytes32 aggregatorRequestId) external nonReentrant {
        AggregatedEvaluation storage aggEval = aggregatedEvaluations[aggregatorRequestId];
        require(!aggEval.isComplete, "Aggregation already completed");
        require(block.timestamp >= aggEval.startTimestamp + responseTimeoutSeconds, "Evaluation not yet timed out");
        require(aggEval.responseCount >= aggEval.requiredResponses, "Not enough responses; evaluation failed");

        _finalizeAggregation(aggregatorRequestId);
        emit EvaluationTimedOut(aggregatorRequestId);
    }

    // ------------------------------------------------------------------------
    // Helper: send a single Chainlink request.
    // ------------------------------------------------------------------------
    function _sendSingleOracleRequest(
        address operator,
        bytes32 jobId,
        uint256 fee,
        string memory cidsConcatenated
    ) internal returns (bytes32) {
        Chainlink.Request memory req = _buildOperatorRequest(jobId, this.fulfill.selector);
        req._add("cid", cidsConcatenated);
        bytes32 operatorRequestId = _sendOperatorRequestTo(operator, req, fee);
        return operatorRequestId;
    }

    // ------------------------------------------------------------------------
    // fulfill: Callback from Chainlink node.
    // ------------------------------------------------------------------------
    function fulfill(
        bytes32 _operatorRequestId,
        uint256[] memory likelihoods,
        string memory justificationCID
    ) public recordChainlinkFulfillment(_operatorRequestId) {
        require(likelihoods.length > 0, "Likelihoods array must not be empty");

        bytes32 aggregatorRequestId = requestIdToAggregatorId[_operatorRequestId];
        require(aggregatorRequestId != bytes32(0), "Unknown requestId");

        AggregatedEvaluation storage aggEval = aggregatedEvaluations[aggregatorRequestId];
        require(!aggEval.isComplete, "Aggregation already completed");
        require(aggEval.requestIds[_operatorRequestId], "Invalid requestId");

        uint256 pollIndex = requestIdToPollIndex[_operatorRequestId];
        ReputationKeeper.OracleIdentity memory oracleIdentity = aggEval.polledOracles[pollIndex];

        bool selected = (aggEval.responses.length < aggEval.requiredResponses);

        Response memory newResp = Response({
            likelihoods: likelihoods,
            justificationCID: justificationCID,
            requestId: _operatorRequestId,
            selected: selected,
            timestamp: block.timestamp,
            operator: msg.sender,
            pollIndex: pollIndex,
            jobId: oracleIdentity.jobId
        });
        aggEval.responses.push(newResp);
        aggEval.responseCount++;

        emit NewOracleResponseRecorded(_operatorRequestId, pollIndex, msg.sender);
        emit ChainlinkFulfilled(_operatorRequestId);

        if (aggEval.responseCount >= aggEval.requiredResponses) {
            _finalizeAggregation(aggregatorRequestId);
        }
    }

    // ------------------------------------------------------------------------
    // _finalizeAggregation: Processes responses and pays bonus fees.
    // ------------------------------------------------------------------------
    function _finalizeAggregation(bytes32 aggregatorRequestId) internal nonReentrant {
        AggregatedEvaluation storage aggEval = aggregatedEvaluations[aggregatorRequestId];

        uint256 selectedCount = 0;
        for (uint256 i = 0; i < aggEval.responses.length; i++) {
            if (aggEval.responses[i].selected) {
                selectedCount++;
            }
        }
        uint256[] memory selectedResponseIndices = new uint256[](selectedCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < aggEval.responses.length; i++) {
            if (aggEval.responses[i].selected) {
                selectedResponseIndices[idx] = i;
                idx++;
            }
        }
        uint256[] memory clusterResults;
        if (selectedCount >= 2) {
            clusterResults = _findBestClusterFromResponses(aggEval.responses, selectedResponseIndices);
        } else {
            clusterResults = new uint256[](selectedCount);
            for (uint256 i = 0; i < selectedCount; i++) {
                clusterResults[i] = 0;
            }
        }

        if (aggEval.responses.length > 0) {
            aggEval.aggregatedLikelihoods = new uint256[](aggEval.responses[0].likelihoods.length);
        }
        uint256 clusterCount = 0;
        uint256 m = aggEval.polledOracles.length;
        for (uint256 slot = 0; slot < m; slot++) {
            bool processed;
            uint256 updateCluster;
            (processed, updateCluster) = _processPollSlot(aggEval, slot, selectedResponseIndices, clusterResults);
            if (processed && updateCluster > 0) {
                uint256[] storage aggregated = aggEval.aggregatedLikelihoods;
                uint256 respIdx = _findResponseIndexForSlot(aggEval.responses, slot);
                if (respIdx < aggEval.responses.length) {
                    uint256[] memory currLikely = aggEval.responses[respIdx].likelihoods;
                    for (uint256 j = 0; j < currLikely.length; j++) {
                        aggregated[j] += currLikely[j];
                    }
                    clusterCount++;
                }
            }
        }

        if (clusterCount > 0) {
            for (uint256 i = 0; i < aggEval.aggregatedLikelihoods.length; i++) {
                aggEval.aggregatedLikelihoods[i] /= clusterCount;
            }
        }

        string memory combinedCIDs = "";
        bool first = true;
        for (uint256 i = 0; i < selectedResponseIndices.length; i++) {
            if (clusterResults[i] == 1) {
                uint256 respIdx = selectedResponseIndices[i];
                Response memory resp = aggEval.responses[respIdx];
                if (!first) {
                    combinedCIDs = string(abi.encodePacked(combinedCIDs, ","));
                }
                combinedCIDs = string(abi.encodePacked(combinedCIDs, resp.justificationCID));
                first = false;
            }
        }
        // Save the clustered justifications so that getEvaluation returns only these.
        aggEval.combinedJustificationCIDs = combinedCIDs;

        aggEval.isComplete = true;
        emit FulfillAIEvaluation(aggregatorRequestId, aggEval.aggregatedLikelihoods, combinedCIDs);
    }

    // ------------------------------------------------------------------------
    // Helper: Process one poll slot.
    // Returns (processed, updateCluster) where updateCluster is 1 if bonus is to be paid.
    // ------------------------------------------------------------------------
    function _processPollSlot(
        AggregatedEvaluation storage aggEval,
        uint256 slot,
        uint256[] memory selectedResponseIndices,
        uint256[] memory clusterResults
    ) internal returns (bool processed, uint256 updateCluster) {
        ReputationKeeper.OracleIdentity memory id = aggEval.polledOracles[slot];
        (bool isActive, , , , , , , , ) = reputationKeeper.getOracleInfo(id.oracle, id.jobId);
        if (!isActive) {
            emit OracleScoreUpdateSkipped(id.oracle, id.jobId, "Inactive at finalization");
            return (false, 0);
        }
        (bool responded, uint256 respIndex) = _getResponseForSlot(aggEval.responses, slot);
        if (responded) {
            Response memory resp = aggEval.responses[respIndex];
            if (resp.selected) {
                (bool found, uint256 selIndex) = _findIndexInArray(selectedResponseIndices, respIndex);
                if (found) {
                    if (clusterResults[selIndex] == 1) {
                        try reputationKeeper.updateScores(aggEval.polledOracles[slot].oracle, resp.jobId, int8(4), int8(4)) {
                            // success
                        } catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for clustered selected response");
                        }
                        uint256 bonusFee = aggEval.pollFees[slot];
                        _payBonus(aggEval.requester, aggEval.userFunded, bonusFee, resp.operator);
                        return (true, 1);
                    } else {
                        try reputationKeeper.updateScores(aggEval.polledOracles[slot].oracle, resp.jobId, int8(-4), int8(0)) {
                            // success
                        } catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for non-clustered selected response");
                        }
                        return (true, 0);
                    }
                }
            } else {
                try reputationKeeper.updateScores(aggEval.polledOracles[slot].oracle, resp.jobId, int8(0), int8(-4)) {
                    // success
                } catch {
                    emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for responded but not selected");
                }
                return (true, 0);
            }
        } else {
            try reputationKeeper.updateScores(id.oracle, id.jobId, int8(0), int8(-4)) {
                // success
            } catch {
                emit OracleScoreUpdateSkipped(id.oracle, id.jobId, "updateScores failed for no response");
            }
            return (true, 0);
        }
    }

    // ------------------------------------------------------------------------
    // New helper: _payBonus
    // Separates the bonus payment logic to reduce stack depth.
    // ------------------------------------------------------------------------
    function _payBonus(
        address requester,
        bool userFunded,
        uint256 bonusFee,
        address operator
    ) internal {
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        if (userFunded) {
            require(
                link.transferFrom(requester, address(this), bonusFee),
                "Bonus fee transferFrom failed"
            );
        }
        uint256 balanceBefore = link.balanceOf(address(this));
        bool transferSuccess = link.transfer(operator, bonusFee);
        uint256 balanceAfter = link.balanceOf(address(this));
        emit DebugBonusTransfer(operator, bonusFee, balanceBefore, balanceAfter, transferSuccess);
        require(transferSuccess, "Bonus fee transfer failed");
        emit BonusPayment(operator, bonusFee);
    }

    // ------------------------------------------------------------------------
    // Helper: Find a response for a given poll slot.
    // Returns (found, index). If not found, index is 0.
    // ------------------------------------------------------------------------
    function _getResponseForSlot(Response[] memory responses, uint256 slot) internal pure returns (bool, uint256) {
        for (uint256 i = 0; i < responses.length; i++) {
            if (responses[i].pollIndex == slot) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    // ------------------------------------------------------------------------
    // Helper: Find the first response index for a given poll slot.
    // Returns the index if found; otherwise, returns responses.length.
    // ------------------------------------------------------------------------
    function _findResponseIndexForSlot(Response[] storage responses, uint256 slot) internal view returns (uint256) {
        for (uint256 i = 0; i < responses.length; i++) {
            if (responses[i].pollIndex == slot) {
                return i;
            }
        }
        return responses.length;
    }

    // ------------------------------------------------------------------------
    // Helper: Given an array and a value, find (found, index) of the first occurrence.
    // ------------------------------------------------------------------------
    function _findIndexInArray(uint256[] memory arr, uint256 value) internal pure returns (bool, uint256) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == value) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    // ------------------------------------------------------------------------
    // Clustering logic: returns an array indicating which selected responses are in the best cluster.
    // ------------------------------------------------------------------------
    function _findBestClusterFromResponses(Response[] memory responses, uint256[] memory selectedResponseIndices)
        internal
        pure
        returns (uint256[] memory)
    {
        uint256 count = selectedResponseIndices.length;
        require(count >= 2, "Need at least 2 responses");
        uint256[] memory bestCluster = new uint256[](count);
        uint256 bestDistance = type(uint256).max;
        for (uint256 i = 0; i < count - 1; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                uint256 respIndexA = selectedResponseIndices[i];
                uint256 respIndexB = selectedResponseIndices[j];
                if (respIndexA >= responses.length || respIndexB >= responses.length) continue;
                uint256 dist = _calculateDistance(
                    responses[respIndexA].likelihoods,
                    responses[respIndexB].likelihoods
                );
                if (dist < bestDistance) {
                    bestDistance = dist;
                    for (uint256 x = 0; x < count; x++) {
                        bestCluster[x] = (x == i || x == j) ? 1 : 0;
                    }
                }
            }
        }
        return bestCluster;
    }

    function _calculateDistance(uint256[] memory a, uint256[] memory b) internal pure returns (uint256) {
        require(a.length == b.length, "Array length mismatch");
        uint256 sum = 0;
        for (uint256 i = 0; i < a.length; i++) {
            uint256 diff = (a[i] > b[i]) ? a[i] - b[i] : b[i] - a[i];
            sum += diff * diff;
        }
        return sum;
    }

    // ------------------------------------------------------------------------
    // Evaluation getters (for front-end use)
    // ------------------------------------------------------------------------
    function getEvaluation(bytes32 requestId)
        public
        view
        returns (
            uint256[] memory likelihoods,
            string memory justificationCID,
            bool exists
        )
    {
        AggregatedEvaluation storage aggEval = aggregatedEvaluations[requestId];
        return (aggEval.aggregatedLikelihoods, aggEval.combinedJustificationCIDs, aggEval.responseCount > 0);
    }

    function evaluations(bytes32 requestId) public view returns (uint256[] memory, string memory) {
        (uint256[] memory l, string memory j, ) = getEvaluation(requestId);
        return (l, j);
    }

    function getContractConfig()
        public
        view
        returns (
            address oracleAddr,
            address linkAddr,
            bytes32 jobId,
            uint256 fee
        )
    {
        // temporary zero placeholders for compatibility
        return (
            address(0), //placeholder
            _chainlinkTokenAddress(),
            bytes32(0), //placeholder
            0 //placeholder
        );
    }

    // ------------------------------------------------------------------------
    // Helper: Concatenate CIDs with commas.
    // ------------------------------------------------------------------------
    function concatenateCids(string[] memory cids) internal pure returns (string memory) {
        bytes memory out;
        for (uint256 i = 0; i < cids.length; i++) {
            out = abi.encodePacked(out, cids[i]);
            if (i < cids.length - 1) {
                out = abi.encodePacked(out, ",");
            }
        }
        return string(out);
    }

    // ------------------------------------------------------------------------
    // Utility: Withdraw LINK if needed.
    // ------------------------------------------------------------------------
    function withdrawLink(address payable _to, uint256 _amount) external onlyOwner {
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        require(link.transfer(_to, _amount), "LINK transfer failed");
    }
}

