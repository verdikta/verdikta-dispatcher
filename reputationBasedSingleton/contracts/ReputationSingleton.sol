// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ReputationKeeper.sol";

/// @notice A singleton version of ReputationAggregator: selects exactly one oracle
/// and issues a single Chainlink request.  All the same config getters/setters
/// and max-fee logic are preserved.
contract ReputationSingleton is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    // ------------------------------------------------------------------------
    // Configuration (same as in your Aggregator)
    // ------------------------------------------------------------------------
    uint256 public alpha = 500;            
    uint256 public maxOracleFee;           // in LINK wei
    uint256 public baseFeePct = 1;         // 1%
    uint256 public maxFeeBasedScalingFactor = 10; 

    uint256 public constant MAX_CID_COUNT      = 10;
    uint256 public constant MAX_CID_LENGTH     = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    ReputationKeeper public reputationKeeper;

    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);

    /// @param _link          LINK token address
    /// @param _reputationKeeper  already-deployed ReputationKeeper
    constructor(address _link, address _reputationKeeper) {
        require(_reputationKeeper != address(0), "Keeper zero");
        _setChainlinkToken(_link);
        reputationKeeper = ReputationKeeper(_reputationKeeper);
        // default max oracle fee = 0.1 LINK
        maxOracleFee = 0.1 * 10**18;
    }

    // ------------------------------------------------------------------------
    // Config setters & getters (same signatures as Aggregator)
    // ------------------------------------------------------------------------
    function setAlpha(uint256 _alpha) external onlyOwner {
        require(_alpha <= 1000, "Alpha ≤ 1000");
        alpha = _alpha;
    }
    function getAlpha() external view returns (uint256) {
        return alpha;
    }

    function setMaxOracleFee(uint256 _maxOracleFee) external onlyOwner {
        maxOracleFee = _maxOracleFee;
    }

    function setBaseFeePct(uint256 _baseFeePct) external onlyOwner {
        require(_baseFeePct >= 1 && _baseFeePct <= 100, "Pct 1–100");
        baseFeePct = _baseFeePct;
    }

    function setMaxFeeBasedScalingFactor(uint256 _factor) external onlyOwner {
        require(_factor >= 1, "Factor ≥ 1");
        maxFeeBasedScalingFactor = _factor;
    }

    function setChainlinkToken(address _link) external onlyOwner {
        _setChainlinkToken(_link);
    }

    function setReputationKeeper(address _newKeeper) external onlyOwner {
        require(_newKeeper != address(0), "Keeper zero");
        reputationKeeper = ReputationKeeper(_newKeeper);
    }

    /// @notice “Mimics” Aggregator.maxTotalFee: but (count+clusterSize) = 1 + 0
    function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
        uint256 eff = requestedMaxOracleFee < maxOracleFee
            ? requestedMaxOracleFee
            : maxOracleFee;
        return eff * 1;
    }

    /// @notice Same as Aggregator.getEstimatedBaseCost
    function getEstimatedBaseCost() public view returns (uint256) {
        return (maxOracleFee * baseFeePct) / 100;
    }

    // ------------------------------------------------------------------------
    // The one‐and‐only “request” method
    // ------------------------------------------------------------------------
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    )
        public
        nonReentrant
        returns (bytes32 requestId)
    {
        require(address(reputationKeeper) != address(0), "Keeper not set");
        require(cids.length > 0 && cids.length <= MAX_CID_COUNT, "Bad CID count");
        for (uint256 i = 0; i < cids.length; i++) {
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID too long");
        }
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "Addendum too long");

        // build the single “payload” string
        bytes memory buf;
        for (uint256 i = 0; i < cids.length; i++) {
            buf = abi.encodePacked(buf, cids[i], i < cids.length - 1 ? "," : "");
        }
        string memory payload = string(buf);
        if (bytes(addendumText).length > 0) {
            payload = string(abi.encodePacked(payload, ":", addendumText));
        }

        // unique local requestId (for your front-end to track)
        requestId = keccak256(abi.encodePacked(block.timestamp, msg.sender, payload));

        // -- select exactly one oracle --
        ReputationKeeper.OracleIdentity[]
            memory chosen = reputationKeeper.selectOracles(
                1,
                _alpha,
                _maxOracleFee,
                _estimatedBaseCost,
                _maxFeeBasedScalingFactor,
                _requestedClass
            );
        // mark it used
        reputationKeeper.recordUsedOracles(chosen);

        // fetch its fee & jobId
        (bool isActive, , , , bytes32 jobId, uint256 fee, , , ) =
            reputationKeeper.getOracleInfo(chosen[0].oracle, chosen[0].jobId);
        require(isActive, "Oracle inactive");

        // pull LINK from user
        require(
            LinkTokenInterface(_chainlinkTokenAddress()).transferFrom(msg.sender, address(this), fee),
            "LINK pull failed"
        );

        // send the one operator request
        Chainlink.Request memory req = _buildOperatorRequest(jobId, this.fulfill.selector);
        req._add("cid", payload);
        _sendOperatorRequestTo(chosen[0].oracle, req, fee);

        emit RequestAIEvaluation(requestId, cids);
    }

    /// @notice no reputation updates here
    function fulfill(
        bytes32, /* operatorRequestId */
        uint256[] memory, /* likelihoods */
        string memory   /* justificationCID */
    ) public recordChainlinkFulfillment(/* operatorRequestId */ bytes32(0)) {
        // intentionally empty
    }

    /// @notice keep the same “config” interface
    function getContractConfig()
        external
        view
        returns (
            address oracleAddr,
            address linkAddr,
            bytes32 jobId,
            uint256 fee
        )
    {
        return (address(0), _chainlinkTokenAddress(), bytes32(0), 0);
    }

    function withdrawLink(address payable to, uint256 amount)
        external
        onlyOwner
    {
        require(
            LinkTokenInterface(_chainlinkTokenAddress()).transfer(to, amount),
            "withdraw failed"
        );
    }
}

