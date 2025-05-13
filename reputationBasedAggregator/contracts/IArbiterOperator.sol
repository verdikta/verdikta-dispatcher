// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IArbiterOperator
 * @notice Minimal interface implemented *only* by ArbiterOperator.
 *         Used by on-chain registries to verify that a given address is
 *         a genuine ArbiterOperator (and not a vanilla Chainlink Operator
 *         or an EOA).
 *
 *         interfaceId = 0x9a9f1c96
 *           = bytes4(
 *               keccak256(
 *                 "fulfillOracleRequest3(bytes32,uint256,address,bytes4,uint256,bytes)"
 *               )
 *             )
 */
interface IArbiterOperator {
    function fulfillOracleRequest3(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4  callbackFunctionId,
        uint256 expiration,
        bytes   calldata data
    ) external returns (bool success);
}
