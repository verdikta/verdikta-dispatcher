// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/* ────────────────────────────────────────────────────────────── */
/*  Imports                                                      */
/* ────────────────────────────────────────────────────────────── */

import "../lib/chainlink/src/v0.8/operatorforwarder/Operator.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/* ────────────────────────────────────────────────────────────── */
/*  ERC-165 Interface that only ArbiterOperator implements        */
/* ────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────── */
/*  ArbiterOperator                                              */
/* ────────────────────────────────────────────────────────────── */

/// @notice Chainlink Operator variant that exposes `fulfillOracleRequest3`
///         and advertises its interface via ERC-165 so that on-chain
///         registries can verify the contract type.
contract ArbiterOperator is Operator, ERC165, IArbiterOperator {
    /*──────────────  CONFIG  ──────────────*/

    /// Matches Chainlink upstream default (node sends 500 000 gas).
    uint256 private constant MY_MINIMUM_CONSUMER_GAS_LIMIT = 400_000;

    /*──────────────  EVENTS  ──────────────*/

    /// Emitted just before the external callback
    event OracleCallbackAttempt(
        bytes32 indexed requestId,
        address callback,
        bytes4  selector,
        uint256 gasBefore
    );

    /// Emitted right after the external callback returns
    event OracleCallbackResult(
        bytes32 indexed requestId,
        bool     success,
        bytes    returnData,
        uint256  gasAfter
    );

    /*────────────  CONSTRUCTOR  ───────────*/

    constructor(address linkToken) Operator(linkToken, msg.sender) {}

    /*────────────  ERC-165  ───────────────*/

    /// @dev Advertise support for IArbiterOperator as well as any
    ///      interfaces claimed by the parent contract(s).
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC165)
        returns (bool)
    {
        return
            interfaceId == type(IArbiterOperator).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /*──────── fulfillOracleRequest3 ───────*/

    /// @inheritdoc IArbiterOperator
    function fulfillOracleRequest3(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4  callbackFunctionId,
        uint256 expiration,
        bytes   calldata data
    )
        external
        validateAuthorizedSender
        validateRequestId(requestId)
        validateCallbackAddress(callbackAddress)
        validateMultiWordResponseId(requestId, data)
        returns (bool success)
    {
        _verifyOracleRequestAndProcessPayment(
            requestId,
            payment,
            callbackAddress,
            callbackFunctionId,
            expiration,
            2 // dataVersion
        );

        emit OracleResponse(requestId);

        require(
            gasleft() >= MY_MINIMUM_CONSUMER_GAS_LIMIT,
            "Operator: not enough gas for consumer"
        );

        emit OracleCallbackAttempt(
            requestId,
            callbackAddress,
            callbackFunctionId,
            gasleft()
        );

        bytes memory ret;
        (success, ret) = callbackAddress.call(
            abi.encodePacked(callbackFunctionId, data)
        ); // solhint-disable-line avoid-low-level-calls

        emit OracleCallbackResult(requestId, success, ret, gasleft());
    }
}

