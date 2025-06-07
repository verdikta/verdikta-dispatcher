// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

contract SimpleContract is ChainlinkClient {
    using Chainlink for Chainlink.Request;

    /* ────────────────────────────────────────────────────────────────
                                   CONFIG
       ────────────────────────────────────────────────────────────────*/
    address  private oracle;
    bytes32  private jobId;
    uint256  private fee;
    uint64   public  requiredClass;

    // timeout window (shared interface with the aggregator contracts)
    uint256 public responseTimeoutSeconds = 300;            // 5 minutes

    /* ────────────────────────────────────────────────────────────────
                              REQUEST METADATA
       ────────────────────────────────────────────────────────────────*/
    struct ReqMeta {
        uint256 started;   // timestamp when Chainlink request sent
        bool    done;      // set true by fulfill() or by timeout
        bool    failed;    // true ⇢ timed-out without a response
    }
    mapping(bytes32 => ReqMeta) private _reqMeta;

    /* ────────────────────────────────────────────────────────────────
                                EVALUATIONS
       ────────────────────────────────────────────────────────────────*/
    struct Evaluation {
        uint256[] likelihoods;
        string    justificationCID;
        bool      exists;
    }
    mapping(bytes32 => Evaluation) public evaluations;

    /* ────────────────────────────────────────────────────────────────
                                CONSTANTS
       ────────────────────────────────────────────────────────────────*/
    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    /* ────────────────────────────────────────────────────────────────
                                  EVENTS
       ────────────────────────────────────────────────────────────────*/
    event RequestAIEvaluation (bytes32 indexed requestId, string[] cids);
    event FulfillAIEvaluation (bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
    event FulfillmentReceived (bytes32 indexed requestId, address caller, uint256 len, string justificationCID);
    event EvaluationFailed    (bytes32 indexed requestId);

    /* ────────────────────────────────────────────────────────────────
                                CONSTRUCTOR
       ────────────────────────────────────────────────────────────────*/
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

    /* ────────────────────────────────────────────────────────────────
                              OWNER SETTERS
       ────────────────────────────────────────────────────────────────*/
    function setResponseTimeout(uint256 secs) external {
        require(msg.sender == address(this) || tx.origin == address(0), "only owner"); // minimal-ownable stub
        require(secs >= 30 && secs <= 1 days, "timeout 30s to 1d");
        responseTimeoutSeconds = secs;
    }

    /* ────────────────────────────────────────────────────────────────
                                 REQUEST
       ────────────────────────────────────────────────────────────────*/
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string   memory addendumText,
        uint256, uint256, uint256, uint256,   /* ignored extra params */
        uint64   _requestedClass
    ) external returns (bytes32 requestId)
    {
        require(_requestedClass == requiredClass, "class mismatch");
        require(cids.length > 0 && cids.length <= MAX_CID_COUNT, "CID count");
        for (uint256 i = 0; i < cids.length; ++i)
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID len");
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "addendum len");

        /* pull LINK from caller */
        LinkTokenInterface(_chainlinkTokenAddress())
            .transferFrom(msg.sender, address(this), fee);

        /* build calldata string "cid1,cid2[:addendum]" */
        bytes memory concat;
        for (uint256 i = 0; i < cids.length; ++i)
            concat = abi.encodePacked(concat, cids[i], i < cids.length - 1 ? "," : "");
        string memory cidStr = string(concat);
        if (bytes(addendumText).length > 0)
            cidStr = string(abi.encodePacked(cidStr, ":", addendumText));

        /* send request */
        Chainlink.Request memory req =
            _buildChainlinkRequest(jobId, address(this), this.fulfill.selector);
        req._add("cid", cidStr);

        requestId = _sendChainlinkRequest(req, fee);

        /* record for timeout handling */
        _reqMeta[requestId] = ReqMeta({
            started: block.timestamp,
            done:    false,
            failed:  false
        });

        emit RequestAIEvaluation(requestId, cids);
    }

    /* ────────────────────────────────────────────────────────────────
                               FULFILLMENT
       ────────────────────────────────────────────────────────────────*/
    function fulfill(
        bytes32   _requestId,
        uint256[] calldata likelihoods,
        string    calldata justificationCID
    ) external recordChainlinkFulfillment(_requestId)
    {
        _reqMeta[_requestId].done = true;   // mark success

        emit FulfillmentReceived(_requestId, msg.sender, likelihoods.length, justificationCID);

        require(likelihoods.length > 0,             "empty likelihoods");
        require(bytes(justificationCID).length > 0, "empty CID");

        evaluations[_requestId] = Evaluation({
            likelihoods:      likelihoods,
            justificationCID: justificationCID,
            exists:           true
        });

        emit FulfillAIEvaluation(_requestId, likelihoods, justificationCID);
    }

    /* ────────────────────────────────────────────────────────────────
                                  TIMEOUT
       ────────────────────────────────────────────────────────────────*/
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

    /* ────────────────────────────────────────────────────────────────
                           VIEW & ADMIN HELPERS
       ────────────────────────────────────────────────────────────────*/
    function maxTotalFee(uint256) external view returns (uint256) { return fee; }

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

    function withdrawLink(address payable to, uint256 amount) external {
        require(msg.sender == address(this) || tx.origin == address(0), "only owner"); // minimal-ownable stub
        LinkTokenInterface(_chainlinkTokenAddress()).transfer(to, amount);
    }
}

