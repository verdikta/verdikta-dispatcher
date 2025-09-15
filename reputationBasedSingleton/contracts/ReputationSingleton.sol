// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IReputationKeeper.sol";

/**
 * @title ReputationSingleton
 * @author Verdikta Team
 * @notice Minimal single-oracle version of the reputation aggregator for fast evaluations
 * @dev Simplified aggregator that selects one oracle for quick AI evaluations.
 *      Provides front-end compatibility with multi-oracle aggregator interface.
 *      Includes automatic bonus payment (1x fee) to oracle upon successful completion.
 */
contract ReputationSingleton is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    /* ───────────────────────────── CONFIG ─────────────────────────── */
    uint256 public alpha  = 500;      // 0-1000 reputation weight
    uint256 public maxOracleFee;      // ceiling when selecting an oracle
    uint256 public responseTimeoutSeconds = 300; // 5 minutes
    uint256 public baseFeePct = 1;    // % of maxOracleFee used as floor
    uint256 public maxFeeBasedScalingFactor = 10;

    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    IReputationKeeper public reputationKeeper;

    /* ────────────────────────── REQUEST META ──────────────────────── */
    
    /**
     * @notice Metadata for tracking individual evaluation requests
     * @dev Stores request state and payment information for bonus distribution
     */
    struct ReqMeta {
        uint256 started;     /// @dev Timestamp when request was initiated
        bool    done;        /// @dev Whether the request has been completed
        bool    failed;      /// @dev Whether the request failed or timed out
        address requester;   /// @dev Address that requested the evaluation (pays bonus)
        address oracle;      /// @dev Address of selected oracle (receives bonus)
        uint256 feeUsed;     /// @dev Fee amount paid, reused for bonus calculation
    }
    mapping(bytes32 => ReqMeta) private _reqMeta;

    /* ─────────────────────────── STORAGE FOR UI ───────────────────── */
    mapping(bytes32 => uint256[]) public likelihoodByRequest;
    mapping(bytes32 => string)    public justificationByRequest;

    /* ───────────────────────────── EVENTS ─────────────────────────── */
    
    /// @notice Emitted when a new single-oracle AI evaluation request is created
    /// @param requestId Unique request identifier
    /// @param cids Array of IPFS CIDs containing evidence to evaluate
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
    
    /// @notice Emitted when an AI evaluation is completed successfully
    /// @param requestId The request identifier
    /// @param likelihoods Final likelihood scores from the oracle
    /// @param justificationCID IPFS CID containing the oracle's justification
    event EvaluationFulfilled(bytes32 indexed requestId,
                              uint256[] likelihoods, string justificationCID);
    
    /// @notice Emitted when an evaluation fails or times out
    /// @param requestId The request identifier that failed
    event EvaluationFailed(bytes32 indexed requestId);
    
    /// @notice Emitted when bonus payment is made to the oracle
    /// @param requestId The request identifier
    /// @param oracle Address of the oracle receiving the bonus
    /// @param amount Amount of LINK tokens paid as bonus
    event BonusPaid(bytes32 indexed requestId, address oracle, uint256 amount);

    /* ────────────────────────── CONSTRUCTOR ───────────────────────── */
    constructor(address _link, address _reputationKeeper) Ownable(msg.sender) {
        require(_reputationKeeper != address(0), "Keeper zero");
        _setChainlinkToken(_link);
        reputationKeeper = IReputationKeeper(_reputationKeeper);
        maxOracleFee = 0.1 * 1e18; // 0.1 LINK default
    }

    /* ───────────────────────── OWNER SETTERS ──────────────────────── */
    
    /**
     * @notice Set the reputation weight factor for oracle selection
     * @dev Alpha determines how much reputation influences oracle selection (0-1000)
     * @param _a Reputation weight factor (0-1000, where 1000 = 100% reputation-based)
     */
    function setAlpha(uint256 _a) external onlyOwner { require(_a<=1000); alpha=_a; }
    
    /**
     * @notice Get the current reputation weight factor
     * @dev Returns the alpha value used for oracle selection
     * @return Current alpha value (0-1000)
     */
    function getAlpha() external view returns (uint256){return alpha;}
    
    /**
     * @notice Set the maximum oracle fee for selection
     * @dev Limits the maximum fee that can be paid to any oracle
     * @param f Maximum oracle fee in LINK wei
     */
    function setMaxOracleFee(uint256 f) external onlyOwner { maxOracleFee=f; }
    
    /**
     * @notice Set the base fee percentage for oracle selection
     * @dev Base fee is used as minimum cost estimate (1-100%)
     * @param p Base fee percentage (1-100)
     */
    function setBaseFeePct(uint256 p) external onlyOwner { require(p>=1&&p<=100); baseFeePct=p; }
    
    /**
     * @notice Set the maximum fee-based scaling factor
     * @dev Controls how much fee differences affect oracle selection
     * @param f Maximum scaling factor (must be >= 1)
     */
    function setMaxFeeBasedScalingFactor(uint256 f) external onlyOwner { require(f>=1); maxFeeBasedScalingFactor=f; }
    
    /**
     * @notice Set the Chainlink token address
     * @dev Updates the LINK token contract used for payments
     * @param a Address of the LINK token contract
     */
    function setChainlinkToken(address a) external onlyOwner { _setChainlinkToken(a); }
    
    /**
     * @notice Set the ReputationKeeper contract address
     * @dev Updates the reputation management contract used for oracle selection
     * @param a Address of the ReputationKeeper contract
     */
    function setReputationKeeper(address a) external onlyOwner { require(a!=address(0)); reputationKeeper=IReputationKeeper(a);}
    
    /**
     * @notice Set the response timeout for evaluations
     * @dev Timeout duration after which evaluations can be marked as failed
     * @param s Timeout duration in seconds (30 seconds to 1 day)
     */
    function setResponseTimeout(uint256 s) external onlyOwner { require(s>=30&&s<=1 days); responseTimeoutSeconds=s; }

    /* ─────────────────────── FEE HELPERS ──────────────────────────── */
    
    /**
     * @notice Calculate the maximum total LINK required including bonus payment
     * @dev Returns 2x the effective fee (base fee + bonus payment)
     * @param requested Requested maximum fee per oracle
     * @return Maximum total LINK required for evaluation with bonus
     */
    function maxTotalFee(uint256 requested) public view returns (uint256) {
        uint256 eff = requested < maxOracleFee ? requested : maxOracleFee;
        /* user must approve base + bonus = 2×fee */
        return eff * 2;
    }
    
    /**
     * @notice Get the estimated base cost for oracle evaluation
     * @dev Calculates base cost as percentage of maximum oracle fee
     * @return Estimated base cost in LINK wei
     */
    function getEstimatedBaseCost() public view returns (uint256) {
        return (maxOracleFee * baseFeePct) / 100;
    }

    /* ───────────────────────── REQUEST ENTRY ──────────────────────── */
    
    /**
     * @notice Request AI evaluation with user-funded LINK payment (single oracle)
     * @dev Main entry point for requesting single-oracle AI evaluation.
     *      User must approve 2x LINK tokens (base fee + bonus) before calling.
     * @param cids Array of IPFS CIDs containing evidence/data to evaluate
     * @param addendumText Additional text to append to the evaluation request
     * @param _alpha Reputation weight factor for oracle selection (0-1000)
     * @param _maxOracleFee Maximum fee per oracle in LINK wei
     * @param _estimatedBaseCost Estimated base cost for evaluation
     * @param _maxFeeBasedScalingFactor Maximum scaling factor for fee-based selection
     * @param _requestedClass Oracle class/category requested for evaluation
     * @return requestId Unique request ID for tracking the evaluation
     */
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string   calldata addendumText,
        uint256  _alpha,
        uint256  _maxOracleFee,
        uint256  _estimatedBaseCost,
        uint256  _maxFeeBasedScalingFactor,
        uint64   _requestedClass
    ) external nonReentrant returns (bytes32 requestId) {
        require(address(reputationKeeper)!=address(0), "Keeper not set");
        require(cids.length>0 && cids.length<=MAX_CID_COUNT, "CID count");
        for(uint256 i; i<cids.length;i++) require(bytes(cids[i]).length<=MAX_CID_LENGTH,"CID len");
        require(bytes(addendumText).length<=MAX_ADDENDUM_LENGTH,"Addendum len");

        /* payload "0:cid1,cid2[:addendum]" */
        bytes memory buf;
        for(uint256 i;i<cids.length;i++) buf=abi.encodePacked(buf,cids[i],i<cids.length-1?",":"");
        if(bytes(addendumText).length>0) buf=abi.encodePacked(buf,":",addendumText);
        string memory payload = string(abi.encodePacked("0:",buf));

        requestId = _singletonRequest(
            payload,_alpha,_maxOracleFee,_estimatedBaseCost,_maxFeeBasedScalingFactor,_requestedClass
        );
        emit RequestAIEvaluation(requestId,cids);
    }

    /* ─────────────────────── INTERNAL DISPATCH ────────────────────── */
    function _singletonRequest(
        string memory payload,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64  _requestedClass
    ) internal returns (bytes32) {
        /* 1. oracle selection */
        IReputationKeeper.OracleIdentity[] memory chosen =
            reputationKeeper.selectOracles(
                1,_alpha,_maxOracleFee,_estimatedBaseCost,_maxFeeBasedScalingFactor,_requestedClass);
        reputationKeeper.recordUsedOracles(chosen);

        /* 2️⃣. ask the keeper for that oracle’s registered fee */
        ( /*active*/, , , , , uint256 oracleFee, , , ) =
              reputationKeeper.getOracleInfo(chosen[0].oracle, chosen[0].jobId);

        /* 3. pull base fee */
        require(LinkTokenInterface(_chainlinkTokenAddress())
                .transferFrom(msg.sender,address(this),oracleFee),"LINK pull failed");

        /* 4. send request */
        Chainlink.Request memory req =
            _buildChainlinkRequest(chosen[0].jobId, address(this), this.fulfill.selector);
        req._add("cid",payload);
        bytes32 reqId = _sendChainlinkRequestTo(chosen[0].oracle,req,oracleFee);

        /* 5. record meta */
        _reqMeta[reqId]=ReqMeta({
            started:   block.timestamp,
            done:      false,
            failed:    false,
            requester: msg.sender,
            oracle:    chosen[0].oracle,
            feeUsed:   oracleFee
        });
        return reqId;
    }

    /* ─────────────────────────── FULFILL ──────────────────────────── */
    
    /**
     * @notice Callback function called by the selected oracle with evaluation results
     * @dev Stores results and automatically pays bonus to oracle upon completion
     * @param requestId The Chainlink request ID
     * @param likelihoods Array of likelihood scores from the oracle
     * @param justificationCID IPFS CID containing the oracle's justification
     */
    function fulfill(bytes32 requestId,
                     uint256[] calldata likelihoods,
                     string    calldata justificationCID)
        public
        recordChainlinkFulfillment(requestId)
    {
        ReqMeta storage m=_reqMeta[requestId];
        require(!m.done,"closed");
        m.done=true;

        likelihoodByRequest[requestId]=likelihoods;
        justificationByRequest[requestId]=justificationCID;

        /* pay bonus = fee from requester to oracle */
        LinkTokenInterface link=LinkTokenInterface(_chainlinkTokenAddress());
        require(link.transferFrom(m.requester,m.oracle,m.feeUsed),"bonus xferFrom failed");
        emit BonusPaid(requestId,m.oracle,m.feeUsed);

        emit EvaluationFulfilled(requestId,likelihoods,justificationCID);
    }

    /* ─────────────────────────── TIMEOUT ──────────────────────────── */
    
    /**
     * @notice Finalize an evaluation that has timed out
     * @dev Can be called by anyone to finalize evaluations that have exceeded responseTimeoutSeconds
     * @param requestId The request ID to finalize
     */
    function finalizeEvaluationTimeout(bytes32 requestId) external nonReentrant {
        ReqMeta storage m=_reqMeta[requestId];
        require(!m.done,"complete");
        require(block.timestamp>=m.started+responseTimeoutSeconds,"not timed-out");
        m.done=true; m.failed=true;
        emit EvaluationFailed(requestId);
    }
    
    /**
     * @notice Check if an evaluation has failed
     * @dev Returns true if the evaluation timed out or failed for other reasons
     * @param requestId The request ID to check
     * @return bool True if the evaluation failed, false otherwise
     */
    function isFailed(bytes32 requestId) external view returns(bool){return _reqMeta[requestId].failed;}

    /* ───────────────────── FRONT-END HELPERS ──────────────────────── */
    
    /**
     * @notice Get the evaluation results for a completed request
     * @dev Returns the likelihood scores and justification from the oracle
     * @param id The request ID
     * @return l Array of likelihood scores (0-100)
     * @return j IPFS CID containing the justification
     * @return exists Whether valid evaluation data exists for this request
     */
    function getEvaluation(bytes32 id)
        external view
        returns (uint256[] memory l,string memory j,bool exists)
    {
        l=likelihoodByRequest[id]; j=justificationByRequest[id];
        exists=l.length>0||bytes(j).length>0;
    }
    
    /**
     * @notice Get contract configuration (legacy interface for compatibility)
     * @dev Returns basic contract configuration for front-end compatibility
     * @return oracleAddr Placeholder oracle address (always returns zero)
     * @return linkAddr Address of the LINK token contract
     * @return jobId Placeholder job ID (always returns zero)
     * @return fee Placeholder fee (always returns zero)
     */
    function getContractConfig()
        external view
        returns (address oracleAddr,address linkAddr,bytes32 jobId,uint256 fee)
    {
        return (address(0),_chainlinkTokenAddress(),bytes32(0),0);
    }
    
    /**
     * @notice Withdraw LINK tokens from the contract
     * @dev Only callable by contract owner for emergency recovery
     * @param to Address to receive the LINK tokens
     * @param amount Amount of LINK tokens to withdraw (in wei)
     */
    function withdrawLink(address payable to,uint256 amount) external onlyOwner {
        LinkTokenInterface(_chainlinkTokenAddress()).transfer(to,amount);
    }
}

