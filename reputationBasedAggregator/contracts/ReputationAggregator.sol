// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ReputationKeeper.sol";

/**
 * @title ReputationAggregator commit-reveal edition (ASCII only)
 * @notice Two phase polling system for secure oracle aggregation:
 *         K = commitOraclesToPoll  - oracles polled in commit phase (Mode 1)
 *         M = oraclesToPoll        - first M commits promoted to reveal (Mode 2)
 *         N = requiredResponses    - first N reveals aggregated
 *         P = clusterSize          - size of best match cluster for bonus
 *
 *         By default, K,M,N,P = 5,4,3,2
 *
 *         Flow:
 *         1. requestAIEvaluationWithApproval sends Mode 1 requests to K oracles.
 *         2. When first M commitments arrive, the contract sends Mode 2
 *            requests (reveal) back to those M oracles.
 *         3. After N valid reveals, responses are clustered and scored.
 *        
 *         Payment:
 *         1. All oracles get 1x fee up front.
 *         2. There is a bonus multiplier B, nominally 3.
 *         3. Clustered oracles get an additional Bx fee at finish.
 */
contract ReputationAggregator is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    // ----------------------------------------------------------------------
    //                          CONFIGURATION STORAGE
    // ----------------------------------------------------------------------
    uint256 public commitOraclesToPoll;     // K – commiti-phase polls
    uint256 public oraclesToPoll;           // M – reveals requested
    uint256 public requiredResponses;       // N
    uint256 public clusterSize;             // P
    uint256 public bonusMultiplier = 3;     // B
    uint256 public responseTimeoutSeconds = 300; // default 5 min
    uint256 public alpha = 500;             // reputation weight

    // rolling entropy
    bytes16 public rollingEntropy;          // init to 0x0 and build over time
    uint256 public lastEntropyBlock;        // block.number the keeper saw last

    // owner-settable LINK fee limits
    uint256 public maxOracleFee;
    uint256 public baseFeePct = 1;          // 1% of maxOracleFee
    uint256 public maxFeeBasedScalingFactor = 10;

    // limits for user input
    uint256 public constant MAX_CID_COUNT = 10;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    // running call counter
    uint256 private requestCounter;

    ReputationKeeper public reputationKeeper;

    // ----------------------------------------------------------------------
    //                               EVENTS
    // ----------------------------------------------------------------------
    event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
    event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
    event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash);
    event CommitPhaseComplete(bytes32 indexed aggRequestId);
    event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash);
    event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, address operator);
    event BonusPayment(address indexed operator, uint256 bonusFee);
    event EvaluationTimedOut(bytes32 indexed aggRequestId);
    event EvaluationFailed(bytes32 indexed aggRequestId, string phase);
    event OracleScoreUpdateSkipped(address oracle, bytes32 jobId, string reason);
    event HashMismatch(bytes32 requestId, bytes16 computedHash, bytes16 storedHash);
    event ReputationKeeperChanged(address indexed oldKeeper, address indexed newKeeper);

    // ----------------------------------------------------------------------
    //                               STRUCTS
    // ----------------------------------------------------------------------
    struct Response {
        uint256[] likelihoods;
        string justificationCID;
        bytes32 requestId;
        bool selected;
        uint256 timestamp;
        address operator;
        uint256 pollIndex;
        bytes32 jobId;
    }

    struct AggregatedEvaluation {
        // phase bookkeeping
        bool commitPhaseComplete;           // true → we are in reveal phase
        uint256 commitExpected;             // K
        uint256 commitReceived;             // # of commits so far

        // commit hashes per poll slot
        mapping(uint256 => bytes16) commitHashPerSlot;  // 0‑based poll index ⇒ 128‑bit hash

        // reveal bookkeeping
        Response[] responses;               // only *reveal* responses are stored here
        uint256 responseCount;              // reveal response counter
        uint256 requiredResponses;          // N (reveals to aggregate)
        uint256 clusterSize;                // P
        uint256[] aggregatedLikelihoods;

        // oracle selection
        ReputationKeeper.OracleIdentity[] polledOracles;  // length == K
        uint256[] pollFees;                               // same length

        // accounting
        mapping(bytes32 => bool) requestIds;    // valid requestIds (commit & reveal)
        bool userFunded;
        address requester;
        uint256 startTimestamp;

        // output
        string combinedJustificationCIDs;
        bool isComplete;
        bool failed;
    }

    // ----------------------------------------------------------------------
    //                         MAPPINGS
    // ----------------------------------------------------------------------
    mapping(bytes32 => AggregatedEvaluation) public aggregatedEvaluations; // agg ID => evaluation
    mapping(bytes32 => bytes32) public requestIdToAggregatorId;            // nodeReq => aggReq
    mapping(bytes32 => uint256) public requestIdToPollIndex;               // nodeReq => poll slot

    // ----------------------------------------------------------------------
    //                              CONSTRUCTOR
    // ----------------------------------------------------------------------
    constructor(address _link, address _reputationKeeper) Ownable(msg.sender) {
        _setChainlinkToken(_link);
        reputationKeeper = ReputationKeeper(_reputationKeeper);

        // rolling entropy
        rollingEntropy = 0x0;
        lastEntropyBlock = block.number;

        // default parameters keep the old behaviour: K=M=4, N=3, P=2
        commitOraclesToPoll = 5;        // K (default – one extra oracle)
        oraclesToPoll = 4;              // M
        requiredResponses = 3;          // N
        clusterSize = 2;                // P

        responseTimeoutSeconds = 5 minutes;
        maxOracleFee = 0.1 * 10 ** 18;  // 0.1 LINK
    }

    // ----------------------------------------------------------------------
    //                            CONFIGURATION API
    // ----------------------------------------------------------------------
    // setPhaseCounts is DEPRECATED - Use setConfig instead
    /**
     * @dev Set all phase counts at once (K, M, N, P)
     * @param _k Number of oracles to poll in commit phase
     * @param _m Number of reveals requested (first M commits)
     * @param _n Number of reveals required for aggregation
     * @param _p Cluster size for bonus payments
     */
    function setPhaseCounts(uint256 _k, uint256 _m, uint256 _n, uint256 _p) external onlyOwner {
        require(_k >= _m, "K must be >= M");
        require(_m >= _n, "M must be >= N");
        require(_n >= _p, "N must be >= P");
        require(_p >= 1, "P must be >= 1");
        
        commitOraclesToPoll = _k;
        oraclesToPoll = _m;
        requiredResponses = _n;
        clusterSize = _p;
    }

    function setCommitOraclesToPoll(uint256 _k) external onlyOwner {
        require(_k >= oraclesToPoll, "K must be >= M");
        commitOraclesToPoll = _k;
    }

    function setResponseTimeout(uint256 _seconds) external onlyOwner {
        responseTimeoutSeconds = _seconds;
    }

    function setAlpha(uint256 _alpha) external onlyOwner {
        require(_alpha <= 1000, "Alpha 0-1000");
        alpha = _alpha;
    }

    function setMaxOracleFee(uint256 _newMax) external onlyOwner {
        maxOracleFee = _newMax;
    }

    /**
     * @dev Estimate the maximum LINK needed for both commit + reveal + bonus.
     *      total = fee × (K + M + P)
     */
    function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
        uint256 eff = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
        return eff * (commitOraclesToPoll + bonusMultiplier * clusterSize);
    }

    // ----------------------------------------------------------------------
    //                      USER FUNDED REQUEST ENTRYPOINT
    // ----------------------------------------------------------------------
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) public nonReentrant returns (bytes32) {
        require(address(reputationKeeper) != address(0), "ReputationKeeper not set");
        require(cids.length > 0, "Empty CID list");
        require(cids.length <= MAX_CID_COUNT, "Too many CIDs");
        for (uint256 i = 0; i < cids.length; i++) {
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID too long");
        }
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "Addendum too long");

        // build CID payload
        bytes memory cat;
        for (uint256 i = 0; i < cids.length; i++) {
            cat = abi.encodePacked(cat, cids[i], i < cids.length - 1 ? "," : "");
        }
        string memory cidConcat = string(cat);
        if (bytes(addendumText).length > 0) {
            cidConcat = string(abi.encodePacked(cidConcat, ":", addendumText));
        }
        cidConcat = string(abi.encodePacked("1:", cidConcat));  // Mode 1 – commit

        // generate aggregator request id
        requestCounter++;
        bytes32 aggId = keccak256(abi.encodePacked(block.timestamp, msg.sender, cidConcat, requestCounter));
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        agg.commitExpected = commitOraclesToPoll;
        agg.requiredResponses = requiredResponses;
        agg.clusterSize = clusterSize;
        agg.userFunded = true;
        agg.requester = msg.sender;
        agg.startTimestamp = block.timestamp;
        agg.commitPhaseComplete = false;

        // select oracles (K)
        ReputationKeeper.OracleIdentity[] memory sel = reputationKeeper.selectOracles(
            commitOraclesToPoll,
            _alpha,
            _maxOracleFee,
            _estimatedBaseCost,
            _maxFeeBasedScalingFactor,
            _requestedClass
        );
        reputationKeeper.recordUsedOracles(sel);

        // dispatch Mode 1 requests
        for (uint256 i = 0; i < sel.length; i++) {
            agg.polledOracles.push(sel[i]);

            (bool active, , , , bytes32 jobId, uint256 fee, , , ) = reputationKeeper.getOracleInfo(sel[i].oracle, sel[i].jobId);
            require(active, "Inactive oracle");

            require(LinkTokenInterface(_chainlinkTokenAddress()).transferFrom(msg.sender, address(this), fee), "fee xferFrom failed");

            bytes32 opReq = _sendSingleOracleRequest(sel[i].oracle, jobId, fee, cidConcat);
            requestIdToAggregatorId[opReq] = aggId;
            requestIdToPollIndex[opReq] = i;  // slot == i
            agg.requestIds[opReq] = true;
            agg.pollFees.push(fee);
        }

        emit RequestAIEvaluation(aggId, cids);
        return aggId;
    }

    // ----------------------------------------------------------------------
    //                         TIMEOUT HANDLING
    // ----------------------------------------------------------------------
    function finalizeEvaluationTimeout(bytes32 aggId) external nonReentrant {
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        require(!agg.isComplete, "Aggregation already completed");
        require(
            block.timestamp >= agg.startTimestamp + responseTimeoutSeconds,
            "Evaluation not yet timed out"
        );

        /* ----------------- commit phase timed out ----------------- */
        if (!agg.commitPhaseComplete) {
            if (agg.commitReceived >= oraclesToPoll) {
                // enough commits → try to progress to reveal
                agg.commitPhaseComplete = true;
                emit CommitPhaseComplete(aggId);
                _dispatchRevealRequests(aggId, agg);
                return;   // give them another timeout window
            }
            // < M commits → fail job
            _applyTimeoutPenalties(agg, true);  // penalise non-committing oracles only
            agg.failed = true;
            agg.isComplete = true;
            emit EvaluationFailed(aggId, "commit");
            return;
        }

        /* ----------------- reveal phase timed out ----------------- */
        if (agg.responseCount < agg.requiredResponses) {
            _applyTimeoutPenalties(agg, false); // penalise non-revealing oracles
            agg.failed = true;
            agg.isComplete = true;
            emit EvaluationFailed(aggId, "reveal");
            return;
        }

        // enough responses after all → finish normally
        _finalizeAggregation(aggId);
    }

    // ----------------------------------------------------------------------
    //                                FULFILL (NODE CALLBACK)
    // ----------------------------------------------------------------------
    /**
     * @dev Called by Chainlink nodes in both commit and reveal phases.
     *      COMMIT PHASE: response[0] contains the pre-computed hash of (actualLikelihoods, salt)
     *      REVEAL PHASE: response contains actual likelihood scores, cid contains "cleanCid:salt"
     */
