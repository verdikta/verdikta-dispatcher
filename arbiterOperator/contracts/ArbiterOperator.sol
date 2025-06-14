// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/* ────────────────────────────────────────────────────────────── */
/*  Imports                                                      */
/* ────────────────────────────────────────────────────────────── */

import "../lib/chainlink/src/v0.8/operatorforwarder/OperatorMod.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/* ────────────────────────────────────────────────────────────── */
/*  External interfaces                                          */
/* ────────────────────────────────────────────────────────────── */

/// @notice Minimal view used by ArbiterOperator to consult allow-lists.
interface IReputationKeeper {
    function isContractApproved(address contractAddress) external view returns (bool);
}

/**
 * @title IArbiterOperator
 * @notice Marker + allow-list interface implemented **only** by ArbiterOperator.
 *
 *         interfaceId = 0xd9f812f9
 *           = bytes4(
 *               keccak256("fulfillOracleRequestV(bytes32,uint256,address,bytes4,uint256,bytes)")
 *             )
 *             ^ 0x1132d7b2  // isReputationKeeper(address)
 *             ^ 0xb7834e7d  // isReputationKeeperListEmpty()
 *         A vanilla Chainlink Operator returns `false` for this ID.
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
    function isReputationKeeper(address rkAddr) external view returns (bool);
    function isReputationKeeperListEmpty() external view returns (bool);
}

/* ────────────────────────────────────────────────────────────── */
/*  ArbiterOperator                                              */
/* ────────────────────────────────────────────────────────────── */

/// @notice Chainlink Operator variant that
///         1) exposes `fulfillOracleRequestV` (multi-word response)
///         2) enforces an allow-list of consumers approved by one or more
///            ReputationKeeper contracts *before* the OracleRequest event
///            is emitted (so nodes never start un-approved jobs).
contract ArbiterOperator is OperatorMod, ERC165, IArbiterOperator {
    /*──────────────  CONFIG  ──────────────*/

    /// Matches Chainlink upstream (node sends ≈500 k gas).
    uint256 private constant MY_MINIMUM_CONSUMER_GAS_LIMIT = 400_000;

    /*────────  RK allow-list STORAGE  ─────*/

    mapping(address => bool) private rk;      // ReputationKeeper → true/false
    address[]               private rkList;   // enumeration for _approved()

    event ReputationKeeperAdded(address indexed rk);
    event ReputationKeeperRemoved(address indexed rk);

    /*────────  EVENTS (callback tracing)  ─*/

    event OracleCallbackAttempt(
        bytes32 indexed requestId,
        address callback,
        bytes4  selector,
        uint256 gasBefore
    );
    event OracleCallbackResult(
        bytes32 indexed requestId,
        bool     success,
        bytes    returnData,
        uint256  gasAfter
    );

    /*────────────  CONSTRUCTOR  ───────────*/

    constructor(address linkToken)
        OperatorMod(linkToken, msg.sender)   // pass straight through
    {}

    /*────────────  RK management  ─────────*/

    function addReputationKeeper(address rkAddr) external onlyOwner {
        require(rkAddr.code.length > 0, "RK: not contract");
        require(!rk[rkAddr],            "RK: exists");

        // sanity-check interface
        (bool ok, ) = rkAddr.staticcall(
            abi.encodeWithSignature("isContractApproved(address)", address(this))
        );
        require(ok, "RK: interface");

        rk[rkAddr] = true;
        rkList.push(rkAddr);
        emit ReputationKeeperAdded(rkAddr);
    }

    function removeReputationKeeper(address rkAddr) external onlyOwner {
        require(rk[rkAddr], "RK: unknown");
        delete rk[rkAddr];

        for (uint256 i; i < rkList.length; ++i) {
            if (rkList[i] == rkAddr) {
                rkList[i] = rkList[rkList.length - 1];
                rkList.pop();
                break;
            }
        }
        emit ReputationKeeperRemoved(rkAddr);
    }

    /*────────────  public probes  ─────────*/

    function isReputationKeeper(address rkAddr) external view override returns (bool) {
        return rk[rkAddr];
    }

    function isReputationKeeperListEmpty() external view override returns (bool) {
        return rkList.length == 0;
    }

    /*────────── internal helper ───────────*/

    function _approved(address requester) internal view returns (bool) {
        if (rkList.length == 0) return true;               // gate disabled
        for (uint256 i; i < rkList.length; ++i) {
            (bool ok, bytes memory out) = rkList[i].staticcall(
                abi.encodeWithSignature("isContractApproved(address)", requester)
            );
            if (ok && abi.decode(out, (bool))) return true;
        }
        return false;
    }

    /*────────── ERC-165 override ──────────*/

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC165, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IArbiterOperator).interfaceId || // 0xd9f812f9
            super.supportsInterface(interfaceId);
    }

    /*───────── Hook from OperatorMod ──────*/

    /// Called *before* `OracleRequest` is emitted by OperatorMod.
    function _beforeOracleRequest(address requester)
        internal
        view
        override
    {
        require(_approved(requester), "Operator: requester not approved");
    }

    /*──────── fulfillOracleRequestV ───────*/

    /// @inheritdoc IArbiterOperator
    function fulfillOracleRequestV(
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
        // secondary check (paranoia): block if consumer no longer approved
        require(_approved(callbackAddress), "Operator: requester not approved");

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

