// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IReputationKeeper.sol";

/*
 * ReputationSingleton
 * -------------------
 * Minimal one-oracle version of the reputation aggregator.  Frontend
 * compatibility: exposes `getEvaluation()` (like the multi-oracle
 * Aggregator) and names the outputs of `getContractConfig()` so the dApp
 * can read `.linkAddr` directly.
 */
contract ReputationSingleton is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    // Configuration
    uint256 public alpha  = 500;   // 0-1000 reputation weight
    uint256 public maxOracleFee;   // LINK-wei ceiling when selecting an oracle
    uint256 public responseTimeoutSeconds = 300;   // 5 min
    uint256 public baseFeePct = 1; // 1 percent of maxOracleFee used as floor
    uint256 public maxFeeBasedScalingFactor = 10;

    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    IReputationKeeper public reputationKeeper;

    struct ReqMeta {
        uint256 started;   // block.timestamp when request sent
        bool    done;      // set true in fulfill() or on failure
        bool    failed;    // true - timed-out without a response
    }

    mapping(bytes32 => ReqMeta) private _reqMeta;

    // Events
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
    event EvaluationFulfilled(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
    event EvaluationFailed(bytes32 indexed requestId);

    // Simple result storage so `getEvaluation()` works for the UI
    mapping(bytes32 => uint256[]) public likelihoodByRequest;
    mapping(bytes32 => string)    public justificationByRequest;

    // Constructor
    constructor(address _link, address _reputationKeeper) Ownable(msg.sender) {
        require(_reputationKeeper != address(0), "Keeper zero");
        _setChainlinkToken(_link);
        reputationKeeper = IReputationKeeper(_reputationKeeper);
        maxOracleFee = 0.1 * 10 ** 18; // 0.1 LINK by default
    }

    // Config setters / getters (same interface as Aggregator)
    function setAlpha(uint256 _alpha) external onlyOwner {
        require(_alpha <= 1000, "Alpha must be <= 1000");
        alpha = _alpha;
    }
    function getAlpha() external view returns (uint256) { return alpha; }

    function setMaxOracleFee(uint256 _fee) external onlyOwner { maxOracleFee = _fee; }

    function setBaseFeePct(uint256 _pct) external onlyOwner {
        require(_pct >= 1 && _pct <= 100, "Pct 1-100");
        baseFeePct = _pct;
    }

    function setMaxFeeBasedScalingFactor(uint256 _f) external onlyOwner {
        require(_f >= 1, "Factor must be >= 1");
        maxFeeBasedScalingFactor = _f;
    }

    function setChainlinkToken(address _link) external onlyOwner { _setChainlinkToken(_link); }

    function setReputationKeeper(address _rk) external onlyOwner {
        require(_rk != address(0), "Keeper zero");
        reputationKeeper = IReputationKeeper(_rk);
    }

    // Fee helpers
    function maxTotalFee(uint256 requested) public view returns (uint256) {
        uint256 eff = requested < maxOracleFee ? requested : maxOracleFee;
        return eff; // single oracle
    }

    function getEstimatedBaseCost() public view returns (uint256) {
        return (maxOracleFee * baseFeePct) / 100;
    }

    function setResponseTimeout(uint256 secs) external onlyOwner {
        require(secs >= 30 && secs <= 1 days, "timeout 30s to 1d");
        responseTimeoutSeconds = secs;
    }

    // Public request entry point
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string   calldata addendumText,
        uint256  _alpha,
        uint256  _maxOracleFee,
        uint256  _estimatedBaseCost,
        uint256  _maxFeeBasedScalingFactor,
        uint64   _requestedClass
    ) external nonReentrant returns (bytes32 requestId) {
        require(address(reputationKeeper) != address(0), "Keeper not set");
        require(cids.length > 0 && cids.length <= MAX_CID_COUNT, "Bad CID count");
        for (uint256 i = 0; i < cids.length; i++) require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID long");
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "Addendum long");

        // Build payload "0:cid1,cid2,...[:addendum]"
        bytes memory buf;
        for (uint256 i = 0; i < cids.length; i++) buf = abi.encodePacked(buf, cids[i], i < cids.length - 1 ? "," : "");
        if (bytes(addendumText).length > 0) buf = abi.encodePacked(buf, ":", addendumText);
        string memory payload = string(abi.encodePacked("0:", buf)); // mode 0

        requestId = _singletonRequest(payload, _alpha, _maxOracleFee, _estimatedBaseCost, _maxFeeBasedScalingFactor, _requestedClass);
        emit RequestAIEvaluation(requestId, cids);
    }

    // Internal: select oracle + send request
    function _singletonRequest(
        string  memory payload,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64  _requestedClass
    ) internal returns (bytes32) {
        // 1) ask the keeper for exactly one oracle
        IReputationKeeper.OracleIdentity[] memory chosen = reputationKeeper.selectOracles(
            1,
            _alpha,
            _maxOracleFee,
            _estimatedBaseCost,
            _maxFeeBasedScalingFactor,
            _requestedClass
        );
        reputationKeeper.recordUsedOracles(chosen);

        // 2) build and send operator request (fee = _maxOracleFee)
        require(LinkTokenInterface(_chainlinkTokenAddress()).transferFrom(msg.sender, address(this), _maxOracleFee), "LINK pull failed");
        Chainlink.Request memory req = _buildOperatorRequest(chosen[0].jobId, this.fulfill.selector);
        req._add("cid", payload);

        bytes32 reqId = _sendOperatorRequestTo(chosen[0].oracle, req, _maxOracleFee);

        _reqMeta[reqId] = ReqMeta({
            started: block.timestamp,
            done:    false,
            failed:  false
        });

        return reqId;
    }

    // Chainlink callback
    function fulfill(bytes32 requestId, uint256[] calldata likelihoods, string calldata justificationCID)
        public
        recordChainlinkFulfillment(requestId)
    {
        _reqMeta[requestId].done = true;
        likelihoodByRequest[requestId]    = likelihoods;
        justificationByRequest[requestId] = justificationCID;
        emit EvaluationFulfilled(requestId, likelihoods, justificationCID);
    }

    /// Anyone can close a request that missed the deadline.
    /// Never reverts once time has elapsed.
    function finalizeEvaluationTimeout(bytes32 requestId) external nonReentrant {
        ReqMeta storage m = _reqMeta[requestId];

        require(!m.done, "already complete");
        require(block.timestamp >= m.started + responseTimeoutSeconds,
                "not timed-out");

        m.done   = true;
        m.failed = true;

        emit EvaluationFailed(requestId);
    }

    // Frontend helpers
    function getEvaluation(bytes32 requestId) external view returns (uint256[] memory, string memory, bool) {
        uint256[] memory l = likelihoodByRequest[requestId];
        string   memory j = justificationByRequest[requestId];
        bool exists = l.length > 0 || bytes(j).length > 0;
        return (l, j, exists);
    }

    function isFailed(bytes32 requestId) external view returns (bool) {
        return _reqMeta[requestId].failed;
    }

    // Named outputs so ethers v6 adds properties like .linkAddr
    function getContractConfig() external view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 fee) {
        return (address(0), _chainlinkTokenAddress(), bytes32(0), 0);
    }

    function withdrawLink(address payable to, uint256 amount) external onlyOwner {
        require(LinkTokenInterface(_chainlinkTokenAddress()).transfer(to, amount), "withdraw failed");
    }
}

