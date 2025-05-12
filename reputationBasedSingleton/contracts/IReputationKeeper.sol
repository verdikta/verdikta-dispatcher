// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationKeeper {
    struct OracleIdentity {
        address oracle;
        bytes32 jobId;
        uint64[] classes;
    }

    function selectOracles(
        uint256 count,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass
    ) external view returns (OracleIdentity[] memory);

    function recordUsedOracles(OracleIdentity[] calldata) external;

    function getOracleInfo(
        address _oracle,
        bytes32 _jobId
    )
        external
        view
        returns (
            bool isActive,
            int256 qualityScore,
            int256 timelinessScore,
            uint256 callCount,
            bytes32 jobId,
            uint256 fee,
            uint256 stakeAmount,
            uint256 lockedUntil,
            bool blocked
        );

    function approveContract(address contractAddress) external;
}

