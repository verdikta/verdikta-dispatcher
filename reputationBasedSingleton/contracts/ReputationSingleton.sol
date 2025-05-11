// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IReputationKeeper.sol";

/// @notice A singleton version of ReputationAggregator: selects exactly one oracle
/// and issues a single Chainlink request. All the same config getters/setters
/// and max-fee logic are preserved, and the event signature matches exactly.
contract ReputationSingleton is ChainlinkClient, Ownable, ReentrancyGuard {
    using Chainlink for Chainlink.Request;

    // ------------------------------------------------------------------------
    // Configuration (same as in your Aggregator)
    // ------------------------------------------------------------------------
    uint256 public alpha = 500;
    uint256 public maxOracleFee;                // in LINK wei
    uint256 public baseFeePct = 1;              // 1%
    uint256 public maxFeeBasedScalingFactor = 10;

    uint256 public constant MAX_CID_COUNT       = 10;
    uint256 public constant MAX_CID_LENGTH      = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;

    IReputationKeeper public reputationKeeper;

    /// @notice matches the original aggregator
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);

    /// @param _link            LINK token address
    /// @param _reputationKeeper  deployed ReputationKeeper address
    constructor(address _link, address _reputationKeeper)
        Ownable(msg.sender)
    {
        require(_reputationKeeper != address(0), "Keeper zero");
        _setChainlinkToken(_link);
        reputationKeeper = IReputationKeeper(_reputationKeeper);
        // default max oracle fee = 0.1 LINK
        maxOracleFee = 0.1 * 10**18;
    }

    // ------------------------------------------------------------------------
    // Config setters & getters (same signatures as Aggregator)
    // ------------------------------------------------------------------------
    function setAlpha(uint256 _alpha) external onlyOwner {
        require(_alpha <= 1000, "Alpha <= 1000");
        alpha = _alpha;
    }
    function getAlpha() external view returns (uint256) {
        return alpha;
    }

    function setMaxOracleFee(uint256 _maxOracleFee) external onlyOwner {
        maxOracleFee = _maxOracleFee;
    }

    function setBaseFeePct(uint256 _baseFeePct) external onlyOwner {
        require(_baseFeePct >= 1 && _baseFeePct <= 100, "Pct 1-100");
        baseFeePct = _baseFeePct;
    }

    function setMaxFeeBasedScalingFactor(uint256 _factor) external onlyOwner {
        require(_factor >= 1, "Factor >= 1");
        maxFeeBasedScalingFactor = _factor;
    }

    function setChainlinkToken(address _link) external onlyOwner {
        _setChainlinkToken(_link);
    }

    function setReputationKeeper(address _newKeeper) external onlyOwner {
        require(_newKeeper != address(0), "Keeper zero");
        reputationKeeper = IReputationKeeper(_newKeeper);
    }

    /// @notice Mimics Aggregator.maxTotalFee: but (count + clusterSize) = 1 + 0
    function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256) {
        uint256 eff = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
        return eff * 1;
    }

    /// @notice Same as Aggregator.getEstimatedBaseCost
    function getEstimatedBaseCost() public view returns (uint256) {
        return (maxOracleFee * baseFeePct) / 100;
    }

    // ------------------------------------------------------------------------
    // The one-and-only "request" method
    // ------------------------------------------------------------------------
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendumText,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    )
        external
        nonReentrant
        returns (bytes32 requestId)
    {
        // Validate inputs
        require(address(reputationKeeper) != address(0), "Keeper not set");
        require(cids.length > 0 && cids.length <= MAX_CID_COUNT, "Bad CID count");
        for (uint256 i = 0; i < cids.length; i++) {
            require(bytes(cids[i]).length <= MAX_CID_LENGTH, "CID too long");
        }
        require(bytes(addendumText).length <= MAX_ADDENDUM_LENGTH, "Addendum too long");

        // Build the concatenated payload
        bytes memory buf;
        for (uint256 i = 0; i < cids.length; i++) {
            buf = abi.encodePacked(buf, cids[i], i < cids.length - 1 ? "," : "");
        }
        if (bytes(addendumText).length > 0) {
            buf = abi.encodePacked(buf, ":", addendumText);
        }
        string memory payload = string(buf);

        // Generate a unique requestId
        requestId = keccak256(abi.encodePacked(block.timestamp, msg.sender, payload));

        // **Emit with exact same interface** before any heavy locals
        emit RequestAIEvaluation(requestId, cids);

        // Delegate the on‐chain oracle selection & Chainlink call
        _singletonRequest(
            payload,
            _alpha,
            _maxOracleFee,
            _estimatedBaseCost,
            _maxFeeBasedScalingFactor,
            _requestedClass
        );
    }

    /// @dev Internal helper does the keeper select, LINK transfer, and Chainlink request
    function _singletonRequest(
        string memory payload,
        uint256 _alpha,
        uint256 _maxOracleFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) internal {
        // 1) Select exactly 1 oracle
        IReputationKeeper.OracleIdentity[] memory chosen = reputationKeeper.selectOracles(
            1,
            _alpha,
            _maxOracleFee,
            _estimatedBaseCost,
            _maxFeeBasedScalingFactor,
            _requestedClass
        );
        reputationKeeper.recordUsedOracles(chosen);

        // 2) Check it’s active & get fee/jobId
        (
            bool isActive,
            ,
            ,
            ,
            bytes32 jobId,
            uint256 fee,
            ,
            ,
            
        ) = reputationKeeper.getOracleInfo(chosen[0].oracle, chosen[0].jobId);
        require(isActive, "Oracle inactive");

        // 3) Pull LINK from caller
        require(
            LinkTokenInterface(_chainlinkTokenAddress()).transferFrom(msg.sender, address(this), fee),
            "LINK pull failed"
        );

        // 4) Send single operator request
        Chainlink.Request memory req = _buildOperatorRequest(jobId, this.fulfill.selector);
        req._add("cid", payload);
        _sendOperatorRequestTo(chosen[0].oracle, req, fee);
    }

    /// @notice Stub fulfill: no reputation updates here
    function fulfill(
        bytes32,            /* operatorRequestId */
        uint256[] memory,   /* likelihoods */
        string memory       /* justificationCID */
    ) public recordChainlinkFulfillment(bytes32(0)) {
        // intentionally empty
    }

    /// @notice Keep the same "config" interface
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

    /// @notice Owner-only LINK withdrawal
    function withdrawLink(address payable to, uint256 amount) external onlyOwner {
        require(
            LinkTokenInterface(_chainlinkTokenAddress()).transfer(to, amount),
            "withdraw failed"
        );
    }
}

