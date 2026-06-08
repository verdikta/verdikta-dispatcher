// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title MockBadCountKeeper
 * @notice Hostile/buggy keeper stand-in for the M-3 backstop test. Its selectOracles returns an
 *         attacker-chosen NUMBER of identities (`returnCount`) regardless of the `count` the
 *         aggregator asked for. Returning more than commitOraclesToPoll would over-credit base
 *         beyond the round's escrow and break solvency; the aggregator must reject any
 *         size != commitOraclesToPoll with BadSelectionCount before touching state.
 *         Only implements the surface the ETH aggregator calls.
 */
contract MockBadCountKeeper {
    struct OracleIdentity {
        address oracle;
        bytes32 jobId;
        uint64[] classes;
    }

    address public theOracle;
    bytes32 public jobId = bytes32(uint256(0x1234));
    uint256 public feeWei;
    uint256 public returnCount;

    /// @notice Configure the single oracle echoed back, its fee, and how many identities to return.
    function configure(address oracle, uint256 fee, uint256 _returnCount) external {
        theOracle = oracle;
        feeWei = fee;
        returnCount = _returnCount;
    }

    function selectOracles(uint256 /*count*/, uint256, uint256, uint256, uint256, uint64)
        external
        view
        returns (OracleIdentity[] memory)
    {
        uint64[] memory empty;
        OracleIdentity[] memory out = new OracleIdentity[](returnCount);
        for (uint256 i = 0; i < returnCount; i++) {
            out[i] = OracleIdentity({ oracle: theOracle, jobId: jobId, classes: empty });
        }
        return out;
    }

    function recordUsedOracles(OracleIdentity[] calldata) external {}

    function getOracleInfo(address, bytes32 _jobId)
        external
        view
        returns (bool, int256, int256, uint256, bytes32, uint256, uint256, uint256, bool)
    {
        return (true, 0, 0, 0, _jobId, feeWei, 0, 0, false);
    }

    function updateScores(address, bytes32, int8, int8) external {}

    function pushEntropy(bytes16) external {}
}
