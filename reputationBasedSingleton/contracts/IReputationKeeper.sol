// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationKeeper {
    struct OracleIdentity {
        address oracle;
        bytes32 jobId;
        uint64[] classes;
    }

    // selectOracles is intentionally NON-VIEW to match the on-chain Keeper
    function selectOracles(
        uint256 count,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64   requestedClass
    ) external returns (OracleIdentity[] memory);

    function recordUsedOracles(OracleIdentity[] calldata _oracleIdentities) external;

    function getOracleInfo(
        address _oracle,
        bytes32 _jobId
    )
        external
        view
        returns (
            bool    isActive,
            int256  qualityScore,
            int256  timelinessScore,
            uint256 callCount,
            bytes32 jobId,
            uint256 fee,
            uint256 stakeAmount,
            uint256 lockedUntil,
            bool    blocked
        );

    // Useful keeperside views/utilities that exist on deployed Keeper
    function isContractApproved(address contractAddress) external view returns (bool);
    function approveContract(address contractAddress) external;

    // Deployed Aggregator uses these; harmless to expose here for completeness
    function updateScores(address _oracle, bytes32 _jobId, int8 qualityChange, int8 timelinessChange) external;
    function pushEntropy(bytes16 e) external;
}

