// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

contract SimpleContract is ChainlinkClient {
    using Chainlink for Chainlink.Request;

    address  private oracle;
    bytes32  private jobId;
    uint256  private fee;

    uint64   public requiredClass;

    struct Evaluation {
        uint256[] likelihoods;
        string    justificationCID;
        bool      exists;
    }
    mapping(bytes32 => Evaluation) public evaluations;

    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    event RequestAIEvaluation (bytes32 indexed requestId, string[] cids);
    event FulfillAIEvaluation (bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
    event FulfillmentReceived(bytes32 indexed requestId, address caller, uint256 len, string justificationCID);

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

    /* -------------------------------------------------------------------- */
    /* --------------------------   request   ----------------------------- */
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string   memory addendumText,
        uint256, uint256, uint256, uint256,       /* ignored extra params */
        uint64   _requestedClass
    ) external returns (bytes32 requestId)
    {
        require(_requestedClass == requiredClass, "class mismatch");
        require(cids.length > 0 && cids.length <= MAX_CID_COUNT, "CID count");
        for (uint256 i = 0; i < cids.length; ++i) {
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID len");
        }
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "addendum len");

        // pull LINK from caller
        LinkTokenInterface(_chainlinkTokenAddress())
            .transferFrom(msg.sender, address(this), fee);

        // build request (internal helper)
        Chainlink.Request memory req =
            _buildChainlinkRequest(jobId, address(this), this.fulfill.selector);

        // concat CIDs + optional addendum
        bytes memory concat;
        for (uint256 i = 0; i < cids.length; ++i) {
            concat = abi.encodePacked(concat, cids[i], i < cids.length - 1 ? "," : "");
        }
        string memory cidStr = string(concat);
        if (bytes(addendumText).length > 0)
            cidStr = string(abi.encodePacked(cidStr, ":", addendumText));

        req._add("cid", cidStr);

        // pay LINK + trigger operator
        requestId = _sendChainlinkRequest(req, fee);
        emit RequestAIEvaluation(requestId, cids);
    }

    /* -------------------------------------------------------------------- */
    /* -------------------------  fulfillment  ---------------------------- */
    function fulfill(
        bytes32  _requestId,
        uint256[] calldata likelihoods,
        string   calldata justificationCID
    ) external recordChainlinkFulfillment(_requestId)
    {
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

    /* -------------------------------------------------------------------- */
    /* ---------------------------  views  -------------------------------- */
    function maxTotalFee(uint256) external view returns (uint256) { return fee; }

    function getContractConfig()
        external view
        returns (address oracleAddr, address linkAddr, bytes32 jId, uint256 currentFee)
    {
        return (oracle, _chainlinkTokenAddress(), jobId, fee);
    }

    function getEvaluation(bytes32 id)
        external view
        returns (uint256[] memory likelihoods, string memory cid, bool exists)
    {
        Evaluation storage ev = evaluations[id];
        return (ev.likelihoods, ev.justificationCID, ev.exists);
    }
}

