// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface IAggFulfillR {
    function fulfill(bytes32 requestId, uint256[] memory response, string memory cid) external;
}

/**
 * @title MockRevertingDispatchOperator
 * @notice ArbiterOperator test double whose ERC-677 onTokenTransfer hook can be made to revert,
 *         modeling the malicious operator in finding H-1: the 0-juel transferAndCall dispatch
 *         fires this hook, and a hostile operator can revert there to try to brick the whole
 *         request / reveal batch. The aggregator must catch that and treat the slot as a no-show.
 * @dev    mode 0: never revert (behaves like MockArbiterOperator).
 *         mode 1: always revert in onTokenTransfer (bricks the request-time poll dispatch).
 *         mode 2: revert once `calls` reaches `revertFromCall` (e.g. 2 = let the commit-phase
 *                 poll dispatch through, then revert on the reveal-phase dispatch).
 */
contract MockRevertingDispatchOperator {
    address public owner;
    uint8 public mode;
    uint256 public revertFromCall;
    uint256 public calls;

    constructor(address _owner, uint8 _mode, uint256 _revertFromCall) {
        owner = _owner;
        mode = _mode;
        revertFromCall = _revertFromCall;
    }

    /// @dev ERC-677 hook fired by the aggregator's transferAndCall dispatch.
    function onTokenTransfer(address, uint256, bytes calldata) external {
        calls += 1;
        if (mode == 1) revert("dispatch blocked");
        if (mode == 2 && calls >= revertFromCall) revert("dispatch blocked (reveal)");
    }

    /// @dev Forward a node response to the aggregator (msg.sender == this operator).
    function callFulfill(
        address agg,
        bytes32 requestId,
        uint256[] calldata response,
        string calldata cid
    ) external {
        IAggFulfillR(agg).fulfill(requestId, response, cid);
    }
}