function fulfill(
    bytes32 requestId,
    uint256[] memory response,
    string memory cid
) public recordChainlinkFulfillment(requestId) nonReentrant {

    bytes32 aggId = requestIdToAggregatorId[requestId];
    require(aggId != bytes32(0), "Unknown reqId");

    AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
    require(!agg.isComplete, "Aggregation done");
    require(agg.requestIds[requestId], "Invalid reqId");

    uint256 slot = requestIdToPollIndex[requestId];
    ReputationKeeper.OracleIdentity memory id = agg.polledOracles[slot];

    // ---------- decide phase from *payload shape* ----------
    bool looksLikeCommit = (response.length == 1) && (bytes(cid).length == 0);
    bool looksLikeReveal = (response.length >= 2) && (bytes(cid).length > 0);
    require(looksLikeCommit || looksLikeReveal, "callback payload malformed");

    /* ────────────────────────────────────────────────────────
     *                     COMMIT  (Mode-1)
     * ──────────────────────────────────────────────────────── */
    if (looksLikeCommit) {

        bytes16 hash128 = bytes16(bytes32(uint256(response[0]) << 128));

        // (a) commit arrived after we already switched to reveal → just log it
        if (agg.commitPhaseComplete) {
            emit CommitReceived(aggId, slot, msg.sender, hash128);
            return;
        }
        // (b) duplicate commit for this slot → ignore
        if (agg.commitHashPerSlot[slot] != bytes16(0)) {
            return;
        }

        // normal commit path
        agg.commitHashPerSlot[slot] = hash128;
        agg.commitReceived += 1;
        emit CommitReceived(aggId, slot, msg.sender, hash128);

        // when we have M commits → start reveal phase
        if (agg.commitReceived == oraclesToPoll) {
            agg.commitPhaseComplete = true;
            emit CommitPhaseComplete(aggId);
            _dispatchRevealRequests(aggId, agg);
        }
        return;                                     // commit handled
    }

    /* ────────────────────────────────────────────────────────
     *                     REVEAL  (Mode-2)
     * ──────────────────────────────────────────────────────── */
    require(agg.commitPhaseComplete,
            "reveal arrived before commit phase complete");

// ─── NEW DUPLICATE-REVEAL GUARD ──────────────────
(bool seenAlready, ) = _getResponseForSlot(agg.responses, slot);
if (seenAlready) {
    return;                                    // ignore retry
}

    // first reveal fixes array length; every later reveal must match
    uint256[] storage totals = _ensureAggArrayExists(agg, response.length);
    require(response.length == totals.length, "Wrong number of scores");

    // Split "cleanCid:20hexSalt" → (cid, saltUint)
    (string memory cleanCid, uint256 saltUint) = _splitCidAndSalt(cid);

    // verify commit-reveal hash
    bytes16 recomputed = bytes16(sha256(abi.encode(response, saltUint)));
    if (recomputed != agg.commitHashPerSlot[slot]) {
        emit HashMismatch(requestId, recomputed, agg.commitHashPerSlot[slot]);
        revert("Hash mismatch: reveal hash doesn't match commit hash");
    }

    // entropy, bookkeeping, and storage insert
    _updateEntropy(bytes10(uint80(saltUint)));
    bool selected = (agg.responses.length < agg.requiredResponses);

    Response memory resp = Response({
        likelihoods:      response,
        justificationCID: cleanCid,
        requestId:        requestId,
        selected:         selected,
        timestamp:        block.timestamp,
        operator:         msg.sender,
        pollIndex:        slot,
        jobId:            id.jobId
    });

    agg.responses.push(resp);
    agg.responseCount += 1;
    emit NewOracleResponseRecorded(requestId, slot, msg.sender);

    if (agg.responseCount >= agg.requiredResponses) {
        _finalizeAggregation(aggId);
    }
}



    // ----------------------------------------------------------------------
    //                      INTERNAL: DISPATCH REVEAL REQUESTS
    // ----------------------------------------------------------------------
    function _dispatchRevealRequests(bytes32 aggId, AggregatedEvaluation storage agg) internal {
        for (uint256 slot = 0; slot < agg.polledOracles.length; slot++) {
            bytes16 hash128 = agg.commitHashPerSlot[slot];
            if (hash128 == bytes16(0)) {
                // this oracle did not commit fast enough
                continue;
            }
            
            ReputationKeeper.OracleIdentity memory oid = agg.polledOracles[slot];
            string memory cid2 = string(abi.encodePacked("2:", _bytes16ToHexStringLower(hash128)));
            bytes32 opReq = _sendSingleOracleRequest(oid.oracle, oid.jobId, 0, cid2);
            requestIdToAggregatorId[opReq] = aggId;
            requestIdToPollIndex[opReq] = slot;
            agg.requestIds[opReq] = true;

            emit RevealRequestDispatched(aggId, slot, hash128);
        }
    }

    // ----------------------------------------------------------------------
    //                       HELPER: BUILD & SEND REQUEST
    // ----------------------------------------------------------------------
    function _sendSingleOracleRequest(
        address operator,
        bytes32 jobId,
        uint256 fee,
        string memory cidPayload
    ) internal returns (bytes32) {
        Chainlink.Request memory req = _buildOperatorRequest(jobId, this.fulfill.selector);
        req._add("cid", cidPayload);
        return _sendOperatorRequestTo(operator, req, fee);
    }

    // ----------------------------------------------------------------------
    //                            AGGREGATION LOGIC
    // ----------------------------------------------------------------------
    function _finalizeAggregation(bytes32 aggId) internal {
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        require(!agg.isComplete, "already-finalised");

        uint256 selectedCount = 0;
        for (uint256 i = 0; i < agg.responses.length; i++) {
            if (agg.responses[i].selected) selectedCount++;
        }
        
        uint256[] memory selIdx = new uint256[](selectedCount);
        uint256 k = 0;
        for (uint256 i = 0; i < agg.responses.length; i++) {
            if (agg.responses[i].selected) selIdx[k++] = i;
        }
        
        uint256[] memory cluster = (selectedCount >= 2)
            ? _findBestClusterFromResponses(agg.responses, selIdx)
            : new uint256[](selectedCount);

        if (agg.responses.length > 0) {
            agg.aggregatedLikelihoods = new uint256[](agg.responses[0].likelihoods.length);
        }
        
        uint256 clusterCount = 0;
        uint256 m = agg.polledOracles.length;
        for (uint256 slot = 0; slot < m; slot++) {
            (bool processed, uint256 addCluster) = _processPollSlot(agg, slot, selIdx, cluster);
            if (processed && addCluster > 0) {
                uint256 respIndex = _findResponseIndexForSlot(agg.responses, slot);
                if (respIndex < agg.responses.length) {
                    uint256[] memory curr = agg.responses[respIndex].likelihoods;
                    for (uint256 j = 0; j < curr.length; j++) {
                        agg.aggregatedLikelihoods[j] += curr[j];
                    }
                    clusterCount++;
                }
            }
        }
        
        if (clusterCount > 0) {
            for (uint256 j = 0; j < agg.aggregatedLikelihoods.length; j++) {
                agg.aggregatedLikelihoods[j] /= clusterCount;
            }
        }

        // collect clustered justification CIDs
        string memory combined = "";
        bool first = true;
        for (uint256 i = 0; i < selIdx.length; i++) {
            if (cluster[i] == 1) {
                uint256 r = selIdx[i];
                string memory cidStr = agg.responses[r].justificationCID;
                combined = first ? cidStr : string(abi.encodePacked(combined, ",", cidStr));
                first = false;
            }
        }
        
        agg.combinedJustificationCIDs = combined;
        agg.isComplete = true;
        emit FulfillAIEvaluation(aggId, agg.aggregatedLikelihoods, combined);
    }

    // ----------------------------------------------------------------------
    //                 HELPER FUNCTIONS FOR AGGREGATION
    // ----------------------------------------------------------------------
    function _processPollSlot(
        AggregatedEvaluation storage agg,
        uint256 slot,
        uint256[] memory selIdx,
        uint256[] memory cluster
    ) internal returns (bool, uint256) {
        ReputationKeeper.OracleIdentity memory id = agg.polledOracles[slot];
        (bool active, , , , , , , , ) = reputationKeeper.getOracleInfo(id.oracle, id.jobId);
        if (!active) {
            emit OracleScoreUpdateSkipped(id.oracle, id.jobId, "Inactive at finalization");
            return (false, 0);
        }
        
        (bool responded, uint256 respIndex) = _getResponseForSlot(agg.responses, slot);
        if (responded) {
            Response memory resp = agg.responses[respIndex];
            if (resp.selected) {
                (bool found, uint256 sIdx) = _findIndexInArray(selIdx, respIndex);
                if (found) {
                    if (cluster[sIdx] == 1) {
                        try reputationKeeper.updateScores(id.oracle, resp.jobId, int8(4), int8(4)) {} catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for clustered selected response");
                        }
                        uint256 bonus = agg.pollFees[slot] * bonusMultiplier;
                        _payBonus(agg.requester, agg.userFunded, bonus, resp.operator);
                        return (true, 1);
                    } else {
                        try reputationKeeper.updateScores(id.oracle, resp.jobId, int8(-4), int8(0)) {} catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for non-clustered selected response");
                        }
                        return (true, 0);
                    }
                }
            } else {
                try reputationKeeper.updateScores(id.oracle, resp.jobId, int8(0), int8(-2)) {} catch {
                    emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for responded but not selected");
                }
                return (true, 0);
            }
        } else {
            try reputationKeeper.updateScores(id.oracle, id.jobId, int8(0), int8(-2)) {} catch {
                emit OracleScoreUpdateSkipped(id.oracle, id.jobId, "updateScores failed for no response");
            }
            return (true, 0);
        }
        return (false, 0);
    }

    // ----------------------------------------------------------------------
    //                       HELPER: CONVERSIONS
    // ----------------------------------------------------------------------
    function _bytes16ToHexStringLower(bytes16 data) internal pure returns (string memory) {
        bytes memory hexChars = new bytes(32);
        for (uint256 i = 0; i < 16; i++) {
            uint8 b = uint8(data[i]);
            hexChars[2 * i] = _lowerHexChar(b >> 4);
            hexChars[2 * i + 1] = _lowerHexChar(b & 0x0f);
        }
        return string(hexChars);
    }

