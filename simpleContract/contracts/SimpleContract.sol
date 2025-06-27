// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

/**
 * @title SimpleContract
 * @author Verdikta Team
 * @notice Basic single-oracle contract for development and testing purposes
 * @dev Simplified oracle contract that works with a single pre-configured oracle.
 *      Provides the same interface as more complex aggregators for testing compatibility.
 *      Includes automatic bonus payment (1x fee) to oracle upon successful completion.
 */
contract SimpleContract is ChainlinkClient {
    using Chainlink for Chainlink.Request;

    /* ───────────────────────────────── CONFIG ───────────────────────── */
    address  private oracle;
    bytes32  private jobId;
    uint256  public  fee;            // base fee (and bonus size)
    uint64   public  requiredClass;

    uint256 public responseTimeoutSeconds = 300;   // 5-minute window

    /* ──────────────────────────── REQUEST META ──────────────────────── */
    
    /**
     * @notice Metadata for tracking individual evaluation requests
     * @dev Stores request state and payment information for bonus distribution
     */
    struct ReqMeta {
        uint256 started;     /// @dev Timestamp when request was initiated
        bool    done;        /// @dev Whether the request has been completed
        bool    failed;      /// @dev Whether the request failed or timed out
        address requester;   /// @dev Address that requested the evaluation (pays bonus)
    }
    mapping(bytes32 => ReqMeta) private _reqMeta;

    /* ──────────────────────────── EVALUATIONS ───────────────────────── */
    
    /**
     * @notice Complete evaluation result from oracle
     * @dev Stores the final evaluation data returned by the oracle
     */
    struct Evaluation {
        uint256[] likelihoods;      /// @dev Array of likelihood scores (0-100)
        string    justificationCID; /// @dev IPFS CID containing detailed justification
        bool      exists;           /// @dev Whether valid evaluation data exists
    }
    mapping(bytes32 => Evaluation) public evaluations;

    /* ───────────────────────────── CONSTANTS ────────────────────────── */
    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    /* ────────────────────────────── EVENTS ──────────────────────────── */
    
    /// @notice Emitted when a new AI evaluation request is created
    /// @param requestId Unique request identifier
    /// @param cids Array of IPFS CIDs containing evidence to evaluate
    event RequestAIEvaluation (bytes32 indexed requestId, string[] cids);
    
    /// @notice Emitted when an AI evaluation is completed successfully
    /// @param requestId The request identifier
    /// @param likelihoods Final likelihood scores from the oracle
    /// @param justificationCID IPFS CID containing the oracle's justification
    event FulfillAIEvaluation (bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
    
    /// @notice Emitted when fulfillment data is received (debugging event)
    /// @param requestId The request identifier
    /// @param caller Address of the fulfilling oracle
    /// @param len Number of likelihood scores received
    /// @param justificationCID IPFS CID of the justification
    event FulfillmentReceived (bytes32 indexed requestId, address caller, uint256 len, string justificationCID);
    
    /// @notice Emitted when an evaluation fails or times out
    /// @param requestId The request identifier that failed
    event EvaluationFailed    (bytes32 indexed requestId);
    
    /// @notice Emitted when bonus payment is made to the oracle
    /// @param requestId The request identifier
    /// @param oracle Address of the oracle receiving the bonus
    /// @param amount Amount of LINK tokens paid as bonus
    event BonusPaid           (bytes32 indexed requestId, address oracle, uint256 amount);

    /* ──────────────────────────── CONSTRUCTOR ───────────────────────── */
    constructor(
        address _oracle,
        bytes32 _jobId,
        uint256 _fee,
        address _link,
        uint64  _requiredClass
    ) {
        _setChainlinkToken(_link);
        _setChainlinkOracle(_oracle);

        oracle        = _oracle;
        jobId         = _jobId;
        fee           = _fee;
        requiredClass = _requiredClass;
    }

    /* ─────────────────────────── OWNER SETTERS ──────────────────────── */
    function setResponseTimeout(uint256 secs) external /* onlyOwner stub */ {
        require(secs >= 30 && secs <= 1 days, "timeout 30s to 1d");
        responseTimeoutSeconds = secs;
    }

    /* ───────────────────────────── REQUEST ──────────────────────────── */
    
    /**
     * @notice Request AI evaluation with pre-configured oracle
     * @dev Main entry point for requesting AI evaluation. User must approve 2x LINK (base + bonus).
     *      Many parameters are ignored for simplicity compared to aggregator contracts.
     * @param cids Array of IPFS CIDs containing evidence/data to evaluate
     * @param addendumText Additional text to append to the evaluation request
     * @param _requestedClass Oracle class required (must match contract's requiredClass)
     * @return requestId Unique request ID for tracking the evaluation
     */
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string   memory addendumText,
        uint256, uint256, uint256, uint256,      /* ignored */
        uint64   _requestedClass
    ) external returns (bytes32 requestId)
    {
        require(_requestedClass == requiredClass, "class mismatch");
        require(cids.length > 0 && cids.length <= MAX_CID_COUNT, "CID count");
        for (uint256 i = 0; i < cids.length; ++i)
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID len");
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "addendum len");

        /* pull LINK for the base fee (bonus is pulled later only if succeed) */
        LinkTokenInterface(_chainlinkTokenAddress())
            .transferFrom(msg.sender, address(this), fee);

        /* build CID string */
        bytes memory concat;
        for (uint256 i = 0; i < cids.length; ++i)
            concat = abi.encodePacked(concat, cids[i], i < cids.length - 1 ? "," : "");
        string memory cidStr = string(concat);
        if (bytes(addendumText).length > 0)
            cidStr = string(abi.encodePacked(cidStr, ":", addendumText));

        /* send Chainlink request */
        Chainlink.Request memory req =
            _buildChainlinkRequest(jobId, address(this), this.fulfill.selector);
        req._add("cid", cidStr);

        requestId = _sendChainlinkRequest(req, fee);

        /* record meta for timeout / bonus */
        _reqMeta[requestId] = ReqMeta({
            started:   block.timestamp,
            done:      false,
            failed:    false,
            requester: msg.sender
        });

        emit RequestAIEvaluation(requestId, cids);
    }

    /* ─────────────────────────── FULFILLMENT ────────────────────────── */
    
    /**
     * @notice Callback function called by the oracle with evaluation results
     * @dev Stores results and automatically pays bonus to oracle upon completion
     * @param _requestId The Chainlink request ID
     * @param likelihoods Array of likelihood scores from the oracle
     * @param justificationCID IPFS CID containing the oracle's justification
     */
    function fulfill(
        bytes32   _requestId,
        uint256[] calldata likelihoods,
        string    calldata justificationCID
    ) external recordChainlinkFulfillment(_requestId)
    {
        ReqMeta storage m = _reqMeta[_requestId];
        require(!m.done, "already closed");   // protect against duplicates
        m.done = true;

        emit FulfillmentReceived(_requestId, msg.sender, likelihoods.length, justificationCID);

        require(likelihoods.length > 0,             "empty likelihoods");
        require(bytes(justificationCID).length > 0, "empty CID");

        /* store evaluation */
        evaluations[_requestId] = Evaluation({
            likelihoods:      likelihoods,
            justificationCID: justificationCID,
            exists:           true
        });

        /* bonus: pull another `fee` from requester and pay oracle */
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        require(
            link.transferFrom(m.requester, msg.sender, fee),
            "bonus LINK xferFrom failed"
        );
        emit BonusPaid(_requestId, msg.sender, fee);

        emit FulfillAIEvaluation(_requestId, likelihoods, justificationCID);
    }

    /* ───────────────────────────── TIMEOUT ──────────────────────────── */
    
    /**
     * @notice Finalize an evaluation that has timed out
     * @dev Can be called by anyone to finalize evaluations that have exceeded responseTimeoutSeconds
     * @param requestId The request ID to finalize
     */
    function finalizeEvaluationTimeout(bytes32 requestId) external {
        ReqMeta storage m = _reqMeta[requestId];

        require(!m.done, "already complete");
        require(block.timestamp >= m.started + responseTimeoutSeconds,
                "not timed-out");

        m.done   = true;
        m.failed = true;

        emit EvaluationFailed(requestId);
    }

    /**
     * @notice Check if an evaluation has failed
     * @dev Returns true if the evaluation timed out or failed for other reasons
     * @param requestId The request ID to check
     * @return bool True if the evaluation failed, false otherwise
     */
    function isFailed(bytes32 requestId) external view returns (bool) {
        return _reqMeta[requestId].failed;
    }

    /* ───────────────────────── VIEW & ADMIN HELPERS ─────────────────── */
    
    /**
     * @notice Calculate the maximum total LINK required including bonus payment
     * @dev Returns 2x the base fee (base fee + bonus payment)
     * @return Maximum total LINK required for evaluation with bonus
     */
    function maxTotalFee(uint256) external view returns (uint256) {
        /* user must approve base fee + potential bonus = 2 * fee */
        return fee * 2;
    }

    /**
     * @notice Get contract configuration information
     * @dev Returns oracle address, LINK token, job ID, and current fee
     * @return oracleAddr Address of the configured oracle
     * @return linkAddr Address of the LINK token contract
     * @return jId Job ID for the oracle
     * @return currentFee Current fee amount in LINK wei
     */
    function getContractConfig()
        external
        view
        returns (address oracleAddr, address linkAddr, bytes32 jId, uint256 currentFee)
    {
        return (oracle, _chainlinkTokenAddress(), jobId, fee);
    }

    /**
     * @notice Get the evaluation results for a completed request
     * @dev Returns the likelihood scores and justification from the oracle
     * @param id The request ID
     * @return likelihoods Array of likelihood scores (0-100)
     * @return cid IPFS CID containing the justification
     * @return exists Whether valid evaluation data exists for this request
     */
    function getEvaluation(bytes32 id)
        external
        view
        returns (uint256[] memory likelihoods, string memory cid, bool exists)
    {
        Evaluation storage ev = evaluations[id];
        return (ev.likelihoods, ev.justificationCID, ev.exists);
    }

    /**
     * @notice Withdraw LINK tokens from the contract
     * @dev Emergency function for recovering LINK tokens (no access control in test contract)
     * @param to Address to receive the LINK tokens
     * @param amount Amount of LINK tokens to withdraw (in wei)
     */
    function withdrawLink(address payable to, uint256 amount) external /* onlyOwner stub */ {
        LinkTokenInterface(_chainlinkTokenAddress()).transfer(to, amount);
    }
}

