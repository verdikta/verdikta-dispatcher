// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint256 jobClass
    ) external returns (bytes32);
    function getEvaluation(bytes32) external view returns (uint64[] memory, string memory, bool);
    function isFailed(bytes32) external view returns (bool);
}

contract DemoClient {
    IReputationAggregator public immutable agg;
    IERC20  public immutable link;

    string[] private cids;
    bytes32  public currentAggId;
    bool     internal linkApproved;          // tracks one-time approval

    event Requested(bytes32 id);
    event Result  (bytes32 id, uint64[] scores, string justif);

    constructor(address aggregator, address linkToken) {
        agg  = IReputationAggregator(aggregator);
        link = IERC20(linkToken);
        cids.push("QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS");
    }

    function request() external {
        require(currentAggId == bytes32(0), "already pending");

        // one-time unlimited approval from this contract to aggregator
        if (!linkApproved) {
            link.approve(address(agg), type(uint256).max);
            linkApproved = true;
        }

        currentAggId = agg.requestAIEvaluationWithApproval(
            cids, "", 500, 1e16, 1e12, 5, 128
        );
        emit Requested(currentAggId);
    }

    function publish() external {
        (uint64[] memory s, string memory j, bool has) =
            agg.getEvaluation(currentAggId);
        if (has) {
            emit Result(currentAggId, s, j);
            currentAggId = bytes32(0);
        } else if (agg.isFailed(currentAggId)) {
            currentAggId = bytes32(0);
        } else {
            revert("not ready");
        }
    }
}