/// @dev Make sure the per-round running-total array exists and return a
///      STORAGE pointer to it.  Subsequent writers all share the same slot.
function _ensureAggArrayExists(
    AggregatedEvaluation storage agg,
    uint256 len
) internal returns (uint256[] storage totals) {
    if (agg.aggregatedLikelihoods.length == 0) {
        // Allocate once. If two transactions arrive in the same block,
        // whichever executes first creates the array; the second one just
        // re-uses it – no data loss.
        agg.aggregatedLikelihoods = new uint256[](len);
    }
    return agg.aggregatedLikelihoods;  // this is a STORAGE alias
}

    function _lowerHexChar(uint8 nib) internal pure returns (bytes1) {
        return bytes1(uint8(nib < 10 ? 48 + nib : 87 + nib)); // 0-9 → '0'-'9', 10-15 → 'a'-'f'
    }

    // ----------------------------------------------------------------------
    //                          HELPER FUNCTIONS
    // ----------------------------------------------------------------------

    function getCurrentRequestCounter() external view returns (uint256) {
        return requestCounter;
    }

    /**
     * @dev Pay bonus to an operator
     */
    function _payBonus(
        address requester,
        bool userFunded,
        uint256 amount,
        address operator
    ) internal {
        if (amount > 0) {
            LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
            
            if (userFunded) {
                // If user funded, transfer from requester
                require(link.transferFrom(requester, operator, amount), "bonus xferFrom failed");
            } else {
                // Otherwise transfer from contract
                bool success = link.transfer(operator, amount);
                require(success, "bonus transfer failed");
            }
            
            emit BonusPayment(operator, amount);
        }
    }

    /**
     * @dev Get the response for a given poll slot
     */
    function _getResponseForSlot(Response[] memory responses, uint256 slot) 
        internal pure returns (bool, uint256) 
    {
        for (uint256 i = 0; i < responses.length; i++) {
            if (responses[i].pollIndex == slot) {
                return (true, i);
            }
        }
        return (false, 0);
    }
    
    /**
     * @dev Find the index of a response for a given poll slot
     */
    function _findResponseIndexForSlot(Response[] storage responses, uint256 slot) 
        internal view returns (uint256) 
    {
        for (uint256 i = 0; i < responses.length; i++) {
            if (responses[i].pollIndex == slot) {
                return i;
            }
        }
        return responses.length; // Return out of bounds if not found
    }
    
    /**
     * @dev Find the index of a value in an array
     */
    function _findIndexInArray(uint256[] memory arr, uint256 value) 
        internal pure returns (bool, uint256) 
    {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == value) {
                return (true, i);
            }
        }
        return (false, 0);
    }
    
    /**
     * @dev Find the best cluster from responses
     */
    function _findBestClusterFromResponses(Response[] memory responses, uint256[] memory selectedResponseIndices)
        internal pure returns (uint256[] memory)
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

    /**
     * @dev Calculate the Euclidean distance between two arrays
     */
    function _calculateDistance(uint256[] memory a, uint256[] memory b) 
        internal pure returns (uint256) 
    {
        require(a.length == b.length, "Array length mismatch");
        uint256 sum = 0;
        for (uint256 i = 0; i < a.length; i++) {
            uint256 diff = (a[i] > b[i]) ? a[i] - b[i] : b[i] - a[i];
            sum += diff * diff;
        }
        return sum;
    }

    /**
     * @dev Split "cleanCid:20hexSalt" into (cid, saltUint)
     */
    function _splitCidAndSalt(string memory packed)
        private pure returns (string memory cidOnly, uint256 salt)
    {
        bytes memory b = bytes(packed);
        require(b.length > 21, "cid+salt too short");      // ':' + 20 hex chars

        // find the last ':' (allows ':' inside CID multibase)
        uint256 i = b.length;
        while (i > 0 && b[i-1] != ":") { 
            unchecked { --i; } 
        }
        require(i > 0 && (b.length - i) == 20, "need 20 hex after ':'");

        // copy CID part
        bytes memory cidBytes = new bytes(i - 1);
        for (uint256 j = 0; j < cidBytes.length; ++j) {
            cidBytes[j] = b[j];
        }

        // parse 20 hex chars → uint256 (fits in lower 80 bits)
        unchecked {
            for (uint256 j = i; j < b.length; ++j) {
                uint8 c = uint8(b[j]);
                uint8 v = (c >= 97) ? c - 87     // 'a'-'f'
                       : (c >= 65) ? c - 55     // 'A'-'F'
                       : (c >= 48) ? c - 48     // '0'-'9'
                       : 255;
                require(v < 16, "non-hex");
                salt = (salt << 4) | v;
            }
        }
        return (string(cidBytes), salt);
    }

    // Mix salt into 128-bit entropy    
    function _updateEntropy(bytes10 salt10) internal {
        // Mix previous entropy, new salt, and parent block-hash (prevents
        // extension-attack on keccak, adds 50% unknown bits).
        rollingEntropy = bytes16(
            keccak256(
                abi.encodePacked(
                    rollingEntropy,
                    salt10,
                    blockhash(block.number - 1)
                )
            )
        );

        // Push to keeper once per block to save gas.
        if (block.number > lastEntropyBlock) {
            reputationKeeper.pushEntropy(rollingEntropy);
            lastEntropyBlock = block.number;
        }
    }

    // ----------------------------------------------------------------------
    //             TIMEOUT PENALTY HELPERS
    // ----------------------------------------------------------------------
    function _applyTimeoutPenalties(
        AggregatedEvaluation storage agg,
        bool commitPhase            // true  = commit timeout
    ) private {
        uint256 m = agg.polledOracles.length;
        for (uint256 slot = 0; slot < m; slot++) {
            bool shouldPenalise;

            if (commitPhase) {
                // commitHashPerSlot == 0  ⇒  oracle never committed
                shouldPenalise = (agg.commitHashPerSlot[slot] == bytes16(0));
            } else {
                // reveal phase ⇒ penalise only if no reveal received
                (bool responded, ) = _getResponseForSlot(agg.responses, slot);
                shouldPenalise = !responded;
            }

            if (shouldPenalise) {
                ReputationKeeper.OracleIdentity memory id = agg.polledOracles[slot];
                try reputationKeeper.updateScores(id.oracle, id.jobId, int8(0), int8(-2)) { }
                catch { emit OracleScoreUpdateSkipped(id.oracle, id.jobId, "timeout penalty"); }
            }
        }
    }


    // ----------------------------------------------------------------------
    //             EVALUATION GETTERS & WITHDRAW
    // ----------------------------------------------------------------------

    function getEvaluation(bytes32 reqId) public view returns (uint256[] memory, string memory, bool) {
        AggregatedEvaluation storage agg = aggregatedEvaluations[reqId];
        bool hasValidData = agg.isComplete && agg.aggregatedLikelihoods.length > 0;
        return (agg.aggregatedLikelihoods, agg.combinedJustificationCIDs, hasValidData);
    }

    function evaluations(bytes32 reqId) external view returns (uint256[] memory, string memory) {
        (uint256[] memory l, string memory j, ) = getEvaluation(reqId);
        return (l, j);
    }

    function getContractConfig()
        public view returns (
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

    function withdrawLink(address payable _to, uint256 _amount) external onlyOwner {
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        require(link.transfer(_to, _amount), "LINK transfer failed");
    }

    function setReputationKeeper(address newKeeper) external onlyOwner {
        require(newKeeper != address(0), "ReputationKeeper: zero address");
        address old = address(reputationKeeper);
        reputationKeeper = ReputationKeeper(newKeeper);
        emit ReputationKeeperChanged(old, newKeeper);
    }

    function setConfig(
        uint256 _k,
        uint256 _m,
        uint256 _n,
        uint256 _p,
        uint256 _timeoutSecs
    ) external onlyOwner {
        // same safety checks as individual setters
        require(_k >= _m, "K >= M");
        require(_m >= _n, "M >= N");
        require(_n >= _p, "N >= P");
        require(_p >= 1,  "P >= 1");

        commitOraclesToPoll   = _k;
        oraclesToPoll         = _m;
        requiredResponses     = _n;
        clusterSize           = _p;
        responseTimeoutSeconds = _timeoutSecs;
    }

    function setBonusMultiplier(uint256 _m) external onlyOwner {
        require(_m <= 20, "bonus 0-20x");
        bonusMultiplier = _m;
    }

    function isFailed(bytes32 aggId) external view returns (bool) {
        return aggregatedEvaluations[aggId].failed;
    }
}
