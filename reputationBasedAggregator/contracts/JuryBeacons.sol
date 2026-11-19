// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IBeaconKeeper {
    function pickBeacons(bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint256 count)
        external
        returns (bytes32[] memory keys);

    function revealAfter(bytes32 key, uint256 b)
        external
        view
        returns (bytes32 value, uint256 blk, uint256 at, address oracle);
}

/**
 * @title JuryBeacons (TODO item 9's beacon flag)
 * @notice Hash-chain beacons for the jury draw, kept out of the aggregator to save its bytecode.
 *
 *         For a request with the beacon flag, the aggregator calls start() once blockhash(B+1) is
 *         known. The keeper picks `polled` beacons (default 4) from the request's class, entirely from
 *         its state as of block B, and sends each a health call. A beacon is called like any arbiter
 *         and answers like any arbiter: with its next hash-chain value, which the keeper verifies
 *         against its head. Its beacon value is its first value revealed after block B+1 (the
 *         keeper's revealAfter): normally its answer to the beacon call, or its answer to an earlier
 *         call if it answered one after B+1. The first `quorum` values revealed (default 2, by block,
 *         ties by beacon index) by the deadline (default 120 s after start) are used, mixed in
 *         beacon-index order, and the aggregator draws the jury with keccak256(aggId, blockhash(B+1),
 *         mix). With fewer, the round ends with no result.
 *
 *         Why this resists steering:
 *           - the pick depends only on blockhash(B+1) and the state as of B, and each value is the
 *             next one after the head at the end of B+1, so it was fixed before anyone but the builder
 *             of B+1 knew the pick. No chain rotation later can change it (a rotation reveals that
 *             value first). Anchoring at B+1 rather than B means an honest beacon's answer included
 *             in B+1 does not hand its value to that block's builder;
 *           - a beacon can therefore only choose when to reveal, or not to;
 *           - only the arbiter (its owner or an authorized sender of its operator) can answer, so the
 *             reveal times are the beacons' own doing, not a relayer's;
 *           - the result reads only completed blocks, so within a block the order of transactions
 *             cannot change it, and once ready it is final;
 *           - mixing in index order means arrival decides only which values are used, not their order.
 *         A cartel holding beacon seats still chooses among a few seeds by when it reveals, and can
 *         force a no-result round by withholding (item 9, "What it buys and costs"). Withholding is
 *         cheap: a beacon that answers just after the deadline is frozen only from the call deadline
 *         (60 s) until then, and its value does not count.
 *
 *         Payment is the aggregator's: it credits one per-arbiter fee to the payee (operator owner) of
 *         each used value when it draws. The owner is read here with a fixed stipend.
 */
