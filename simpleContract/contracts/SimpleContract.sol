// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

contract SimpleContract is ChainlinkClient {
    using Chainlink for Chainlink.Request;

    /* ───────────────────────────────── CONFIG ───────────────────────── */
    address  private oracle;
    bytes32  private jobId;
    uint256  public  fee;            // base fee (and bonus size)
    uint64   public  requiredClass;

    uint256 public responseTimeoutSeconds = 300;   // 5-minute window

    /* ──────────────────────────── REQUEST META ──────────────────────── */
    struct ReqMeta {
        uint256 started;
        bool    done;
        bool    failed;
        address requester;   // who pays the bonus
    }
    mapping(bytes32 => ReqMeta) private _reqMeta;

    /* ──────────────────────────── EVALUATIONS ───────────────────────── */
    struct Evaluation {
        uint256[] likelihoods;
        string    justificationCID;
        bool      exists;
    }
    mapping(bytes32 => Evaluation) public evaluations;

    /* ───────────────────────────── CONSTANTS ────────────────────────── */
    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    /* ────────────────────────────── EVENTS ──────────────────────────── */
    event RequestAIEvaluation (bytes32 indexed requestId, string[] cids);
    event FulfillAIEvaluation (bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
    event FulfillmentReceived (bytes32 indexed requestId, address caller, uint256 len, string justificationCID);
    event EvaluationFailed    (bytes32 indexed requestId);
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
    function finalizeEvaluationTimeout(bytes32 requestId) external {
        ReqMeta storage m = _reqMeta[requestId];

        require(!m.done, "already complete");
        require(block.timestamp >= m.started + responseTimeoutSeconds,
                "not timed-out");

        m.done   = true;
        m.failed = true;

        emit EvaluationFailed(requestId);
    }

    function isFailed(bytes32 requestId) external view returns (bool) {
        return _reqMeta[requestId].failed;
    }

    /* ───────────────────────── VIEW & ADMIN HELPERS ─────────────────── */
    function maxTotalFee(uint256) external view returns (uint256) {
        /* user must approve base fee + potential bonus = 2 * fee */
        return fee * 2;
    }

    function getContractConfig()
        external
        view
        returns (address oracleAddr, address linkAddr, bytes32 jId, uint256 currentFee)
    {
        return (oracle, _chainlinkTokenAddress(), jobId, fee);
    }

    function getEvaluation(bytes32 id)
        external
        view
        returns (uint256[] memory likelihoods, string memory cid, bool exists)
    {
        Evaluation storage ev = evaluations[id];
        return (ev.likelihoods, ev.justificationCID, ev.exists);
    }

    function withdrawLink(address payable to, uint256 amount) external /* onlyOwner stub */ {
        LinkTokenInterface(_chainlinkTokenAddress()).transfer(to, amount);
    }
}

