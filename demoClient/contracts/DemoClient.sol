// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationAggregator {
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseFee,
        uint256 maxFeeScaling,
        uint64 jobClass
    ) external payable returns (bytes32);
    function getEvaluation(bytes32)
       external view returns (uint256[] memory, string memory, bool);
    function isFailed(bytes32) external view returns (bool);
    function maxTotalFee(uint256) external view returns (uint256);
    function withdrawEth() external;
}

/**
 * @title DemoClient (ETH-funded)
 * @notice Example consumer for the ETH-funded ReputationAggregator. Native ETH rides with
 *         the request as msg.value — there is no LINK token, no approve(), and nothing to
 *         pre-fund (users already hold ETH for gas). The aggregator refunds any unspent ETH
 *         as a credit it holds for this contract; that credit auto-funds the next request
 *         (so a follow-up can attach msg.value = 0) or can be pulled back via reclaim().
 */
contract DemoClient {
    IReputationAggregator public immutable agg;
    string[] private cids;
    bytes32 public currentAggId;

    event Requested(bytes32 id);
    event Result(bytes32 id, uint256[] scores, string justif);

    constructor(address aggregator) {
        agg = IReputationAggregator(aggregator);
        cids.push("QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS");
    }

    /// @notice Start an evaluation, funding it with the attached ETH (and/or this contract's
    ///         accumulated refund credit inside the aggregator). Fee params are ETH-wei:
    ///         request ceiling 0.00015 ETH (>= the 0.0001 arbiter fee, <= the 0.0004 cap),
    ///         base cost 8e9 wei.
    function request() external payable {
        require(currentAggId == bytes32(0), "already pending");
        currentAggId = agg.requestAIEvaluationWithApproval{value: msg.value}(
            cids, "", 500, 15e13, 8e9, 5, 128
        );
        emit Requested(currentAggId);
    }

    /// @notice Convenience view: worst-case ETH to attach for one request.
    function quote() external view returns (uint256) {
        return agg.maxTotalFee(15e13);
    }

    function publish() external {
        (uint256[] memory s, string memory j, bool has) =
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

    /// @notice Pull this contract's accumulated refund credit back out of the aggregator.
    function reclaim() external {
        agg.withdrawEth();
    }

    /// @dev Accept ETH — the reclaimed refund lands here.
    receive() external payable {}
}