contract JuryBeacons is Ownable {
    uint8 public constant ST_NONE = 0;
    uint8 public constant ST_PENDING = 1;
    uint8 public constant ST_READY = 2;
    uint8 public constant ST_EXPIRED = 3;
    uint256 private constant OWNER_GAS = 30_000;
    uint256 private constant COLD_ACCOUNT = 2_600;     // the staticcall's first touch of the operator

    struct Req {
        uint32 atBlock;      // the request block B
        uint40 startedAt;
        uint40 deadline;
        uint8 quorum;
        bytes32[] keys;
    }

    IBeaconKeeper public immutable keeper;
    mapping(address => bool) public approved;              // aggregators
    mapping(address => mapping(bytes32 => Req)) internal reqs;

    uint8 public polled = 4;
    uint8 public quorum = 2;
    uint40 public timeout = 120;     // seconds for the quorum; reveals take a median 15 s, p90 30 s (item 6)

    error NotApproved();
    error AlreadyStarted();
    error InvalidConfig();
    error OutOfGas();

    event BeaconCalled(address indexed aggregator, bytes32 indexed aggId, uint256 index, bytes32 indexed key, uint256 deadline);
    event Approval(address indexed aggregator, bool ok);

    constructor(address keeper_) Ownable(msg.sender) {
        keeper = IBeaconKeeper(keeper_);
    }

    /**
     * @notice Start the beacon stage of a draw (aggregator only, once per request). Returns the number of
     *         beacons picked; with fewer than `quorum_` the caller should fail the round (pool shortage).
     * @param seed    entropy for the pick (from blockhash(B+1))
     * @param quorum_ the values the aggregator escrowed for (fixed at request)
     */
    function start(bytes32 aggId, bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint8 quorum_)
        external
        returns (uint256 picked)
    {
        if (!approved[msg.sender]) revert NotApproved();
        Req storage q = reqs[msg.sender][aggId];
        if (q.deadline != 0) revert AlreadyStarted();
        // at least the round's quorum, fixed at request, so an owner change of `polled` cannot fail it
        uint8 count = polled < quorum_ ? quorum_ : polled;
        bytes32[] memory keys = keeper.pickBeacons(seed, cls, atBlock, atTime, count);
        picked = keys.length;
        if (picked < quorum_ || quorum_ == 0) return picked;
        uint40 dl = uint40(block.timestamp) + timeout;
        q.atBlock = uint32(atBlock);
        q.startedAt = uint40(block.timestamp);
        q.deadline = dl;
        q.quorum = quorum_;
        q.keys = keys;
        for (uint256 i = 0; i < picked; i++) emit BeaconCalled(msg.sender, aggId, i, keys[i], dl);
    }

    /**
     * @notice The stage's state for `aggregator`'s request, from the beacons' reveals at the keeper in
     *         completed blocks: ready once `quorum` values were revealed by the deadline (final),
     *         expired if the deadline passed with fewer. `readyAt` is when the quorum-th value arrived
     *         (not before the start). `payees` are the operator owners of the used values (also when
     *         expired, so the aggregator can pay the beacons that answered); an owner that cannot be
     *         read within the stipend is left out.
     */
    function result(address aggregator, bytes32 aggId)
        external
        view
        returns (uint8 state, bytes32 mix, uint256 readyAt, address[] memory payees)
    {
        Req storage q = reqs[aggregator][aggId];
        uint256 dl = q.deadline;
        if (dl == 0) return (ST_NONE, 0, 0, payees);
        uint256 n = q.keys.length;
        uint256 qn = q.quorum;
        bytes32[] memory vals = new bytes32[](n);
        uint256[] memory blks = new uint256[](n);    // 0 = no reveal that counts
        uint256[] memory ats = new uint256[](n);
        address[] memory oracles = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            (bytes32 v, uint256 blk, uint256 at, address o) = keeper.revealAfter(q.keys[i], uint256(q.atBlock) + 1);
            // completed blocks only, so the transaction order within a block cannot change the result
            if (blk != 0 && blk < block.number && at <= dl) (vals[i], blks[i], ats[i], oracles[i]) = (v, blk, at, o);
        }
        // the first qn reveals, by block, ties by index
        uint256 usedMask;
        uint256 used;
        for (; used < qn; used++) {
            uint256 best = type(uint256).max;
            uint256 bi;
            for (uint256 i = 0; i < n; i++) {
                if (blks[i] != 0 && usedMask & (1 << i) == 0 && blks[i] < best) (best, bi) = (blks[i], i);
            }
            if (best == type(uint256).max) break;
            usedMask |= 1 << bi;
        }
        if (used == qn) {
            state = ST_READY;
            for (uint256 i = 0; i < n; i++) {
                if (usedMask & (1 << i) != 0) mix = keccak256(abi.encodePacked(mix, vals[i]));
            }
            readyAt = q.startedAt;
            for (uint256 i = 0; i < n; i++) {
                if (usedMask & (1 << i) != 0 && ats[i] > readyAt) readyAt = ats[i];
            }
        } else if (block.timestamp > dl) {
            state = ST_EXPIRED;
        } else {
            return (ST_PENDING, 0, 0, payees);
        }
        payees = new address[](used);
        uint256 k;
        for (uint256 i = 0; i < n; i++) {
            if (usedMask & (1 << i) == 0) continue;
            address p = _ownerOf(oracles[i]);
            if (p != address(0)) payees[k++] = p;
        }
        assembly ("memory-safe") {   // shrink in place
            mstore(payees, k)
        }
    }

    /// @dev operator owner with a fixed stipend, copying one word: a malformed, huge or gas-burning
    ///      owner() leaves that beacon unpaid instead of breaking the draw. Reverts if the stipend is
    ///      not really available, so a caller's gas limit cannot skip the payments.
    function _ownerOf(address o) internal view returns (address) {
        if (gasleft() < OWNER_GAS + COLD_ACCOUNT + (OWNER_GAS + COLD_ACCOUNT) / 63 + 2_000) revert OutOfGas();
        uint256 w;
        assembly ("memory-safe") {
            mstore(0, 0x8da5cb5b00000000000000000000000000000000000000000000000000000000)   // owner()
            let ok := staticcall(OWNER_GAS, o, 0, 4, 0, 32)
            if and(ok, gt(returndatasize(), 31)) { w := mload(0) }
        }
        return w >> 160 == 0 ? address(uint160(w)) : address(0);
    }

    /// @notice The request's beacons, the request block B (values are the first reveals after B+1)
    ///         and the deadline.
    function getBeacons(address aggregator, bytes32 aggId)
        external
        view
        returns (bytes32[] memory keys, uint256 atBlock, uint256 deadline)
    {
        Req storage q = reqs[aggregator][aggId];
        return (q.keys, q.atBlock, q.deadline);
    }

    // ------------------------------------------------------------------ owner
    function setApproved(address aggregator, bool ok) external onlyOwner {
        approved[aggregator] = ok;
        emit Approval(aggregator, ok);
    }

    /// @dev quorum applies to new requests only (each aggregator round snapshots it at request)
    function setParams(uint8 polled_, uint8 quorum_, uint40 timeout_) external onlyOwner {
        if (quorum_ == 0 || polled_ < quorum_ || polled_ > 16 || timeout_ == 0) revert InvalidConfig();
        (polled, quorum, timeout) = (polled_, quorum_, timeout_);
    }
}
