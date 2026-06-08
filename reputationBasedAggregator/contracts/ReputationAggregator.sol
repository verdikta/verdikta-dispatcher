// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@chainlink/contracts/src/v0.8/operatorforwarder/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ReputationKeeper.sol";
import "./AggregatorLib.sol";

/**
 * @title ReputationAggregator commit-reveal edition, ETH-funded (ASCII only)
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
 *      Payment (ETH, see docs/advanced/eth-payment-migration.md):
 *      - Arbiters are paid in ETH, not LINK. The Chainlink request rail is kept
 *        but carries 0 juel (transferAndCall(operator, 0, data)); the aggregator
 *        holds no LINK for routine operation.
 *      - The requester prepays the worst case in msg.value (and/or from existing
 *        ethOwed credit). The contract escrows that ETH and settles via a pull
 *        ledger (ethOwed): oracle owners and refund-due requesters withdraw it.
 *      - 1x base fee is credited to ALL K polled oracles' owners up front, at
 *        request time (so there is never an incentive to submit a fake commit
 *        just to collect base). A bonus of Bx the base fee is credited to each
 *        clustered oracle at finalize. Unspent ETH is refunded to the requester
 *        as an ethOwed credit. Invariant: balance == sum(ethOwed) + sum(reserved).
 */
contract ReputationAggregator is ChainlinkClient, Ownable, ReentrancyGuard, Pausable {
    using Chainlink for Chainlink.Request;

    // ----------------------------------------------------------------------
    //                          CUSTOM ERRORS
    // ----------------------------------------------------------------------
    error LengthTooShort();
    error InvalidConfig();
    error InvalidBonusMultiplier();
    error KeeperNotSet();
    error EmptyCIDList();
    error TooManyCIDs();
    error CIDTooLong();
    error AddendumTooLong();
    error InactiveOracle();
    error AggregationComplete();
    error NotTimedOut();
    error UnknownRequest();
    error MalformedPayload();
    error RevealBeforeCommit();
    error LinkTransferFailed();
    error ZeroAddress();
    error InsufficientPayment();   // msg.value + applied credit < required worst-case
    error NotAuthorized();         // withdrawEthFor caller is neither payee nor owner
    error NothingOwed();           // withdrawal attempted with a zero ethOwed balance
    error EthTransferFailed();     // payee.call{value:} returned false on withdrawal
    error OnlySelf();              // dispatch trampoline invoked by anyone other than this contract

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

    // owner-settable hard ceiling on a single oracle's fee, denominated in ETH wei.
    // Unlike the legacy LINK contract this ceiling is ENFORCED in selection: the
    // request entry point clamps the caller's _maxOracleFee down to this value
    // before calling selectOracles, so it bounds which arbiters are eligible (see
    // the fee clamp in requestAIEvaluationWithApproval and docs section 5.3).
    uint256 public maxOracleFee;

    // limits for user input
    uint256 public constant MAX_CID_COUNT = 10;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    // limits for arbiter behavior
    uint256 private constant MAX_ARBITER_RETURN_SCORE = 1e34;
    // Max length of an oracle's reveal "cid" string = "<cleanCid>:<20-hex-salt>". Caps the
    // justification CID at MAX_CID_LENGTH (same as requester CIDs); the +21 is the fixed
    // ":" + 20-hex-salt suffix. Bounds per-reveal storage and the combinedJustificationCIDs
    // concatenation at finalize against an oracle returning a huge CID.
    uint256 public constant MAX_REVEAL_CID_LENGTH = MAX_CID_LENGTH + 21;

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
    
    /// @notice Emitted when a bonus is credited to a clustered oracle's owner
    /// @param operator Address of the oracle operator whose owner is credited
    /// @param bonusFee Amount of bonus ETH (wei) credited to ethOwed
    event BonusPayment(address indexed operator, uint256 bonusFee);

    /// @notice Emitted when base fee is credited to a polled oracle's owner at request time
    /// @param aggRequestId Aggregator request identifier
    /// @param pollIndex Oracle's slot index in the polling array
    /// @param payee The credited address (oracle owner snapshotted at request)
    /// @param amount Base fee (wei) credited to ethOwed
    event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);

    /// @notice Emitted when unspent ETH is refunded to the requester as an ethOwed credit
    /// @param aggRequestId Aggregator request identifier
    /// @param requester The requester credited with the refund
    /// @param amount Refund (wei) credited to ethOwed
    event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);

    /// @notice Emitted when a request draws on the caller's existing ethOwed credit
    /// @param aggRequestId Aggregator request identifier
    /// @param requester The requester (msg.sender) funding the round
    /// @param fromCredit ETH (wei) drawn from ethOwed[requester]
    /// @param fromValue ETH (wei) attached as msg.value
    event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);

    /// @notice Emitted when ETH is paid out from the pull ledger
    /// @param payee The credited address that received the payout
    /// @param amount ETH (wei) sent
    event EthWithdrawn(address indexed payee, uint256 amount);
    
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

    /// @notice Emitted for every oracle that is picked for a poll slot  
    /// @param aggRequestId  Aggregator-level request identifier  
    /// @param pollIndex     Zero-based slot number (0‥K-1)  
    /// @param oracle        Oracle operator address  
    /// @param jobId         Job-ID used for this request
    event OracleSelected( bytes32 indexed aggRequestId, uint256 indexed pollIndex,
        address oracle, bytes32 jobId
    );

    /// @notice Emitted when a reveal fails because response array is too long
    /// @param aggRequestId Aggregator request identifier
    /// @param pollIndex Oracle's slot index
    /// @param operator Oracle operator address
    /// @param responseLength Length of the response array provided
    /// @param maxAllowed Maximum allowed length (maxLikelihoodLength)
    event RevealTooManyScores(
        bytes32 indexed aggRequestId,
        uint256 indexed pollIndex, 
        address operator,
        uint256 responseLength,
        uint256 maxAllowed
    );

    /// @notice Emitted when a reveal fails because response array length doesn't match expected
    /// @param aggRequestId Aggregator request identifier  
    /// @param pollIndex Oracle's slot index
    /// @param operator Oracle operator address
    /// @param responseLength Length of the response array provided
    /// @param expectedLength Expected length based on first successful reveal
    event RevealWrongScoreCount(
        bytes32 indexed aggRequestId,
        uint256 indexed pollIndex,
        address operator, 
        uint256 responseLength,
        uint256 expectedLength
    );

    /// @notice Emitted when a reveal fails because response array is too short (< 2 scores)
    /// @param aggRequestId Aggregator request identifier
    /// @param pollIndex Oracle's slot index  
    /// @param operator Oracle operator address
    /// @param responseLength Length of the response array provided
    event RevealTooFewScores(
         bytes32 indexed aggRequestId,
        uint256 indexed pollIndex,
        address operator,
        uint256 responseLength
    );

    /// @notice Emitted when a reveal is rejected because its "cid:salt" string exceeds
    ///         MAX_REVEAL_CID_LENGTH. Logs only the length, never the oversized content.
    /// @param aggRequestId Aggregator request identifier
    /// @param pollIndex Oracle's slot index
    /// @param operator Oracle operator address
    /// @param cidLength Length (bytes) of the rejected cid string
    /// @param maxAllowed Maximum allowed length (MAX_REVEAL_CID_LENGTH)
    event RevealCidTooLong(
        bytes32 indexed aggRequestId,
        uint256 indexed pollIndex,
        address operator,
        uint256 cidLength,
        uint256 maxAllowed
    );

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
        bool selected;              /// @dev Whether this response was selected for aggregation
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
        uint256 revealExpected;             /// @dev M - first M commits promoted to reveal (snapshot of oraclesToPoll)
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
        address[] payees;                                 /// @dev owner() snapshotted per slot at request (base AND bonus payee)

        // accounting
        address requester;                      /// @dev address that requested the evaluation
        uint256 startTimestamp;                 /// @dev request time; anchors the single whole-round timeout (NOT reset at commit->reveal)

        // ETH escrow accounting (see docs/advanced/eth-payment-migration.md section 4.5)
        uint256 ethReceived;                    /// @dev ETH committed to this round (fromCredit + msg.value), set once at request
        uint256 baseCredited;                   /// @dev sum of base fees credited to oracle owners (all K, at request time)
        uint256 bonusCredited;                  /// @dev sum of bonus credited to clustered oracle owners at finalize
        uint256 bonusMultiplierSnap;            /// @dev bonusMultiplier captured at request (prevents mid-round drift)

        // output
        string combinedJustificationCIDs;       /// @dev comma-separated CIDs from clustered oracles
        bool isComplete;                        /// @dev whether evaluation is finished
        bool failed;                            /// @dev whether evaluation failed
    }

    // ----------------------------------------------------------------------
    //                         MAPPINGS
    // ----------------------------------------------------------------------
    // Internal (not public): the auto-generated getter for this struct would ABI-encode
    // all ~15 scalar fields in one tuple and overflow the stack even under viaIR. Read
    // state via the curated getAggregationStatus() / getEthAccounting() views below.
    mapping(bytes32 => AggregatedEvaluation) internal aggregatedEvaluations; // agg ID => evaluation
    mapping(bytes32 => bytes32) public requestIdToAggregatorId;            // nodeReq => aggReq
    mapping(bytes32 => uint256) public requestIdToPollIndex;               // nodeReq => poll slot

    /// @notice Pull-payment ledger: ETH owed to a payee (an oracle owner credited
    ///         base/bonus, or a requester awaiting a refund). Claimed via
    ///         withdrawEth() / withdrawEthFor(payee). This is the only place ETH
    ///         leaves the contract on the payment path.
    /// @dev Global solvency invariant, true after every state transition:
    ///      address(this).balance == sum(ethOwed) + sum_openAgg(reserved[aggId]),
    ///      where reserved[aggId] = ethReceived - baseCredited - bonusCredited.
    mapping(address => uint256) public ethOwed;

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
        revealedTimelinessScore = -20;   // timeliness score change when chosen for reveal but not selected
        revealedQualityScore = 0;        // quality score change when chosen for reveal but not selected
        committedTimelinessScore = -20;  // timeliness score change when chosen for commit but not chosen for reveal
        committedQualityScore = 0;       // quality score change when chosen for commit but not chosen for reveal

        responseTimeoutSeconds = 5 minutes;
        // ETH ceiling: 0.0004 ETH (the live 0.05 LINK ceiling scaled by /125, see
        // docs section 4.6). deploy/03_config.js sets this explicitly; the default
        // is the same safe ETH-scale value so a config-less deploy cannot select
        // LINK-scale arbiters.
        maxOracleFee = 4 * 10 ** 14;  // 0.0004 ETH
    }

    // ----------------------------------------------------------------------
    //                            CONFIGURATION API
    // ----------------------------------------------------------------------
    /**
     * @notice Set the response timeout in seconds
     * @dev A SINGLE window covering the whole round (commit and reveal phases combined),
     *      measured from the request timestamp. Phase transitions do not reset it by
     *      design, so commit and reveal share this one deadline rather than each getting
     *      a fresh one.
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
        if (_len < 2) revert LengthTooShort();
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
     * @notice Pause the contract, blocking NEW evaluation requests.
     * @dev Circuit breaker for incident response. Scope is deliberately narrow: only
     *      requestAIEvaluationWithApproval is gated (whenNotPaused). fulfill, the timeout
     *      finalizer, and both withdrawal paths stay enabled while paused, so pausing can
     *      never strand in-flight rounds or trap already-escrowed funds - it only stops
     *      fresh ETH from entering. Emits Paused(account) (from OZ Pausable).
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resume the contract, re-enabling new evaluation requests.
     * @dev Emits Unpaused(account) (from OZ Pausable).
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Estimate the maximum ETH needed for a complete evaluation with bonuses
     * @dev Calculates: effFee × (K + bonus_multiplier × P) for the worst-case scenario,
     *      where effFee = min(requestedMaxOracleFee, maxOracleFee) is the clamped per-oracle
     *      ceiling actually used by selection. This is exactly the `required` amount the
     *      request entry point enforces; callers size msg.value from this view (net of any
     *      existing ethOwed credit). Denominated in ETH wei.
     * @param requestedMaxOracleFee Requested maximum fee per oracle (clamped to maxOracleFee)
     * @return Maximum total ETH (wei) required for the evaluation
     */
    function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
        uint256 eff = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
        return eff * (commitOraclesToPoll + bonusMultiplier * clusterSize);
    }

    // ----------------------------------------------------------------------
    //                      USER FUNDED REQUEST ENTRYPOINT
    // ----------------------------------------------------------------------
    
    /**
     * @notice Request AI evaluation, funded with ETH (msg.value and/or existing credit)
     * @dev Main entry point for requesting AI evaluation using commit-reveal aggregation.
     *      The caller sends ETH with the call; the round may also draw on the caller's
     *      existing ethOwed credit (fund-from-credit), so msg.value may be 0 when credit
     *      covers the worst case. No LINK approval is required. The worst-case cost is
     *      `maxTotalFee(_maxOracleFee)`; any unspent ETH is refunded to the caller as an
     *      ethOwed credit at settlement. See docs/advanced/eth-payment-migration.md.
     * @param cids Array of IPFS CIDs containing evidence/data to evaluate
     * @param addendumText Additional text to append to the evaluation request
     * @param _alpha Reputation weight factor for oracle selection (0-1000)
     * @param _maxOracleFee Maximum fee per oracle in ETH wei (clamped to maxOracleFee)
     * @param _estimatedBaseCost Estimated base cost for evaluation (ETH wei)
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
    ) public payable nonReentrant whenNotPaused returns (bytes32) {
        if (address(reputationKeeper) == address(0)) revert KeeperNotSet();
        if (cids.length == 0) revert EmptyCIDList();
        if (cids.length > MAX_CID_COUNT) revert TooManyCIDs();
        for (uint256 i = 0; i < cids.length; i++) {
            if (bytes(cids[i]).length > MAX_CID_LENGTH) revert CIDTooLong();
        }
        if (bytes(addendumText).length > MAX_ADDENDUM_LENGTH) revert AddendumTooLong();

        // ----- Fee clamp (docs section 5.3, layer 1) -----
        // Clamp the caller's requested ceiling down to the contract ceiling BEFORE
        // selection, so maxOracleFee is the authoritative ETH ceiling and the keeper's
        // `fee <= maxFee` filter can never pull in a LINK-scale arbiter, regardless of
        // what the caller passes. This mirrors the min() already in maxTotalFee().
        uint256 effMaxFee = _maxOracleFee < maxOracleFee ? _maxOracleFee : maxOracleFee;

        // ----- Fund the round: existing credit first, then fresh ETH (docs section 4.5) -----
        // required == maxTotalFee(_maxOracleFee): the worst case effMaxFee * (K + B*P).
        uint256 required = effMaxFee * (commitOraclesToPoll + bonusMultiplier * clusterSize);
        uint256 fromCredit = _fundFromCredit(required);   // debits ethOwed[msg.sender] (CEI)

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
        agg.revealExpected = oraclesToPoll;
        agg.requiredResponses = requiredResponses;
        agg.clusterSize = clusterSize;
        agg.requester = msg.sender;
        agg.startTimestamp = block.timestamp;
        agg.commitPhaseComplete = false;

        // ETH escrow: record what was committed and snapshot the bonus multiplier so a
        // mid-round setBonusMultiplier() cannot size the bonus above the reserve.
        agg.ethReceived = fromCredit + msg.value;
        agg.bonusMultiplierSnap = bonusMultiplier;
        emit RequestFunded(aggId, msg.sender, fromCredit, msg.value);

        // select oracles (K) - pass the CLAMPED ceiling, not the raw caller value
        ReputationKeeper.OracleIdentity[] memory sel = reputationKeeper.selectOracles(
            commitOraclesToPoll,
            _alpha,
            effMaxFee,
            _estimatedBaseCost,
            _maxFeeBasedScalingFactor,
            _requestedClass
        );
        reputationKeeper.recordUsedOracles(sel);

        // dispatch Mode 1 requests (per-oracle work extracted to keep this frame shallow).
        // Pass effMaxFee (the clamped ceiling the escrow `required` was sized on) so the
        // per-oracle charge guard enforces the same bound the reserve assumes.
        for (uint256 i = 0; i < sel.length; i++) {
            _pollOracle(aggId, agg, sel[i], i, cidConcat, effMaxFee);
        }

        emit RequestAIEvaluation(aggId, cids);
        return aggId;
    }

    /**
     * @dev Debit the caller's existing ethOwed credit toward `required`, then require the
     *      remaining shortfall to be covered by msg.value (docs section 4.5, fund-from-credit).
     *      Only msg.sender's OWN credit can be spent, and the debit happens here - before any
     *      external call in the caller - to satisfy checks-effects-interactions.
     * @return fromCredit ETH drawn from ethOwed[msg.sender] (== min(credit, required)).
     */
    function _fundFromCredit(uint256 required) internal returns (uint256 fromCredit) {
        uint256 credit = ethOwed[msg.sender];
        fromCredit = credit < required ? credit : required;
        if (msg.value + fromCredit < required) revert InsufficientPayment();
        ethOwed[msg.sender] = credit - fromCredit;
    }

    /**
     * @dev Poll a single selected oracle: record it, pay its 1x base fee up front to its
     *      owner (pay-all decision, docs section 4.5), and dispatch the Mode-1 request with
     *      0 juel (docs section 3). Extracted from the request loop both to keep that frame
     *      under the stack limit and as the per-oracle transport/payment seam (docs section 6).
     *
     *      The charge-time guard checks fee <= effMaxFee - the SAME clamped ceiling the round's
     *      escrow `required` was sized on (docs section 5.3), NOT the looser global maxOracleFee.
     *      This makes `baseCredited + bonusCredited <= ethReceived` a locally-enforced solvency
     *      invariant instead of one that silently depends on the keeper's fee filter; in correct
     *      operation selection already bounds fee <= effMaxFee, so it never triggers.
     *
     *      BOTH external calls to the (untrusted) oracle are individually wrapped so neither can
     *      brick the request: (1) the owner() payee lookup, and (2) the 0-juel dispatch, whose
     *      transferAndCall fires the operator's ERC-677 onTokenTransfer hook - a hook a malicious
     *      operator can make revert. The dispatch goes through the dispatchOracleRequest self-call
     *      trampoline precisely so that revert is caught here. On either failure the slot's base
     *      credit and dispatch are skipped and it becomes a non-participant, penalized at
     *      finalize/timeout like any no-show. Base is credited only AFTER a successful dispatch, so
     *      an operator that refuses the job earns nothing. No funds are at risk - an uncredited slot
     *      just enlarges the requester's refund.
     */
    function _pollOracle(
        bytes32 aggId,
        AggregatedEvaluation storage agg,
        ReputationKeeper.OracleIdentity memory sel,
        uint256 slot,
        string memory cidConcat,
        uint256 effMaxFee
    ) internal {
        (bool active, , , , bytes32 jobId, uint256 fee, , , ) = reputationKeeper.getOracleInfo(sel.oracle, sel.jobId);
        if (!active) revert InactiveOracle();
        if (fee > effMaxFee) revert InsufficientPayment();

        // Record the slot up front so polledOracles/pollFees stay index-aligned with `slot`
        // on EVERY exit path; payees is pushed once in each try/catch branch below, so it
        // stays aligned too.
        agg.polledOracles.push(sel);
        agg.pollFees.push(fee);

        // STEP 1 - resolve the payee (oracle owner). A reverting owner() (malformed/malicious
        // oracle) must not brick the request: on failure the slot becomes an uncredited,
        // undispatched no-show. Push a zero payee to keep arrays aligned and bail out.
        address payee;
        try IOracleOwner(sel.oracle).owner() returns (address resolved) {
            payee = resolved;
        } catch {
            agg.payees.push(address(0));
            emit OracleScoreUpdateSkipped(sel.oracle, sel.jobId, "owner() reverted at base payment");
            return;
        }

        // STEP 2 - 0-juel dispatch through the dispatchOracleRequest self-call trampoline. The
        // transferAndCall inside fires the operator's ERC-677 onTokenTransfer hook, which a
        // malicious operator can make revert; routing it through an external self-call lets us
        // CATCH that revert here instead of unwinding the whole request. A reverted dispatch
        // leaves no pending Chainlink request (its state rolls back), so the slot is simply a
        // no-show. base is credited and the payee SNAPSHOTTED only on a SUCCESSFUL dispatch - the
        // same snapshot is reused for the bonus at finalize, so base and bonus always pay whoever
        // owned the arbiter when it was selected (an ownership change mid-round can neither split
        // the two payments nor redirect the bonus), and an operator that refuses the job earns nothing.
        try this.dispatchOracleRequest(aggId, sel.oracle, jobId, cidConcat) returns (bytes32 opReq) {
            agg.payees.push(payee);
            ethOwed[payee] += fee;
            agg.baseCredited += fee;
            emit BasePayment(aggId, slot, payee, fee);

            requestIdToAggregatorId[opReq] = aggId;
            requestIdToPollIndex[opReq] = slot;
            emit OracleSelected(aggId, slot, sel.oracle, sel.jobId);
        } catch {
            // dispatch reverted (e.g. operator onTokenTransfer hook reverted): no-show. Push a
            // zero payee to keep arrays aligned; an undispatched slot never commits, so it never
            // reveals, never clusters, and its payee is never read for a bonus.
            agg.payees.push(address(0));
            emit OracleScoreUpdateSkipped(sel.oracle, sel.jobId, "dispatch reverted at request");
        }
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
        // Reject ids that were never opened by a real request. A live request always
        // stamps a non-zero startTimestamp, so startTimestamp == 0 uniquely identifies
        // an uninitialized slot. Without this, anyone could drive an unused slot to
        // isComplete via the timeout path (startTimestamp 0 trivially satisfies the
        // timeout check); harmless on its own, but it would leave isComplete set on a
        // slot a future request could reuse, and it clutters storage with phantom rounds.
        if (agg.startTimestamp == 0) revert UnknownRequest();
        if (agg.isComplete) revert AggregationComplete();
        if (block.timestamp < agg.startTimestamp + responseTimeoutSeconds) revert NotTimedOut();

        /* ----------------- commit phase timed out ----------------- */
        // Reaching here means commit phase never completed, i.e. fewer than M
        // (revealExpected) commits arrived. fulfill flips commitPhaseComplete the instant
        // commitReceived == revealExpected (and stops counting late commits), so
        // !commitPhaseComplete strictly implies commitReceived < revealExpected - there is
        // no "enough commits but not yet promoted" state to handle here. Fail the round.
        // Base was already credited to all K oracles at request time; no cluster formed
        // (bonusCredited == 0), so the remainder refunds via the single uniform expression.
        if (!agg.commitPhaseComplete) {
            _applyTimeoutPenalties(agg, true);  // penalise non-committing oracles only
            _refundRequester(aggId, agg);
            agg.failed = true;
            agg.isComplete = true;
            emit EvaluationTimedOut(aggId);
            emit EvaluationFailed(aggId, "commit");
            return;
        }

        /* ----------------- reveal phase timed out ----------------- */
        if (agg.responseCount < agg.requiredResponses) {
            _applyTimeoutPenalties(agg, false); // penalise non-revealing oracles
            _refundRequester(aggId, agg);       // bonusCredited == 0; refund the rest
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
        if (aggId == bytes32(0)) revert UnknownRequest();

        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        if (agg.isComplete) revert AggregationComplete();

        uint256 slot = requestIdToPollIndex[requestId];

        // ---------- decide phase from *payload shape* ----------
        bool looksLikeCommit = (response.length == 1) && (bytes(cid).length == 0);
        bool looksLikeReveal = (response.length >= 2) && (bytes(cid).length > 0);
        if (!looksLikeCommit && !looksLikeReveal) revert MalformedPayload();

        /* ────────────────────────────────────────────────────────
         *                     COMMIT  (Mode-1)
         * ──────────────────────────────────────────────────────── */
        if (looksLikeCommit) {

            bytes16 hash128 = bytes16(bytes32(uint256(response[0]) << 128));

            // Reject a degenerate zero commit. commitHashPerSlot uses bytes16(0) as the
            // "no commit" sentinel (the duplicate guard below and the reveal-dispatch skip
            // both key on it), so a zero hash would count toward commitReceived yet store
            // as 0 and never receive a reveal request - diverging the commit count from the
            // dispatchable set. An honest commit is bytes16(sha256(...)), zero with
            // probability 2^-128, so this rejects only degenerate/malicious payloads.
            if (hash128 == bytes16(0)) return;

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

            // when we have M commits → start reveal phase. startTimestamp is intentionally
            // not reset here: the reveal phase continues under the original whole-round
            // timeout deadline rather than starting a new window.
            if (agg.commitReceived == agg.revealExpected) {
                agg.commitPhaseComplete = true;
                emit CommitPhaseComplete(aggId);
                _dispatchRevealRequests(aggId, agg);
            }
            return;                                     // commit handled
        }

        /* ────────────────────────────────────────────────────────
         *                     REVEAL  (Mode-2)
         * ──────────────────────────────────────────────────────── */
        if (!agg.commitPhaseComplete) revert RevealBeforeCommit();

        // Check for too few scores (less than 2)
        if (response.length < 2) {
            emit RevealTooFewScores(aggId, slot, msg.sender, response.length);
            return; // treat as not revealed
        }
        
        // Check for too many scores
        if (response.length > maxLikelihoodLength) {
            emit RevealTooManyScores(aggId, slot, msg.sender, response.length, maxLikelihoodLength);
            return; // treat as not revealed
        }

        // Bound the oracle-supplied cid (checked before parsing/copying). Unbounded, a
        // malicious oracle could store a huge justificationCID and blow up the finalize
        // combinedJustificationCIDs concatenation / storage. Log only the length.
        if (bytes(cid).length > MAX_REVEAL_CID_LENGTH) {
            emit RevealCidTooLong(aggId, slot, msg.sender, bytes(cid).length, MAX_REVEAL_CID_LENGTH);
            return; // treat as not revealed
        }

        // ─── DUPLICATE-REVEAL GUARD ──────────────────
        (bool seenAlready, ) = _getResponseForSlot(agg.responses, slot);
        if (seenAlready) {
            return;                                    // ignore retry
        }

        // first reveal fixes array length; every later reveal must match
        uint256[] storage totals = _ensureAggArrayExists(agg, response.length);
        if (response.length != totals.length) {
            emit RevealWrongScoreCount(aggId, slot, msg.sender, response.length, totals.length);
            return; // treat as not revealed
        }

        // Split "cleanCid:20hexSalt" -> (cid, saltUint)
        (bool ok, uint256 colonPos) = AggregatorLib.isValidCidSalt(cid);
        if (!ok) {
            emit InvalidRevealFormat(aggId, slot, msg.sender, cid);
            return;                         // treat as not revealed
        }
        (string memory cleanCid, uint256 saltUint) = AggregatorLib.parseCidSaltUnchecked(cid, colonPos);

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
            selected:         selected,
            operator:         msg.sender,
            pollIndex:        slot,
            jobId:            agg.polledOracles[slot].jobId
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
            string memory cid2 = string(abi.encodePacked("2:", AggregatorLib.bytes16ToHexLower(hash128)));
            // Trampoline dispatch (see dispatchOracleRequest): a committed operator that now
            // reverts in its onTokenTransfer hook fails only its own reveal dispatch instead of
            // aborting THIS fulfill (the M-th commit), which would otherwise roll back the commit
            // count and wedge the round in commit phase until timeout. A skipped reveal dispatch
            // just means that slot never reveals - a no-show at finalize/timeout.
            try this.dispatchOracleRequest(aggId, oid.oracle, oid.jobId, cid2) returns (bytes32 opReq) {
                requestIdToAggregatorId[opReq] = aggId;
                requestIdToPollIndex[opReq] = slot;
                emit RevealRequestDispatched(aggId, slot, hash128);
            } catch {
                emit OracleScoreUpdateSkipped(oid.oracle, oid.jobId, "dispatch reverted at reveal");
            }
        }
    }

    // ----------------------------------------------------------------------
    //                       HELPER: BUILD & SEND REQUEST
    // ----------------------------------------------------------------------
    function _sendSingleOracleRequest(
        bytes32 aggId,
        address operator,
        bytes32 jobId,
        uint256 fee,
        string memory cidPayload
    ) internal returns (bytes32) {
        Chainlink.Request memory req = _buildOperatorRequest(jobId, this.fulfill.selector);
        req._add("cid", cidPayload);
        req._add("aggId", AggregatorLib.bytes32ToHex(aggId));
        return _sendOperatorRequestTo(operator, req, fee);
    }

    /**
     * @notice External self-call trampoline performing a single 0-juel oracle dispatch.
     * @dev Exists ONLY so callers (_pollOracle, _dispatchRevealRequests) can wrap the dispatch in
     *      try/catch. _sendSingleOracleRequest's transferAndCall fires the operator's ERC-677
     *      onTokenTransfer hook; a malicious/buggy operator can make that hook revert. As an
     *      internal call such a revert would unwind the whole request (or the M-th committer's
     *      fulfill, wedging the round); as an EXTERNAL self-call it is caught by the caller and the
     *      slot is treated as a no-show. A reverted call rolls back its own state, including the
     *      ChainlinkClient nonce bump and the s_pendingRequests write, so it leaves no orphan
     *      request and the next dispatch reuses the nonce cleanly.
     *
     *      Access is restricted to internal self-calls (msg.sender == address(this)); no external
     *      party can mint Chainlink requests through it. Deliberately NOT nonReentrant: it executes
     *      inside the parent entrypoint's reentrancy lock, so the operator hook still cannot reenter
     *      any guarded function - a reentrancy attempt just surfaces here as a caught dispatch failure.
     * @return opReq The Chainlink request id created for this dispatch.
     */
    function dispatchOracleRequest(
        bytes32 aggId,
        address operator,
        bytes32 jobId,
        string calldata cidPayload
    ) external returns (bytes32 opReq) {
        if (msg.sender != address(this)) revert OnlySelf();
        return _sendSingleOracleRequest(aggId, operator, jobId, 0, cidPayload);
    }

    // ----------------------------------------------------------------------
    //                            AGGREGATION LOGIC
    // ----------------------------------------------------------------------
    function _finalizeAggregation(bytes32 aggId) internal {
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        if (agg.isComplete) revert AggregationComplete();

        // responses is not mutated anywhere in finalize, so read its length once
        // instead of re-SLOADing it in every loop condition below.
        uint256 rlen = agg.responses.length;

        uint256 selectedCount = 0;
        for (uint256 i = 0; i < rlen; i++) {
            if (agg.responses[i].selected) selectedCount++;
        }

        uint256[] memory selIdx = new uint256[](selectedCount);
        uint256 k = 0;
        for (uint256 i = 0; i < rlen; i++) {
            if (agg.responses[i].selected) selIdx[k++] = i;
        }

        uint256[] memory cluster;
        if (selectedCount >= 2) {
            // Copy only the likelihood vectors into memory for the clustering
            // library (avoids passing the whole Response[] across the call).
            uint256[][] memory ll = new uint256[][](rlen);
            for (uint256 i = 0; i < rlen; i++) {
                ll[i] = agg.responses[i].likelihoods;
            }
            cluster = AggregatorLib.findBestCluster(ll, selIdx, agg.clusterSize);
        } else {
            cluster = new uint256[](selectedCount);
        }

        if (rlen > 0) {
            agg.aggregatedLikelihoods = new uint256[](agg.responses[0].likelihoods.length);
        }
        
        uint256 clusterCount = 0;
        uint256 m = agg.polledOracles.length;
        for (uint256 slot = 0; slot < m; slot++) {
            (bool processed, uint256 addCluster) = _processPollSlot(agg, slot, selIdx, cluster);
            if (processed && addCluster > 0) {
                uint256 respIndex = _findResponseIndexForSlot(agg.responses, slot);
                if (respIndex < rlen) {
                    uint256[] memory curr = agg.responses[respIndex].likelihoods;
                    for (uint256 j = 0; j < curr.length; j++) {
                        agg.aggregatedLikelihoods[j] += curr[j];
                    }
                    clusterCount++;
                }
            }
        }
        
        if (clusterCount > 0) {
            uint256 aggLen = agg.aggregatedLikelihoods.length;
            for (uint256 j = 0; j < aggLen; j++) {
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

        // Bonus was credited per clustered slot in _processPollSlot above, so
        // agg.bonusCredited is now final. Refund the requester the unspent remainder
        // via the single uniform expression. All settlement is storage-only (credits,
        // no external sends), so isComplete is purely the re-entry / double-settle guard.
        _refundRequester(aggId, agg);
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
        // storage pointers: read only the scalar fields touched below, never copying the
        // identity's classes[] array or the response's likelihoods[]/justificationCID.
        ReputationKeeper.OracleIdentity storage id = agg.polledOracles[slot];
        (bool active, , , , , , , , ) = reputationKeeper.getOracleInfo(id.oracle, id.jobId);
        if (!active) {
            emit OracleScoreUpdateSkipped(id.oracle, id.jobId, "Inactive at finalization");
            return (false, 0);
        }

        (bool responded, uint256 respIndex) = _getResponseForSlot(agg.responses, slot);
        if (responded) {
            Response storage resp = agg.responses[respIndex];
            if (resp.selected) {
                (bool found, uint256 sIdx) = _findIndexInArray(selIdx, respIndex);
                if (found) {
                    if (cluster[sIdx] == 1) {
                        try reputationKeeper.updateScores(id.oracle, resp.jobId, clusteredQualityScore, clusteredTimelinessScore) {} catch {
                            emit OracleScoreUpdateSkipped(resp.operator, resp.jobId, "updateScores failed for clustered selected response");
                        }
                        // Bonus credited as ETH to the slot's SNAPSHOTTED payee (the owner
                        // resolved at request time, same recipient as base), using the
                        // SNAPSHOT multiplier (not the live var) so a mid-round change cannot
                        // size the bonus above the reserve. No external call - pure credit.
                        // A clustered slot always resolved its owner at base time, so
                        // payees[slot] is the real, non-zero owner.
                        uint256 bonus = agg.pollFees[slot] * agg.bonusMultiplierSnap;
                        if (bonus > 0) {
                            ethOwed[agg.payees[slot]] += bonus;
                            agg.bonusCredited += bonus;
                            emit BonusPayment(resp.operator, bonus);
                        }
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

    /**
     * @notice Get the current request counter value
     * @dev Used for generating unique aggregator request IDs
     * @return Current request counter value
     */
    function getCurrentRequestCounter() external view returns (uint256) {
        return requestCounter;
    }

    /**
     * @dev Credit the requester the unspent ETH for a settled round and emit the refund
     *      event. The same expression is used on every exit path (success, commit/reveal
     *      timeout): refund = ethReceived - baseCredited - bonusCredited. The B*P*effMaxFee
     *      reserve guarantees bonusCredited <= reserve, so this subtraction never underflows
     *      (docs section 4.5). Pure credit - the requester pulls it via withdrawEth(), or
     *      recycles it into a later request via fund-from-credit.
     */
    function _refundRequester(bytes32 aggId, AggregatedEvaluation storage agg) internal {
        uint256 refund = agg.ethReceived - agg.baseCredited - agg.bonusCredited;
        if (refund > 0) {
            ethOwed[agg.requester] += refund;
            emit RequesterRefunded(aggId, agg.requester, refund);
        }
    }

    /**
     * @dev Get the response for a given poll slot
     */
    // Scans storage by reference (reading only each element's pollIndex slot) rather than
    // deep-copying the whole responses array - including every nested likelihoods[] and
    // justificationCID string - into memory. Called on every reveal and every slot at
    // finalize/timeout, so the storage scan matters.
    function _getResponseForSlot(Response[] storage responses, uint256 slot)
        internal view returns (bool, uint256)
    {
        uint256 len = responses.length;
        for (uint256 i = 0; i < len; i++) {
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
                // commitHashPerSlot == 0 ->  oracle never committed
                shouldPenalise = (agg.commitHashPerSlot[slot] == bytes16(0));
            } else {
                // reveal phase -> penalise only if no reveal received
                (bool responded, ) = _getResponseForSlot(agg.responses, slot);
                shouldPenalise = !responded;
            }

            if (shouldPenalise) {
                // storage pointer: reads only oracle/jobId, not the classes[] array
                ReputationKeeper.OracleIdentity storage id = agg.polledOracles[slot];
                try reputationKeeper.updateScores(id.oracle, id.jobId, committedQualityScore, committedTimelinessScore) { }
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
        // !failed excludes a round that timed out in reveal phase: its aggregatedLikelihoods
        // is the zero-filled scratch array allocated on the first reveal and never populated
        // (population happens only in _finalizeAggregation, which a failed round never runs).
        bool hasValidData = agg.isComplete && !agg.failed && agg.aggregatedLikelihoods.length > 0;
        return (agg.aggregatedLikelihoods, agg.combinedJustificationCIDs, hasValidData);
    }

    /**
     * @notice Phase / lifecycle status for an aggregation (replaces the old public mapping
     *         getter, split out to stay under the ABI-encoder stack limit).
     * @param aggId The aggregator request ID
     */
    function getAggregationStatus(bytes32 aggId)
        external view
        returns (
            bool isComplete,
            bool failed,
            bool commitPhaseComplete,
            uint256 commitExpected,
            uint256 commitReceived,
            uint256 responseCount,
            uint256 requiredN,
            uint256 clusterP,
            address requester,
            uint256 startTimestamp
        )
    {
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        return (
            agg.isComplete,
            agg.failed,
            agg.commitPhaseComplete,
            agg.commitExpected,
            agg.commitReceived,
            agg.responseCount,
            agg.requiredResponses,
            agg.clusterSize,
            agg.requester,
            agg.startTimestamp
        );
    }

    /**
     * @notice ETH escrow accounting for an aggregation (docs section 4.5).
     * @dev `reserved` is the ETH still held against this round and not yet assigned to any
     *      payee. For an OPEN round that is ethReceived - baseCredited - bonusCredited (base
     *      is credited at request; bonus/refund only at settlement). Once the round is
     *      complete the bonus and the refund have both moved into ethOwed, so reserved is 0
     *      (returning the raw difference would double-count the refund, which now lives in
     *      ethOwed[requester]). The global solvency invariant is therefore
     *      address(this).balance == sum(ethOwed) + sum over OPEN aggIds of reserved.
     * @param aggId The aggregator request ID
     */
    function getEthAccounting(bytes32 aggId)
        external view
        returns (
            uint256 ethReceived,
            uint256 baseCredited,
            uint256 bonusCredited,
            uint256 bonusMultiplierSnap,
            uint256 reserved
        )
    {
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        return (
            agg.ethReceived,
            agg.baseCredited,
            agg.bonusCredited,
            agg.bonusMultiplierSnap,
            agg.isComplete ? 0 : (agg.ethReceived - agg.baseCredited - agg.bonusCredited)
        );
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
     * @notice Withdraw LINK tokens from the contract (stuck-token escape hatch)
     * @dev Under 0-juel dispatch the contract holds no routine LINK, so this is vestigial
     *      for normal operation; it is retained only to recover LINK sent here by mistake.
     *      This is NOT the forbidden owner ETH-sweep (docs section 7 step 8) - that ban is
     *      about ETH. A LINK escape hatch is explicitly allowed (docs section 7 step 15).
     * @param _to Address to receive the LINK tokens
     * @param _amount Amount of LINK tokens to withdraw (in wei)
     */
    function withdrawLink(address payable _to, uint256 _amount) external onlyOwner {
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        if (!link.transfer(_to, _amount)) revert LinkTransferFailed();
    }

    // ----------------------------------------------------------------------
    //             ETH PULL-PAYMENT WITHDRAWALS (docs section 4.2)
    // ----------------------------------------------------------------------

    /**
     * @dev Pay out a payee's entire ethOwed balance to the payee. Checks-effects-
     *      interactions: read the balance, zero it, then send. Reverts (restoring the
     *      balance) on send failure rather than burning it, so a reverting/non-payable
     *      recipient only fails its OWN withdrawal in isolation - it cannot block anyone
     *      else, and the funds stay safely credited until the recipient is fixed.
     *      The destination is ALWAYS the credited payee, never a caller-chosen address.
     */
    function _withdrawTo(address payee) internal {
        uint256 amount = ethOwed[payee];
        if (amount == 0) revert NothingOwed();
        ethOwed[payee] = 0;                       // effect before interaction
        (bool ok, ) = payable(payee).call{value: amount}("");
        if (!ok) revert EthTransferFailed();      // revert restores ethOwed[payee]
        emit EthWithdrawn(payee, amount);
    }

    /**
     * @notice Withdraw your own accumulated ETH balance (base/bonus earnings or refunds).
     * @dev Pulls the entire ethOwed[msg.sender] to msg.sender.
     */
    function withdrawEth() external nonReentrant {
        _withdrawTo(msg.sender);
    }

    /**
     * @notice Trigger a payout of `payee`'s balance TO `payee`.
     * @dev Restricted trigger (docs section 4.2): only the payee themselves or the contract
     *      owner may call this, and it always pays the credited payee - never the caller -
     *      so neither can divert funds (the owner can only accelerate a payout to its
     *      rightful owner). After renounceOwnership() owner() is address(0), so only the
     *      payee can trigger. There is deliberately no third-party trigger, so a griefer
     *      cannot force a requester's recyclable credit out of the contract.
     * @param payee The credited address to pay out (also the destination).
     */
    function withdrawEthFor(address payee) external nonReentrant {
        if (msg.sender != payee && msg.sender != owner()) revert NotAuthorized();
        _withdrawTo(payee);
    }

    /**
     * @notice Set a new ReputationKeeper contract address
     * @dev Updates the reputation management contract used for oracle selection and scoring
     * @param newKeeper Address of the new ReputationKeeper contract
     */
    function setReputationKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
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
        if (_k < _m) revert InvalidConfig();
        if (_m < _n) revert InvalidConfig();
        if (_n < _p) revert InvalidConfig();
        // P must be >= 2: AggregatorLib.findBestCluster always seeds a cluster with the
        // closest PAIR, so it returns at least two winners. Allowing P == 1 would reserve
        // bonus for one oracle while two get marked, underflowing the refund (finalize DoS)
        // or paying an extra bonus out of the requester's refund.
        if (_p < 2)  revert InvalidConfig();

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
        if (_m > 20) revert InvalidBonusMultiplier();
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
