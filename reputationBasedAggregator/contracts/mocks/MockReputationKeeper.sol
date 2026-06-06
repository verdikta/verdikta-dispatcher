// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title MockReputationKeeper
 * @notice Minimal keeper stand-in implementing only the surface the ETH aggregator calls:
 *         selectOracles / recordUsedOracles / getOracleInfo / updateScores / pushEntropy.
 *         It performs no staking, registration, interface, or approval checks - those are
 *         the real keeper's concern and out of scope for the aggregator's ETH custody tests.
 *         The OracleIdentity struct is laid out identically to ReputationKeeper.OracleIdentity
 *         so the ABI of selectOracles/recordUsedOracles matches what the aggregator expects.
 */
contract MockReputationKeeper {
    struct OracleIdentity {
        address oracle;
        bytes32 jobId;
        uint64[] classes;
    }

    OracleIdentity[] private _oracles;
    mapping(address => uint256) public feeOf;   // per-oracle fee (ETH wei)
    mapping(address => bool) public activeOf;   // per-oracle active flag
    bytes32 public jobId = bytes32(uint256(0x1234));

    bytes16 public lastEntropy;

    /// @notice Configure the oracle set returned by selectOracles. Each oracle gets `fee`.
    function setOracles(address[] calldata oracles, uint256 fee) external {
        delete _oracles;
        uint64[] memory emptyClasses;
        for (uint256 i = 0; i < oracles.length; i++) {
            _oracles.push(OracleIdentity({ oracle: oracles[i], jobId: jobId, classes: emptyClasses }));
            feeOf[oracles[i]] = fee;
            activeOf[oracles[i]] = true;
        }
    }

    /// @notice Override a single oracle's fee (e.g. to test the charge-time ceiling guard).
    function setFee(address oracle, uint256 fee) external {
        feeOf[oracle] = fee;
    }

    function setActive(address oracle, bool active) external {
        activeOf[oracle] = active;
    }

    function selectOracles(
        uint256 count,
        uint256 /*alpha*/,
        uint256 maxFee,
        uint256 /*estimatedBaseCost*/,
        uint256 /*maxFeeBasedScalingFactor*/,
        uint64 /*requestedClass*/
    ) external view returns (OracleIdentity[] memory) {
        // Mimic the real eligibility filter: only return oracles with fee <= maxFee, up to count.
        uint256 n = count < _oracles.length ? count : _oracles.length;
        // first pass: count eligible
        uint256 eligible = 0;
        for (uint256 i = 0; i < n; i++) {
            if (feeOf[_oracles[i].oracle] <= maxFee) eligible++;
        }
        OracleIdentity[] memory out = new OracleIdentity[](eligible);
        uint256 k = 0;
        for (uint256 i = 0; i < n; i++) {
            if (feeOf[_oracles[i].oracle] <= maxFee) out[k++] = _oracles[i];
        }
        return out;
    }

    function recordUsedOracles(OracleIdentity[] calldata) external {}

    function getOracleInfo(address _oracle, bytes32 _jobId)
        external
        view
        returns (
            bool isActive,
            int256 qualityScore,
            int256 timelinessScore,
            uint256 callCount,
            bytes32 jobId_,
            uint256 fee,
            uint256 stakeAmount,
            uint256 lockedUntil,
            bool blocked
        )
    {
        return (activeOf[_oracle], 0, 0, 0, _jobId, feeOf[_oracle], 0, 0, false);
    }

    function updateScores(address, bytes32, int8, int8) external {}

    function pushEntropy(bytes16 e) external {
        lastEntropy = e;
    }
}
