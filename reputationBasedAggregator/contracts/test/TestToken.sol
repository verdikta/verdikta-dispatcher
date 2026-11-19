// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev VDKA stand-in with burn(), for stake and burn tests.
contract TestToken is ERC20Burnable {
    constructor() ERC20("Test VDKA", "tVDKA") {
        _mint(msg.sender, 1e30);
    }
}
