// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ReputationKeeper.sol";

/**
 * @title ReputationAggregator commit-reveal edition (ASCII only)
 * @author Verdikta Team
 * @notice Two phase polling system for secure oracle aggregation with commit-reveal mechanism
 * @dev Implements a sophisticated oracle aggregation system with the following phases:
 *      - K = commitOraclesToPoll  - oracles polled in commit phase (Mode 1)
 *      - M = oraclesToPoll        - first M commits promoted to reveal (Mode 2)
 *      - N = requiredResponses    - first N reveals aggregated
 *      - P = clusterSize          - size of best match cluster for bonus
 *
 *      By default, K,M,N,P = 6,4,3,2
 *
 *      Flow:
 *      1. requestAIEvaluationWithApproval sends Mode 1 requests to K oracles.
 *      2. When first M commitments arrive, the contract sends Mode 2
 *         requests (reveal) back to those M oracles.
 *      3. After N valid reveals, responses are clustered and scored.
 *        
 *      Payment:
 *      1. All oracles get 1x fee up front.
 *      2. There is a bonus multiplier B, nominally 3.
 *      3. Clustered oracles get this additional Bx fee at finish.
 */
contract ReputationAggregator is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    // ----------------------------------------------------------------------
    //                          CONFIGURATION
    // ----------------------------------------------------------------------
    uint256 public commitOraclesToPoll;      // K – commit-phase polls
    uint256 public oraclesToPoll;            // M – reveals requested
    uint256 public requiredResponses;        // N
    uint256 public clusterSize;              // P
    uint256 public bonusMultiplier = 3;      // B
    uint256 public responseTimeoutSeconds = 300; // default 5 min
    uint256 public maxLikelihoodLength = 20; // Max number of scores in the array

    // rolling entropy
    bytes16 public rollingEntropy;          // init to 0x0 and build over time
    uint256 public lastEntropyBlock;        // block.number the keeper saw last

    // scoring
    int8 public clusteredTimelinessScore;   // timeliness score change when clustered
    int8 public clusteredQualityScore;      // quality score change when clustered
    int8 public selectedTimelinessScore;    // timeliness score change when selected but not clustered
    int8 public selectedQualityScore;       // quality score change when selected but not clustered
    int8 public revealedTimelinessScore;    // timeliness score change when revealed but not selected
    int8 public revealedQualityScore;       // quality score change when revealed but not selected
    int8 public committedTimelinessScore;   // timeliness score change when committed but not revealed
    int8 public committedQualityScore;      // quality score change when committed but not revealed

    // owner-settable LINK fee limits
    uint256 public maxOracleFee;

    // limits for user input
    uint256 public constant MAX_CID_COUNT = 10;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    // limits for arbiter behavior
    uint256 private constant MAX_ARBITER_RETURN_SCORE = 1e34;

    // running call counter
    uint256 private requestCounter;

    ReputationKeeper public reputationKeeper;

    // ----------------------------------------------------------------------
    //                               EVENTS
    // ----------------------------------------------------------------------
    
    /// @notice Emitted when a new AI evaluation request is created
    /// @param aggRequestId Unique aggregator request identifier
    /// @param cids Array of IPFS CIDs containing evidence to evaluate
    event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
    
    /// @notice Emitted when an AI evaluation is completed successfully
    /// @param aggRequestId The aggregator request identifier
    /// @param aggregated Final aggregated likelihood scores
    /// @param justifications Combined IPFS CIDs of justifications from clustered oracles
    event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
    
    /// @notice Emitted when an oracle submits a commit hash
    /// @param aggRequestId The aggregator request identifier
    /// @param pollIndex The oracle's slot index in the polling array
    /// @param operator Address of the oracle operator
    /// @param commitHash Hash of the oracle's commitment
    event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash);
    
    /// @notice Emitted when enough commits are received to start reveal phase
    /// @param aggRequestId The aggregator request identifier
    event CommitPhaseComplete(bytes32 indexed aggRequestId);
    
    /// @notice Emitted when a reveal request is sent to an oracle
    /// @param aggRequestId The aggregator request identifier
    /// @param pollIndex The oracle's slot index
    /// @param commitHash The commit hash being revealed
    event RevealRequestDispatched(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash);
    
    /// @notice Emitted when an oracle provides a valid reveal response
    /// @param requestId The Chainlink request identifier
    /// @param pollIndex The oracle's slot index
    /// @param operator Address of the oracle operator
    event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator);
    
    /// @notice Emitted when bonus payment is made to a clustered oracle
    /// @param operator Address of the oracle operator receiving bonus
    /// @param bonusFee Amount of bonus LINK tokens paid
    event BonusPayment(address indexed operator, uint256 bonusFee);
    
    /// @notice Emitted when an evaluation times out
    /// @param aggRequestId The aggregator request identifier
    event EvaluationTimedOut(bytes32 indexed aggRequestId);
    
    /// @notice Emitted when an evaluation fails in a specific phase
    /// @param aggRequestId The aggregator request identifier
    /// @param phase The phase where failure occurred ("commit" or "reveal")
    event EvaluationFailed(bytes32 indexed aggRequestId, string phase);
    
    /// @notice Emitted when oracle score update is skipped due to error
    /// @param oracle Address of the oracle
    /// @param jobId Job identifier
    /// @param reason Reason for skipping the update
    event OracleScoreUpdateSkipped(address oracle, bytes32 jobId, string reason);
    
    /// @notice Reveal payload failed the commit-hash check (i.e., there was a mismatch)
    /// @param aggRequestId  Aggregator request id
    /// @param pollIndex     Oracle’s slot index
    /// @param operator      Oracle operator address (msg.sender)
    /// @param expectedHash  The hash stored from the commit
    /// @param gotHash       Hash recomputed from the reveal payload
    event RevealHashMismatch(
       bytes32 indexed aggRequestId,
       uint256 indexed pollIndex,
       address operator,
       bytes16 expectedHash,
       bytes16 gotHash
    );
    
    /// @notice Emitted when ReputationKeeper contract is changed
    /// @param oldKeeper Address of the previous ReputationKeeper
    /// @param newKeeper Address of the new ReputationKeeper
    event ReputationKeeperChanged(address indexed oldKeeper, address indexed newKeeper);

    /// @notice Emitted when the owner updates the score delta parameters.
    /// @param clusteredTimeliness   New timeliness delta when clustered.
    /// @param clusteredQuality      New quality delta when clustered.
    /// @param selectedTimeliness    New timeliness delta when selected but not clustered.
    /// @param selectedQuality       New quality delta when selected but not clustered.
    /// @param revealedTimeliness    New timeliness delta when revealed but not selected.
    /// @param revealedQuality       New quality delta when revealed but not selected.
    /// @param committedTimeliness   New timeliness delta when committed but not revealed.
    /// @param committedQuality      New quality delta when committed but not revealed.
    event ScoreDeltasUpdated( int8 clusteredTimeliness, int8 clusteredQuality, int8 selectedTimeliness,
                              int8 selectedQuality, int8 revealedTimeliness, int8 revealedQuality, 
                              int8 committedTimeliness, int8 committedQuality);

    /// @notice Emitted when an oracle’s reveal payload cannot be parsed because its
    ///         `cid:salt` string is malformed (wrong delimiter position, length, or
    ///         non‑hex salt).  
    /// @dev    The event is **non-reverting**, so the transaction stays successful
    ///         and the round can still complete with other oracles.  The offending
    ///         oracle is treated the same as a “no‑reveal” responder and will be
    ///         penalised during finalisation or timeout.
    /// @param  aggRequestId  Aggregator‑level request identifier.
    /// @param  pollIndex     Zero‑based index of the oracle in the polling array.
    /// @param  operator      Address of the oracle operator (msg.sender).
    /// @param  badCid        The exact malformed `cid:salt` string that was rejected.
    event InvalidRevealFormat(bytes32 indexed aggRequestId, uint256 indexed pollIndex,
                              address operator, string  badCid);

    // ----------------------------------------------------------------------
    //                               STRUCTS
    // ----------------------------------------------------------------------
    
    /**
     * @notice Individual oracle response data structure
     * @dev Stores a single oracle's response during the reveal phase
     */
    struct Response {
        uint256[] likelihoods;      /// @dev Array of likelihood scores provided by the oracle
        string justificationCID;    /// @dev IPFS CID containing the oracle's justification
        bytes32 requestId;          /// @dev Chainlink request ID for this response
        bool selected;              /// @dev Whether this response was selected for aggregation
        uint256 timestamp;          /// @dev Block timestamp when response was received
        address operator;           /// @dev Address of the oracle operator
        uint256 pollIndex;          /// @dev Oracle's slot index in the polling array
        bytes32 jobId;              /// @dev Oracle's job ID
    }

    /**
     * @notice Complete evaluation state for a single aggregation request
     * @dev Tracks the entire lifecycle of a commit-reveal evaluation
     */
    struct AggregatedEvaluation {
        // phase bookkeeping
        bool commitPhaseComplete;           /// @dev true → we are in reveal phase
        uint256 commitExpected;             /// @dev K - number of oracles polled in commit phase
        uint256 commitReceived;             /// @dev number of commits received so far

        // commit hashes per poll slot
        mapping(uint256 => bytes16) commitHashPerSlot;  /// @dev 0‑based poll index ⇒ 128‑bit hash

        // reveal bookkeeping
        Response[] responses;               /// @dev only *reveal* responses are stored here
        uint256 responseCount;              /// @dev reveal response counter
        uint256 requiredResponses;          /// @dev N (reveals to aggregate)
        uint256 clusterSize;                /// @dev P (cluster size for bonus)
        uint256[] aggregatedLikelihoods;    /// @dev final aggregated likelihood scores

        // oracle selection
        ReputationKeeper.OracleIdentity[] polledOracles;  /// @dev selected oracles (length == K)
        uint256[] pollFees;                               /// @dev fees paid to each oracle

        // accounting
        mapping(bytes32 => bool) requestIds;    /// @dev valid requestIds (commit & reveal)
        bool userFunded;                        /// @dev whether user provided funding
        address requester;                      /// @dev address that requested the evaluation
        uint256 startTimestamp;                 /// @dev when the evaluation was started

        // output
        string combinedJustificationCIDs;       /// @dev comma-separated CIDs from clustered oracles
        bool isComplete;                        /// @dev whether evaluation is finished
        bool failed;                            /// @dev whether evaluation failed
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

        // default parameters: K=6, M=4, N=3, P=2
        commitOraclesToPoll = 6;         // K 
        oraclesToPoll = 4;               // M
        requiredResponses = 3;           // N
        clusterSize = 2;                 // P

        clusteredTimelinessScore = 60;   // timeliness score change when clustered
        clusteredQualityScore = 60;      // quality score change when clustered
        selectedTimelinessScore = 0;     // timeliness score change when selected but not clustered
        selectedQualityScore = -60;      // quality score change when selected but not clustered
        revealedTimelinessScore = -20;   // timeliness score change when revealed but not selected
        revealedQualityScore = 0;        // quality score change when revealed but not selected
        committedTimelinessScore = -20;  // timeliness score change when committed but not revealed
        committedQualityScore = 0;       // quality score change when committed but not revealed

        responseTimeoutSeconds = 5 minutes;
        maxOracleFee = 0.1 * 10 ** 18;  // 0.1 LINK
    }

    // ----------------------------------------------------------------------
    //                            CONFIGURATION API
    // ----------------------------------------------------------------------
    /**
     * @notice Set all phase counts at once (K, M, N, P) - DEPRECATED
     * @dev This function is deprecated. Use setConfig instead for better validation
     * @param _k Number of oracles to poll in commit phase (commitOraclesToPoll)
     * @param _m Number of reveals requested from first M commits (oraclesToPoll)
     * @param _n Number of reveals required for final aggregation (requiredResponses)
     * @param _p Cluster size for bonus payments (clusterSize)
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

    /**
     * @notice Set the number of oracles to poll in commit phase
     * @dev Must be greater than or equal to oraclesToPoll (M)
     * @param _k Number of oracles to poll in commit phase
     */
    function setCommitOraclesToPoll(uint256 _k) external onlyOwner {
        require(_k >= oraclesToPoll, "K must be >= M");
        commitOraclesToPoll = _k;
    }

    /**
     * @notice Set the response timeout in seconds
     * @dev Timeout applies to both commit and reveal phases
     * @param _seconds Timeout duration in seconds
     */
    function setResponseTimeout(uint256 _seconds) external onlyOwner {
        responseTimeoutSeconds = _seconds;
    }

    /**
     * @notice Set the maximum allowed length of the likelihood vector
     * @dev    Prevents gas‑exhaustion by very large oracle payloads.
     * @param _len New upper bound (must be >= 2)
     */
    function setMaxLikelihoodLength(uint256 _len) external onlyOwner {
        require(_len >= 2, "length must be >= 2");
        maxLikelihoodLength = _len;
    }

    /**
     * @notice Set the maximum oracle fee in LINK tokens
     * @dev This limits the maximum fee that can be paid to any oracle
     * @param _newMax Maximum oracle fee in LINK wei
     */
    function setMaxOracleFee(uint256 _newMax) external onlyOwner {
        maxOracleFee = _newMax;
    }

    /**
     * @notice Estimate the maximum LINK needed for complete evaluation with bonuses
     * @dev Calculates: fee × (K + bonus_multiplier × P) for worst-case scenario
     * @param requestedMaxOracleFee Requested maximum fee per oracle
     * @return Maximum total LINK required for the evaluation
     */
    function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
        uint256 eff = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
        return eff * (commitOraclesToPoll + bonusMultiplier * clusterSize);
    }

    // ----------------------------------------------------------------------
    //                      USER FUNDED REQUEST ENTRYPOINT
    // ----------------------------------------------------------------------
    
    /**
     * @notice Request AI evaluation with user-funded LINK payment
     * @dev Main entry point for requesting AI evaluation using commit-reveal aggregation.
     *      User must approve LINK tokens before calling this function.
     * @param cids Array of IPFS CIDs containing evidence/data to evaluate
     * @param addendumText Additional text to append to the evaluation request
     * @param _alpha Reputation weight factor for oracle selection (0-1000)
     * @param _maxOracleFee Maximum fee per oracle in LINK wei
     * @param _estimatedBaseCost Estimated base cost for evaluation
     * @param _maxFeeBasedScalingFactor Maximum scaling factor for fee-based selection
     * @param _requestedClass Oracle class/category requested for evaluation
     * @return bytes32 Unique aggregator request ID for tracking the evaluation
     */
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
    
    /**
     * @notice Finalize an evaluation that has timed out
     * @dev Can be called by anyone to finalize evaluations that have exceeded responseTimeoutSeconds.
     *      Applies penalties to non-responsive oracles and handles partial results if available.
     * @param aggId The aggregator request ID to finalize
     */
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
            emit EvaluationTimedOut(aggId);
            emit EvaluationFailed(aggId, "commit");
            return;
        }

        /* ----------------- reveal phase timed out ----------------- */
        if (agg.responseCount < agg.requiredResponses) {
            _applyTimeoutPenalties(agg, false); // penalise non-revealing oracles
            agg.failed = true;
            agg.isComplete = true;
            emit EvaluationTimedOut(aggId);
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
     * @notice Callback function called by Chainlink oracles with their responses
     * @dev Handles both commit and reveal phases based on payload structure.
     *      COMMIT PHASE: response[0] contains hash of (actualLikelihoods, salt), cid is empty
     *      REVEAL PHASE: response contains actual likelihood scores, cid contains "cleanCid:salt"
     * @param requestId The Chainlink request ID
     * @param response Array of likelihood scores (reveal) or single hash value (commit)
     * @param cid IPFS CID with salt (reveal phase) or empty string (commit phase)
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
        require(looksLikeCommit || looksLikeReveal, "Callback payload malformed");

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
        require(agg.commitPhaseComplete, "Reveal arrived before commit phase complete");
        require(response.length <= maxLikelihoodLength, "Too many likelihood scores");

        // ─── DUPLICATE-REVEAL GUARD ──────────────────
        (bool seenAlready, ) = _getResponseForSlot(agg.responses, slot);
        if (seenAlready) {
            return;                                    // ignore retry
        }

        // first reveal fixes array length; every later reveal must match
        uint256[] storage totals = _ensureAggArrayExists(agg, response.length);
        require(response.length == totals.length, "Wrong number of scores");

        // Split "cleanCid:20hexSalt" -> (cid, saltUint)
        (bool ok, uint256 colonPos) = _isValidCidSalt(cid);
        if (!ok) {
            emit InvalidRevealFormat(aggId, slot, msg.sender, cid); 
            return;                         // treat as not revealed
        }
        (string memory cleanCid, uint256 saltUint) = _parseCidSaltUnchecked(cid, colonPos);

        // verify commit-reveal hash
        bytes16 recomputed = bytes16(sha256(abi.encode(msg.sender, response, saltUint)));
        if (recomputed != agg.commitHashPerSlot[slot]) {
            // log the problem
            emit RevealHashMismatch(aggId, slot, msg.sender, agg.commitHashPerSlot[slot], recomputed);

            // treat this oracle as not revealed – no response stored
            return;
        }

        // fix excessive score values through clamping to prevent later overflow
        for (uint256 i = 0; i < response.length; ++i) {
            if (response[i] > MAX_ARBITER_RETURN_SCORE) {
                response[i] = MAX_ARBITER_RETURN_SCORE;
            }
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
        emit NewOracleResponseRecorded(requestId, slot, aggId, msg.sender);

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
            ? _findBestClusterFromResponses(agg.responses, selIdx, agg.clusterSize)
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
                        try reputationKeeper.updateScores(id.oracle, resp.jobId, clusteredQualityScore, clusteredTimelinessScore) {} catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for clustered selected response");
                        }
                        uint256 bonus = agg.pollFees[slot] * bonusMultiplier;
                        _payBonus(agg.requester, agg.userFunded, bonus, resp.operator);
                        return (true, 1);
                    } else {
                        try reputationKeeper.updateScores(id.oracle, resp.jobId, selectedQualityScore, selectedTimelinessScore) {} catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for non-clustered selected response");
                        }
                        return (true, 0);
                    }
                }
            } else {
                try reputationKeeper.updateScores(id.oracle, resp.jobId, revealedQualityScore, revealedTimelinessScore) {} catch {
                    emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for responded but not selected");
                }
                return (true, 0);
            }
        } else {
            try reputationKeeper.updateScores(id.oracle, id.jobId, committedQualityScore, committedTimelinessScore) {} catch {
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

    // ----------------------------------------------------------------------
    //                          HELPER FUNCTIONS
    // ----------------------------------------------------------------------

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

    /**
     * @notice Get the current request counter value
     * @dev Used for generating unique aggregator request IDs
     * @return Current request counter value
     */
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
    function _findBestClusterFromResponses(
        Response[] memory responses,
        uint256[] memory selectedResponseIndices,
        uint256 P                              // desired cluster size
    ) internal pure returns (uint256[] memory)
    {
        uint256 count = selectedResponseIndices.length;
        require(count >= 2, "Need at least 2 responses");

        // Cap P to available responses
        if (P > count) P = count;

        // ---- step 1: find the closest pair ----
        uint256 bestA;
        uint256 bestB;
        uint256 bestDist = type(uint256).max;
        for (uint256 i = 0; i < count - 1; ++i) {
            for (uint256 j = i + 1; j < count; ++j) {
                uint256 d = _calculateDistance(
                    responses[selectedResponseIndices[i]].likelihoods,
                    responses[selectedResponseIndices[j]].likelihoods
                );
                if (d < bestDist) {
                    bestDist = d;
                    bestA = i;
                    bestB = j;
                }
            }
        }

        // flags: 1 = in cluster, 0 = out
        uint256[] memory flags = new uint256[](count);
        flags[bestA] = 1;
        flags[bestB] = 1;
        uint256 clusterSizeNow = 2;

        // ---- step 2: greedy add until clusterSizeNow == P ----
        while (clusterSizeNow < P) {
            uint256 bestCand;
            uint256 bestScore = type(uint256).max;

            for (uint256 i = 0; i < count; ++i) {
                if (flags[i] == 1) continue; // already in cluster

                // score = sum distance to current cluster members
                uint256 score = 0;
                for (uint256 k = 0; k < count; ++k) {
                    if (flags[k] == 1) {
                        score += _calculateDistance(
                            responses[selectedResponseIndices[i]].likelihoods,
                            responses[selectedResponseIndices[k]].likelihoods
                        );
                    }
                }
                if (score < bestScore) {
                    bestScore = score;
                    bestCand  = i;
                }
            }

            flags[bestCand] = 1;
            ++clusterSizeNow;
        }

        return flags; // length == count, with exactly P ones
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

    /// @dev Fast shape check for "cid:20hex" format.
    ///      Returns (ok, lastColonPos) where `lastColonPos` is the index
    ///      of ':' that separates cid and salt (undefined if !ok).
    function _isValidCidSalt(string memory packed)
        private pure
        returns (bool, uint256)
    {
        bytes memory b = bytes(packed);

        // at least 1 char + ':' + 20 chars
        if (b.length <= 21) return (false, 0);

        // find the last ':'
        uint256 i = b.length;
        while (i > 0 && b[i-1] != ":") { unchecked { --i; } }
        if (i == 0 || (b.length - i) != 20) return (false, 0);

        // check all 20 chars are hex
        unchecked {
            for (uint256 j = i; j < b.length; ++j) {
                uint8 c = uint8(b[j]);
                uint8 v = (c >= 97) ? c - 87
                       : (c >= 65) ? c - 55
                       : (c >= 48) ? c - 48
                       : 255;
                if (v >= 16) return (false, 0);
            }
        }
        return (true, i);
    }

    /// @dev Call **only after** `_isValidCidSalt` returned (true, pos).
    function _parseCidSaltUnchecked(string memory packed, uint256 colonPos)
        private pure
        returns (string memory cidOnly, uint256 salt)
    {
        bytes memory b = bytes(packed);

        // copy CID bytes
        bytes memory cidBytes = new bytes(colonPos - 1);
        for (uint256 j; j < cidBytes.length; ++j) cidBytes[j] = b[j];

        // parse 20-char hex salt
        unchecked {
            for (uint256 j = colonPos; j < b.length; ++j) {
                uint8 c = uint8(b[j]);
                uint8 v = (c >= 97) ? c - 87
                       : (c >= 65) ? c - 55
                       : (c >= 48) ? c - 48
                       : 0;           // cannot overflow; already validated
                salt = (salt << 4) | v;
            }
         }
        cidOnly = string(cidBytes);
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

    /**
     * @notice Get the evaluation results for a completed aggregation
     * @dev Returns the aggregated likelihood scores and combined justification CIDs
     * @param reqId The aggregator request ID
     * @return likelihoods Array of aggregated likelihood scores (0-100)
     * @return justifications Combined IPFS CIDs of justifications from clustered oracles
     * @return hasValidData Whether the evaluation completed successfully with valid data
     */
    function getEvaluation(bytes32 reqId) public view returns (uint256[] memory, string memory, bool) {
        AggregatedEvaluation storage agg = aggregatedEvaluations[reqId];
        bool hasValidData = agg.isComplete && agg.aggregatedLikelihoods.length > 0;
        return (agg.aggregatedLikelihoods, agg.combinedJustificationCIDs, hasValidData);
    }

    /**
     * @notice Get evaluation results (legacy interface for backwards compatibility)
     * @dev Simplified interface that returns only scores and justifications
     * @param reqId The aggregator request ID
     * @return likelihoods Array of aggregated likelihood scores
     * @return justifications Combined IPFS CIDs of justifications
     */
    function evaluations(bytes32 reqId) external view returns (uint256[] memory, string memory) {
        (uint256[] memory l, string memory j, ) = getEvaluation(reqId);
        return (l, j);
    }

    /**
     * @notice Get contract configuration (legacy interface)
     * @dev Returns basic contract configuration for backwards compatibility
     * @return oracleAddr Placeholder oracle address (always returns zero)
     * @return linkAddr Address of the LINK token contract
     * @return jobId Placeholder job ID (always returns zero)
     * @return fee Placeholder fee (always returns zero)
     */
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

    /**
     * @notice Withdraw LINK tokens from the contract
     * @dev Only callable by contract owner for emergency recovery
     * @param _to Address to receive the LINK tokens
     * @param _amount Amount of LINK tokens to withdraw (in wei)
     */
    function withdrawLink(address payable _to, uint256 _amount) external onlyOwner {
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        require(link.transfer(_to, _amount), "LINK transfer failed");
    }

    /**
     * @notice Set a new ReputationKeeper contract address
     * @dev Updates the reputation management contract used for oracle selection and scoring
     * @param newKeeper Address of the new ReputationKeeper contract
     */
    function setReputationKeeper(address newKeeper) external onlyOwner {
        require(newKeeper != address(0), "ReputationKeeper: zero address");
        address old = address(reputationKeeper);
        reputationKeeper = ReputationKeeper(newKeeper);
        emit ReputationKeeperChanged(old, newKeeper);
    }

    /**
     * @notice Set all configuration parameters at once
     * @dev Preferred method for updating configuration with validation
     * @param _k Number of oracles to poll in commit phase (commitOraclesToPoll)
     * @param _m Number of reveals requested from first M commits (oraclesToPoll)
     * @param _n Number of reveals required for final aggregation (requiredResponses)
     * @param _p Cluster size for bonus payments (clusterSize)
     * @param _timeoutSecs Response timeout in seconds
     */
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

    /**
     * @notice Set the bonus multiplier for clustered oracles
     * @dev Clustered oracles receive base_fee * bonus_multiplier as additional payment
     * @param _m Bonus multiplier (0-20x), typically 3x
     */
    function setBonusMultiplier(uint256 _m) external onlyOwner {
        require(_m <= 20, "bonus 0-20x");
        bonusMultiplier = _m;
    }

    /**
     * @notice Updates all score‑delta parameters in one transaction.
     * @dev Only callable by the contract owner. Emits a ScoreDeltasUpdated event.
     * @param _clusteredTimeliness  Delta applied to timeliness when clustered.
     * @param _clusteredQuality     Delta applied to quality when clustered.
     * @param _selectedTimeliness   Delta applied to timeliness when selected but not clustered.
     * @param _selectedQuality      Delta applied to quality when selected but not clustered.
     * @param _revealedTimeliness   Delta applied to timeliness when revealed but not selected.
     * @param _revealedQuality      Delta applied to quality when revealed but not selected.
     * @param _committedTimeliness  Delta applied to timeliness when committed but not revealed.
     * @param _committedQuality     Delta applied to quality when committed but not revealed.
     */
    function setScoreDeltas(
        int8 _clusteredTimeliness,
        int8 _clusteredQuality,
        int8 _selectedTimeliness,
        int8 _selectedQuality,
        int8 _revealedTimeliness,
        int8 _revealedQuality,
        int8 _committedTimeliness,
        int8 _committedQuality
    ) external onlyOwner {

       clusteredTimelinessScore  = _clusteredTimeliness;
       clusteredQualityScore     = _clusteredQuality;
       selectedTimelinessScore   = _selectedTimeliness;
       selectedQualityScore      = _selectedQuality;
       revealedTimelinessScore   = _revealedTimeliness;
       revealedQualityScore      = _revealedQuality;
       committedTimelinessScore  = _committedTimeliness;
       committedQualityScore     = _committedQuality;

       emit ScoreDeltasUpdated(
           _clusteredTimeliness,
           _clusteredQuality,
           _selectedTimeliness,
           _selectedQuality,
           _revealedTimeliness,
           _revealedQuality,
           _committedTimeliness,
           _committedQuality
       );
    }

    /**
     * @notice Check if an evaluation has failed
     * @dev Returns true if the evaluation timed out or failed for other reasons
     * @param aggId The aggregator request ID to check
     * @return bool True if the evaluation failed, false otherwise
     */
    function isFailed(bytes32 aggId) external view returns (bool) {
        return aggregatedEvaluations[aggId].failed;
    }
}
