// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IReputationKeeper.sol";

/*
 * ReputationSingleton
 * -------------------
 * Minimal one-oracle version of the reputation aggregator.  Front-end
 * compatibility: exposes `getEvaluation()` and `getContractConfig()`
 * exactly like the multi-oracle Aggregator.
 *
 * NEW: pays a 1× fee bonus to the oracle on successful fulfilment.
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
    struct ReqMeta {
        uint256 started;
        bool    done;
        bool    failed;
        address requester;   // bonus payer
        address oracle;      // bonus receiver
        uint256 feeUsed;     // fee amount, reused for bonus
    }
    mapping(bytes32 => ReqMeta) private _reqMeta;

    /* ─────────────────────────── STORAGE FOR UI ───────────────────── */
    mapping(bytes32 => uint256[]) public likelihoodByRequest;
    mapping(bytes32 => string)    public justificationByRequest;

    /* ───────────────────────────── EVENTS ─────────────────────────── */
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
    event EvaluationFulfilled(bytes32 indexed requestId,
                              uint256[] likelihoods, string justificationCID);
    event EvaluationFailed(bytes32 indexed requestId);
    event BonusPaid(bytes32 indexed requestId, address oracle, uint256 amount);

    /* ────────────────────────── CONSTRUCTOR ───────────────────────── */
    constructor(address _link, address _reputationKeeper) Ownable(msg.sender) {
        require(_reputationKeeper != address(0), "Keeper zero");
        _setChainlinkToken(_link);
        reputationKeeper = IReputationKeeper(_reputationKeeper);
        maxOracleFee = 0.1 * 1e18; // 0.1 LINK default
    }

    /* ───────────────────────── OWNER SETTERS ──────────────────────── */
    function setAlpha(uint256 _a) external onlyOwner { require(_a<=1000); alpha=_a; }
    function getAlpha() external view returns (uint256){return alpha;}
    function setMaxOracleFee(uint256 f) external onlyOwner { maxOracleFee=f; }
    function setBaseFeePct(uint256 p) external onlyOwner { require(p>=1&&p<=100); baseFeePct=p; }
    function setMaxFeeBasedScalingFactor(uint256 f) external onlyOwner { require(f>=1); maxFeeBasedScalingFactor=f; }
    function setChainlinkToken(address a) external onlyOwner { _setChainlinkToken(a); }
    function setReputationKeeper(address a) external onlyOwner { require(a!=address(0)); reputationKeeper=IReputationKeeper(a);}
    function setResponseTimeout(uint256 s) external onlyOwner { require(s>=30&&s<=1 days); responseTimeoutSeconds=s; }

    /* ─────────────────────── FEE HELPERS ──────────────────────────── */
    function maxTotalFee(uint256 requested) public view returns (uint256) {
        uint256 eff = requested < maxOracleFee ? requested : maxOracleFee;
        /* user must approve base + bonus = 2×fee */
        return eff * 2;
    }
    function getEstimatedBaseCost() public view returns (uint256) {
        return (maxOracleFee * baseFeePct) / 100;
    }

    /* ───────────────────────── REQUEST ENTRY ──────────────────────── */
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

        /* 2. pull base fee */
        require(LinkTokenInterface(_chainlinkTokenAddress())
                .transferFrom(msg.sender,address(this),_maxOracleFee),"LINK pull failed");

        /* 3. send request */
        Chainlink.Request memory req =
            _buildOperatorRequest(chosen[0].jobId,this.fulfill.selector);
        req._add("cid",payload);
        bytes32 reqId = _sendOperatorRequestTo(chosen[0].oracle,req,_maxOracleFee);

        /* 4. record meta */
        _reqMeta[reqId]=ReqMeta({
            started:   block.timestamp,
            done:      false,
            failed:    false,
            requester: msg.sender,
            oracle:    chosen[0].oracle,
            feeUsed: _maxOracleFee
        });
        return reqId;
    }

    /* ─────────────────────────── FULFILL ──────────────────────────── */
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
        emit BonusPaid(requestId,m.oracle,maxOracleFee);

        emit EvaluationFulfilled(requestId,likelihoods,justificationCID);
    }

    /* ─────────────────────────── TIMEOUT ──────────────────────────── */
    function finalizeEvaluationTimeout(bytes32 requestId) external nonReentrant {
        ReqMeta storage m=_reqMeta[requestId];
        require(!m.done,"complete");
        require(block.timestamp>=m.started+responseTimeoutSeconds,"not timed-out");
        m.done=true; m.failed=true;
        emit EvaluationFailed(requestId);
    }
    function isFailed(bytes32 requestId) external view returns(bool){return _reqMeta[requestId].failed;}

    /* ───────────────────── FRONT-END HELPERS ──────────────────────── */
    function getEvaluation(bytes32 id)
        external view
        returns (uint256[] memory l,string memory j,bool exists)
    {
        l=likelihoodByRequest[id]; j=justificationByRequest[id];
        exists=l.length>0||bytes(j).length>0;
    }
    function getContractConfig()
        external view
        returns (address oracleAddr,address linkAddr,bytes32 jobId,uint256 fee)
    {
        return (address(0),_chainlinkTokenAddress(),bytes32(0),0);
    }
    function withdrawLink(address payable to,uint256 amount) external onlyOwner {
        LinkTokenInterface(_chainlinkTokenAddress()).transfer(to,amount);
    }
}

