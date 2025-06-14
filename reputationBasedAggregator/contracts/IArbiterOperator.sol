// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IArbiterOperator
 * @notice Marker + allow-list interface implemented **only** by ArbiterOperator.
 *
 *         interfaceId = 0xd9f812f9
 *           = bytes4(
 *               keccak256(
 *                 "fulfillOracleRequestV(bytes32,uint256,address,bytes4,uint256,bytes)"
 *               )
 *             )
 *             ^ 0x1132d7b2  // isReputationKeeper(address)
 *             ^ 0xb7834e7d  // isReputationKeeperListEmpty()
 *
 *         A vanilla Chainlink Operator returns `false` for this ID, so on-chain
 *         registries can simply call
 *
 *           IERC165(candidate).supportsInterface(
 *               type(IArbiterOperator).interfaceId
 *           )
 *
 *         to tell a genuine ArbiterOperator from any other contract or EOA.
 */
interface IArbiterOperator is IERC165 {
    /*────────  Chainlink multi-word fulfilment  ────────*/

    function fulfillOracleRequestV(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4  callbackFunctionId,
        uint256 expiration,
        bytes   calldata data
    ) external returns (bool success);

    /*────────  Allow-list probes  ──────────────────────*/

    /// @return true if `rkAddr` is one of the ReputationKeeper contracts that
    ///         govern the operator’s allow-list
    function isReputationKeeper(address rkAddr) external view returns (bool);

    /// @return true when no ReputationKeeper contracts are configured, i.e. the
    ///         allow-list is effectively disabled
    function isReputationKeeperListEmpty() external view returns (bool);
}

