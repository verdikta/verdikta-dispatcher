// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title MockHistory
 * @notice Stand-in for the EIP-2935 block-hash history contract (Hardhat's own stub reverts). Its code
 *         is installed at 0x0000F90827F1C53a10cb7A02335B175320002935 with hardhat_setCode; tests copy
 *         real block hashes in with set(). Like the real contract, a 32-byte block number in, the hash
 *         out, and a revert for a block it does not hold.
 */
contract MockHistory {
    mapping(uint256 => bytes32) private hashes;

    function set(uint256 n, bytes32 h) external {
        hashes[n] = h;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        bytes32 h = hashes[abi.decode(data, (uint256))];
        require(h != bytes32(0), "no hash");
        return abi.encode(h);
    }
}
