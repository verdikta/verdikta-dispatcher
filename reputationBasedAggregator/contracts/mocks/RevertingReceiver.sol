// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title RevertingReceiver
 * @notice A payee whose ETH receive path always reverts. Used to prove the pull-payment
 *         isolation property: its own withdrawal reverts and its ethOwed is restored (not
 *         burned), while finalize and every other payee are unaffected.
 */
contract RevertingReceiver {
    receive() external payable {
        revert("RevertingReceiver: cannot accept ETH");
    }
}
