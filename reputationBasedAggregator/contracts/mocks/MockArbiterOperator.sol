// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IAggFulfill {
    function fulfill(bytes32 requestId, uint256[] memory response, string memory cid) external;
}

/**
 * @title MockArbiterOperator
 * @notice Test double for an ArbiterOperator. It is both the "oracle" address the keeper
 *         selects (so the aggregator resolves its payee via owner()) and the Chainlink
 *         operator the request is dispatched to (so it must be the one calling back fulfill,
 *         which recordChainlinkFulfillment enforces via msg.sender). The owner() it returns
 *         is the address the aggregator credits with base/bonus.
 */
contract MockArbiterOperator {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    /// @dev ERC-677 hook fired by the 0-juel transferAndCall dispatch. Accept and ignore -
    ///      a real node listens for the emitted OracleRequest event off-chain instead.
    function onTokenTransfer(address, uint256, bytes calldata) external {}

    /// @dev Forward a node response to the aggregator. Called as msg.sender == this operator,
    ///      which is exactly what the aggregator's recordChainlinkFulfillment(requestId) gate
    ///      requires (the request was dispatched to this operator).
    function callFulfill(
        address agg,
        bytes32 requestId,
        uint256[] calldata response,
        string calldata cid
    ) external {
        IAggFulfill(agg).fulfill(requestId, response, cid);
    }
}
