// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev ERC-677 receiver hook (Chainlink rail).
interface IERC677Receiver {
    function onTokenTransfer(address sender, uint256 value, bytes calldata data) external;
}

/**
 * @title MockLinkToken
 * @notice Minimal ERC-677 LINK stand-in for tests. The ETH aggregator dispatches via
 *         transferAndCall(operator, 0, data) (0 juel), so this only needs to move (zero)
 *         tokens and fire the receiver's onTokenTransfer hook. Not for production.
 */
contract MockLinkToken {
    string public constant name = "Mock LINK";
    string public constant symbol = "LINK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 value) public returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function approve(address spender, uint256 value) public returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool) {
        transfer(to, value);
        IERC677Receiver(to).onTokenTransfer(msg.sender, value, data);
        return true;
    }
}
