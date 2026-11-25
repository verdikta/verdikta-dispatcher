// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice A beacon contract (as a compromised owner could set) that reports more payees than the quorum
contract EvilBeacons {
    uint8 public quorum = 2;
    uint256 public extra;
    address public payee;

    constructor(address payee_, uint256 n) {
        payee = payee_;
        extra = n;
    }

    function start(bytes32, bytes32, uint64, uint256, uint256, uint8 q) external pure returns (uint256) {
        return q;
    }

    function result(address, bytes32) external view returns (uint8, bytes32, uint256, address[] memory p) {
        p = new address[](extra);
        for (uint256 i = 0; i < extra; i++) p[i] = payee;
        return (2, keccak256("mix"), block.timestamp, p);
    }
}
