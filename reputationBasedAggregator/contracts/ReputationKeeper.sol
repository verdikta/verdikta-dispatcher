// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOracleOwner { function owner() external view returns (address); }
interface IAuthorizedSenders { function isAuthorizedSender(address sender) external view returns (bool); }
interface IBurnableToken { function burn(uint256 amount) external; }

/**
 * @title ReputationKeeper (example implementation of TODO items 14 and 9)
 * @notice Arbiter registry, stake, two-score reputation, blocks / bans / decay, liveness freeze and
 *         reputation-weighted selection.
 *
 *         Table 1 (points) is applied through applyOutcomes(): the aggregator reports one byte per
 *         polled slot (low nibble = timeliness event, bits 4-5 = quality class, bit 7 = the arbiter
 *         committed in this round) and the keeper maps it to points, so the point values live in one
 *         place and are owner-settable.
 *
 *         Table 2 (consequences):
 *           - scores are integers 0..cap (default 1000), start at `start` (default 500);
 *           - a score that reaches 0 blocks the arbiter for lock x 2^offenses and restarts at `start`;
 *           - one offense is forgiven per `decayPeriod` clean days (lazy, applied at the next block);
 *           - the `maxOffenses`-th block is a permanent ban;
 *           - burns: burnPerBlock x 2^offenses on a block (default 0), whole stake on a ban if burnOnBan
 *             (default off);
 *           - an unanswered hash-chain (health) call older than `callDeadline` freezes the arbiter until
 *             it answers. A frozen arbiter is not scored, unless it committed in the round: a commit
 *             proves it was up, so freezing cannot be used to dodge the penalty for going silent;
 *           - a score that reaches 0 while the arbiter is already blocked restarts at `start` but adds
 *             no offense (several in-flight rounds failing together count as one incident).
 *
 *         Item 9 (two-phase request): selection is a pure function of a seed and of the selection
 *         state as of the request block B. Everything selection reads (scores, flags, block, fee,
 *         health-call times) is checkpointed by block number in one storage word per change, and class
 *         lists have checkpointed lengths, so state changes between B and the draw cannot shift the
 *         result.
 *
 *         Slot reuse: completeExit frees the arbiter's slot in each of its classes, and the next
 *         registration in that class takes a freed slot before appending. A draw reads a slot's current
 *         occupant as of B, which is still the as-of-B answer: the old occupant has been ineligible
 *         (exiting) since requestExit, at least `unbondingPeriod` (>= MIN_UNBONDING, 2 days) before its
 *         slot was freed, and a new occupant was not registered at B, or was exiting or gone. Both hold
 *         for any B less than `unbondingPeriod` old, and no draw reads a B older than MAX_DRAW_AGE
 *         (1 day; the aggregator stops draws then, and selection refuses an older B).
 *
 * @dev Selection visits the requested class's list (as of B) in a seed-derived random order (random
 *      positions without repeats, see _nextPos) and stops once the shortlist is full or after `maxScan`
 *      entries, so its cost does not grow with the pool. The order is a uniform random sample, so
 *      where an arbiter sits in the list does not matter: a cartel that registers back to back is drawn
 *      no more often than any other set of arbiters. Whether the stake meets the requirement is checkpointed too (F_UNDERSTAKED, updated when
 *      the stake changes), so a top-up after B cannot re-roll the draw; a new stakeRequirement applies
 *      to an arbiter at its next stake change.
 */
contract ReputationKeeper is Ownable {
    // ------------------------------------------------------------------ types
    uint8 private constant F_REGISTERED = 1;
    uint8 private constant F_PAUSED = 2;
    uint8 private constant F_BANNED = 4;
    uint8 private constant F_EXITING = 8;
    uint8 private constant F_CALL_PENDING = 16;   // a health call is outstanding
    uint8 private constant F_UNDERSTAKED = 32;    // stake below the requirement (checkpointed, item 9)
    uint8 private constant F_RESYNC = 64;         // chain re-synced: frozen until a call sent after it is answered

    uint8 public constant T_NONE = 0;
    uint8 public constant T_DELIVERED = 1;      // promoted and the reveal arrived (even late)
    uint8 public constant T_MISS_FINISHED = 2;  // promoted, no reveal, round still finished
    uint8 public constant T_MISS_FAILED = 3;    // promoted, no reveal, round failed
    uint8 public constant T_NOCOMMIT_FAILED = 4; // no commit, and the round failed for lack of commits
    uint8 public constant C_COMMITTED = 0x80;   // code flag: committed in this round, so scored even if frozen
    uint8 public constant Q_NONE = 0;
    uint8 public constant Q_CLOSE = 1;
    uint8 public constant Q_OFF = 2;
    uint8 public constant Q_FAR = 3;

    /// @dev selection state, one word per change (checkpointed by block number)
    struct Ck {
        uint32 fromBlock;
        uint16 quality;
        uint16 timeliness;
        uint8 flags;
        uint40 blockedUntil;
        uint64 fee;
        uint40 callSentAt;
        uint40 callAnsweredAt;
    }

    /// @dev state selection never reads
    struct Meta {
        address oracle;
        uint8 offenses;
        uint40 cleanFrom;       // decay anchor: end of the last block (or registration)
        uint40 exitAt;          // unbonding release time (0 = not exiting)
        uint96 stake;
        bytes32 jobId;
    }

    /// @dev hash-chain head, one entry per change (never overwritten): the next answer must hash to the
    ///      latest one. An answer's entry holds the revealed value, so the first entry after a block B
    ///      is the arbiter's next value as of B and when it was revealed (item 9's beacons read it)
    struct HeadCk {
        uint32 fromBlock;
        uint40 at;
        bytes32 head;
    }

    struct LenCk {
        uint32 fromBlock;
        uint224 len;
    }

    struct Points {
        uint16 gain;   // +20  delivered / close
        uint16 minor;  // -50  off
        uint16 major;  // -200 far / promoted miss in a finished round
        uint16 fail;   // -500 promoted, no reveal, round failed
        uint16 nocommit; // -400 no commit, round failed for lack of commits
        uint16 start;  // 500
        uint16 cap;    // 1000
    }

    struct Selected {
        address oracle;
        bytes32 key;
        uint256 fee;
    }

    struct SelectParams {
        uint256 count;
        uint256 alpha;
        uint256 maxFee;
        uint256 minFee;               // the round's fee floor (item 8): fees below it score as the floor
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScalingFactor;
        uint64 requestedClass;
    }

    // ------------------------------------------------------------------ errors
    error NotApproved();
    error NotArbiterOwner();
    error AlreadyRegistered();
    error AlreadyExiting();
    error NotRegistered();
    error BadClasses();
    error BadParams();
    error NoEligibleArbiters();
    error BadPreimage();
    error NotAuthorizedResponder();
    error StillBonded();
    error Blocked();
    error TransferFailed();
    error FutureBlock();
    error StaleBlock();

    // ------------------------------------------------------------------ events
    event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee);
    event ArbiterRemoved(bytes32 indexed key, uint256 refunded);
    event HealthCall(bytes32 indexed key, uint256 sentAt);
    event HealthAnswered(bytes32 indexed key, uint256 answeredAt);
    event ChainResynced(bytes32 indexed key);
    event ScoresUpdated(bytes32 indexed key, uint256 quality, uint256 timeliness);
    event ArbiterBlocked(bytes32 indexed key, uint256 until, uint256 offenses, uint256 burned);
    event ArbiterBanned(bytes32 indexed key, uint256 burned);
    event OutcomeSkippedFrozen(bytes32 indexed key);
    event ExitRequested(bytes32 indexed key, uint256 exitAt);
    event ContractApproval(address indexed aggregator, bool approved);

    // ------------------------------------------------------------------ storage
    IERC20 public immutable verdiktaToken;

    mapping(bytes32 => Ck[]) internal cks;
    mapping(bytes32 => Meta) internal metas;
    mapping(bytes32 => HeadCk[]) internal heads;
    mapping(uint64 => bytes32[]) internal classList;     // slots: 0 = freed by an exit, reused by the next join
    mapping(uint64 => LenCk[]) internal classLen;
    mapping(uint64 => uint32[]) internal freeSlots;      // freed slot indices per class
    mapping(bytes32 => uint64[]) internal classesOf;
    mapping(bytes32 => mapping(uint64 => uint32)) internal slotOf;   // slot index + 1 (0 = not listed)
    mapping(address => bool) public approvedContracts;

    Points public points = Points(20, 50, 200, 500, 400, 500, 1000);
    uint256 public stakeRequirement = 100e18;
    uint40 public lockDuration = 24 hours;
    uint40 public decayPeriod = 90 days;
    uint40 public callDeadline = 60;          // D, seconds
    uint40 public unbondingPeriod = 2 days;   // owner-set, at least MIN_UNBONDING
    /// @notice Shortest unbonding: a day for the latest draw that can still read a B from before the exit
    ///         (MAX_DRAW_AGE), then a day for that round to finish and settle, so its penalties land
    ///         before the stake is refunded. Slot reuse also needs it to be at least MAX_DRAW_AGE.
    uint40 public constant MIN_UNBONDING = 2 days;
    /// @notice Oldest request block a selection may read (the aggregator's DRAW_GRACE).
    uint40 public constant MAX_DRAW_AGE = 1 days;
    uint8 public maxOffenses = 3;
    uint96 public burnPerBlock = 0;           // VDKA wei, doubled per earlier offense
    bool public burnOnBan = false;
    uint16 public shortlistSize = 60;
    uint16 public maxScan = 400;              // bound on entries walked per selection
    uint8 public liveRandom = 3;              // extra random health calls per selection
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    constructor(address token) Ownable(msg.sender) {
        verdiktaToken = IERC20(token);
    }

    modifier onlyApproved() {
        if (!approvedContracts[msg.sender]) revert NotApproved();
        _;
    }

    function keyOf(address oracle, bytes32 jobId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(oracle, jobId));
    }

    // ================================================================== checkpoints
    function _cur(bytes32 key) internal view returns (Ck memory c) {
        Ck[] storage a = cks[key];
        uint256 n = a.length;
        if (n > 0) c = a[n - 1];
    }

    /// @dev write the current state: overwrite this block's checkpoint, or append a new one
    function _write(bytes32 key, Ck memory c) internal {
        Ck[] storage a = cks[key];
        uint256 n = a.length;
        c.fromBlock = uint32(block.number);
        if (n > 0 && a[n - 1].fromBlock == block.number) a[n - 1] = c;
        else a.push(c);
    }

    /// @dev state as of the end of block `b` (latest checkpoint with fromBlock <= b)
    function _at(bytes32 key, uint256 b) internal view returns (Ck memory c) {
        Ck[] storage a = cks[key];
        uint256 hi = a.length;
        if (hi == 0) return c;
        if (a[hi - 1].fromBlock <= b) return a[hi - 1];
        uint256 lo = 0;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (a[mid].fromBlock > b) hi = mid;
            else lo = mid + 1;
        }
        if (lo > 0) c = a[lo - 1];
    }

    function _lenAt(uint64 cls, uint256 b) internal view returns (uint256) {
        LenCk[] storage a = classLen[cls];
        uint256 hi = a.length;
        if (hi == 0) return 0;
        if (a[hi - 1].fromBlock <= b) return a[hi - 1].len;
        uint256 lo = 0;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (a[mid].fromBlock > b) hi = mid;
            else lo = mid + 1;
        }
        return lo > 0 ? a[lo - 1].len : 0;
    }

    function _onlyArbiterOwner(bytes32 key) internal view returns (Meta storage m) {
        m = metas[key];
        if (_cur(key).flags & F_REGISTERED == 0) revert NotRegistered();
        if (msg.sender != owner() && msg.sender != IOracleOwner(m.oracle).owner()) revert NotArbiterOwner();
    }

    // ================================================================== registration, stake, exit
    /// @param chainHead hash-chain head H^n(seed); health answers reveal successive preimages.
    /// @dev A returning key (after completeExit) keeps its scores and offenses: only a new key starts at
    ///      `start`. Its slots were freed at the exit, so `classes` sets its classes afresh, each taking a
    ///      freed slot if one is waiting (see the contract notes on slot reuse).
    function registerArbiter(address oracle, bytes32 jobId, uint64 fee, uint64[] calldata classes, bytes32 chainHead)
        external
    {
        if (oracle.code.length == 0 || fee == 0) revert BadParams();
        if (classes.length == 0 || classes.length > 5) revert BadClasses();
        if (msg.sender != owner() && msg.sender != IOracleOwner(oracle).owner()) revert NotArbiterOwner();
        bytes32 key = keyOf(oracle, jobId);
        Ck memory c = _cur(key);
        if (c.flags & F_REGISTERED != 0) revert AlreadyRegistered();

        uint256 req = stakeRequirement;
        if (!verdiktaToken.transferFrom(msg.sender, address(this), req)) revert TransferFailed();

        Meta storage m = metas[key];
        bool returning = cks[key].length > 0;
        m.oracle = oracle;
        if (!returning) m.cleanFrom = uint40(block.timestamp);
        m.exitAt = 0;
        m.stake = uint96(req);
        m.jobId = jobId;
        _setHead(key, chainHead);
        if (!returning) {
            uint16 st = points.start;
            c.quality = st;
            c.timeliness = st;
        }
        c.flags = F_REGISTERED;
        c.fee = fee;
        c.callSentAt = 0;
        c.callAnsweredAt = 0;
        // head 0: the node sets its chain with its first answer (a re-sync); frozen until then
        if (chainHead == bytes32(0)) _resyncFreeze(c);
        _write(key, c);
        // a freed slot first (see the contract notes), else append. A returning arbiter's slots were
        // freed at its exit, so it takes its classes from this registration like a new one
        for (uint256 i = 0; i < classes.length; i++) {
            uint64 cl = classes[i];
            if (slotOf[key][cl] != 0) continue;
            classesOf[key].push(cl);
            bytes32[] storage list = classList[cl];
            uint32[] storage free = freeSlots[cl];
            uint256 nf = free.length;
            uint256 pos;
            if (nf > 0) {
                pos = free[nf - 1];
                free.pop();
                list[pos] = key;
            } else {
                pos = list.length;
                list.push(key);
                LenCk[] storage lc = classLen[cl];
                uint256 n = lc.length;
                if (n > 0 && lc[n - 1].fromBlock == block.number) lc[n - 1].len = uint224(list.length);
                else lc.push(LenCk(uint32(block.number), uint224(list.length)));
            }
            slotOf[key][cl] = uint32(pos + 1);
        }
        emit ArbiterRegistered(key, oracle, jobId, fee);
    }

    function setPaused(bytes32 key, bool paused) external {
        _onlyArbiterOwner(key);
        Ck memory c = _cur(key);
        c.flags = paused ? (c.flags | F_PAUSED) : (c.flags & ~F_PAUSED);
        _write(key, c);
    }

    function setFee(bytes32 key, uint64 fee) external {
        _onlyArbiterOwner(key);
        if (fee == 0) revert BadParams();
        Ck memory c = _cur(key);
        c.fee = fee;
        _write(key, c);
    }

    /// @dev arbiter owner only: a top-up re-applies the current stakeRequirement, which nobody else
    ///      should be able to trigger
    function topUpStake(bytes32 key, uint96 amount) external {
        _onlyArbiterOwner(key);
        Ck memory c = _cur(key);
        if (!verdiktaToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint96 st = metas[key].stake + amount;
        metas[key].stake = st;
        _stakeFlag(c, st);
        _write(key, c);
    }

    function _stakeFlag(Ck memory c, uint256 st) internal view {
        if (st < stakeRequirement) c.flags |= F_UNDERSTAKED;
        else c.flags &= ~F_UNDERSTAKED;
    }

    /// @notice Start unbonding. The arbiter is no longer selected but blocks and bans still apply.
    function requestExit(bytes32 key) external {
        Meta storage m = _onlyArbiterOwner(key);
        Ck memory c = _cur(key);
        if (c.flags & F_EXITING != 0) revert AlreadyExiting();   // a second request would restart the clock
        c.flags |= F_EXITING;
        _write(key, c);
        m.exitAt = uint40(block.timestamp) + unbondingPeriod;
        emit ExitRequested(key, m.exitAt);
    }

    /// @notice Finish unbonding: refund the remaining stake to the arbiter's owner. A banned key keeps
    ///         its record (a tombstone), so it can never register again. Frees the arbiter's slot in each
    ///         of its classes for the next registration (see the contract notes). The operator owner or
    ///         the keeper owner can do it, also for a frozen arbiter: a freeze exists to get a broken
    ///         arbiter fixed or removed. An outstanding call is dropped, which cannot matter: unbonding is
    ///         at least MIN_UNBONDING (2 days), and every round or beacon stage that could have called
    ///         the arbiter read a B from before its requestExit, so it ended long before.
    function completeExit(bytes32 key) external {
        Meta storage m = _onlyArbiterOwner(key);
        Ck memory c = _cur(key);
        if (c.flags & F_EXITING == 0 || block.timestamp < m.exitAt) revert StillBonded();
        if (c.blockedUntil > block.timestamp) revert Blocked();
        uint256 refund = m.stake;
        address to = IOracleOwner(m.oracle).owner();
        m.stake = 0;
        if (c.flags & F_BANNED == 0) c.flags = 0;     // unregistered; may register again later
        _write(key, c);
        uint64[] storage cs = classesOf[key];
        for (uint256 i = 0; i < cs.length; i++) {
            uint64 cl = cs[i];
            uint256 pos = slotOf[key][cl] - 1;
            classList[cl][pos] = bytes32(0);
            freeSlots[cl].push(uint32(pos));
            delete slotOf[key][cl];
        }
        delete classesOf[key];
        if (refund > 0 && !verdiktaToken.transfer(to, refund)) revert TransferFailed();
        emit ArbiterRemoved(key, refund);
    }

    // ================================================================== liveness (items 6, 7)
    /// @notice Answer the outstanding health call by revealing the next hash-chain preimage (exactly one
    ///         step). Sent by the node (an authorized sender of its operator) or the arbiter's owner.
    ///         Answering at any time after a freeze unfreezes the arbiter.
    ///         A value that does not hash to the head re-syncs the chain instead (see _answer): a node
    ///         whose chain does not match the head (registered with head 0, or its chain files lost)
    ///         sends the head of a fresh chain and is frozen until it answers a call sent after that.
    function answerHealthCall(bytes32 key, bytes32 preimage) external {
        _answer(key, preimage, preimage, msg.sender);
    }

    /// @notice Answer (as above) and replace the hash chain in the same transaction, before the current
    ///         one runs out. The answer comes from the old chain; the new head applies to later calls
    ///         only, so a rotation cannot choose the value of a call already sent.
    ///         With newHead == preimage it is exactly answerHealthCall (the node's health job always sends
    ///         rotateChain), re-sync included. A rotation to a different head needs a valid preimage.
    function rotateChain(bytes32 key, bytes32 preimage, bytes32 newHead) external {
        _answer(key, preimage, newHead, msg.sender);
    }

    /// @notice Item 7's self-service health call: the arbiter's owner or node asks for a call, to end a
    ///         re-sync or after a restart, so recovery does not wait for selection or the keeper owner.
    function requestHealthCall(bytes32 key) external {
        Meta storage m = metas[key];
        if (_cur(key).flags & F_REGISTERED == 0) revert NotRegistered();
        _onlyResponder(m.oracle, msg.sender);
        _call(key);
    }

    function _onlyResponder(address oracle, address responder) internal view {
        if (responder == IOracleOwner(oracle).owner()) return;
        try IAuthorizedSenders(oracle).isAuthorizedSender(responder) returns (bool ok) {
            if (!ok) revert NotAuthorizedResponder();
        } catch {
            revert NotAuthorizedResponder();
        }
    }

    /**
     * @dev An answer. A preimage of the head is revealed (readable by revealAfter) and ends an outstanding
     *      call. A value that is not one re-syncs the chain (a rotation to another head reverts instead):
     *      it becomes the new head and the arbiter is frozen until it answers a call sent after the
     *      re-sync. That call comes from selection, the owner, requestHealthCall, or the arbiter's first
     *      valid answer after the re-sync, which sends it (so a node needs no other transaction).
     *      A re-synced value is never a beacon value: revealAfter takes only a value that hashes to the head
     *      before it, so a beacon that re-syncs after B+1 counts as having withheld. The next value was
     *      fixed at the re-sync, as at a rotation, and the freeze is one the arbiter could get by not
     *      answering. So a re-sync gives no choice of beacon value and no dodge it does not have already.
     */
    function _answer(bytes32 key, bytes32 preimage, bytes32 nextHead, address responder) internal {
        Meta storage m = metas[key];
        Ck memory c = _cur(key);
        if (c.flags & F_REGISTERED == 0) revert NotRegistered();
        _onlyResponder(m.oracle, responder);
        if (keccak256(abi.encodePacked(preimage)) != _headAt(key, block.number)) {
            if (nextHead != preimage) revert BadPreimage();
            _setHead(key, preimage);                     // not a reveal: revealAfter's keccak check skips it
            _resyncFreeze(c);
            _write(key, c);
            emit ChainResynced(key);
            return;
        }
        _setHead(key, preimage);                         // the revealed value, readable by revealAfter
        if (nextHead != preimage) _setHead(key, nextHead);   // a rotation: the new chain applies from here
        if (c.flags & F_RESYNC != 0) {
            // the first valid answer after a re-sync sends the call it waits for; still frozen until answered
            c.flags &= ~F_RESYNC;
            _write(key, c);
            emit HealthCall(key, block.timestamp);
        } else if (c.flags & F_CALL_PENDING != 0) {
            // only an answer to an outstanding call moves callAnsweredAt (round-end freeze checks rely on it)
            c.callAnsweredAt = uint40(block.timestamp);
            c.flags &= ~F_CALL_PENDING;
            _write(key, c);
        }
        emit HealthAnswered(key, block.timestamp);
    }

    /// @dev frozen from now on (not before: callSentAt + D is moved to now - 1 at the latest, so a past
    ///      round end is judged as it was), with a call pending that only a later call can be answered for
    function _resyncFreeze(Ck memory c) internal view {
        uint256 d = uint256(callDeadline) + 1;
        uint256 back = block.timestamp > d ? block.timestamp - d : 0;
        if (c.flags & F_CALL_PENDING == 0 || c.callSentAt > back) c.callSentAt = uint40(back);
        c.flags |= F_CALL_PENDING | F_RESYNC;
    }

    /// @notice Owner: send health calls to many arbiters at once (e.g. after a wide outage).
    function _setHead(bytes32 key, bytes32 h) internal {
        heads[key].push(HeadCk(uint32(block.number), uint40(block.timestamp), h));
    }

    /// @dev index of the first head entry after block `b` (the array length if none)
    function _headIdxAfter(HeadCk[] storage a, uint256 b) internal view returns (uint256 lo) {
        uint256 hi = a.length;
        if (hi == 0 || a[hi - 1].fromBlock <= b) return hi;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (a[mid].fromBlock > b) hi = mid;
            else lo = mid + 1;
        }
    }

    /// @dev head as of the end of block `b` (0 if the key had none yet)
    function _headAt(bytes32 key, uint256 b) internal view returns (bytes32) {
        HeadCk[] storage a = heads[key];
        uint256 i = _headIdxAfter(a, b);
        return i > 0 ? a[i - 1].head : bytes32(0);
    }

    /**
     * @notice The arbiter's first hash-chain value revealed after block `b` (by any answer to a health
     *         call, or a rotation), with the block and time of the reveal; zeros if none yet. The value
     *         is the preimage of the head as of `b`, so it was fixed at `b` and only its timing is the
     *         arbiter's choice. Item 9's beacons use it as the beacon value, with `b` = B+1.
     */
    function revealAfter(bytes32 key, uint256 b)
        external
        view
        returns (bytes32 value, uint256 blk, uint256 at, address oracle)
    {
        HeadCk[] storage a = heads[key];
        uint256 i = _headIdxAfter(a, b);
        oracle = metas[key].oracle;
        // the keccak check skips a re-registration's new head (no reveal)
        if (i == 0 || i == a.length || keccak256(abi.encodePacked(a[i].head)) != a[i - 1].head) return (0, 0, 0, oracle);
        return (a[i].head, a[i].fromBlock, a[i].at, oracle);
    }

    function sendHealthCalls(bytes32[] calldata keys) external onlyOwner {
        for (uint256 i = 0; i < keys.length; i++) _call(keys[i]);
    }

    function _call(bytes32 key) internal {
        Ck memory c = _cur(key);
        // keep the earlier deadline if a call is already outstanding. A pending flag, not a time
        // comparison: Base timestamps are whole seconds, so a call sent in the same second as the last
        // answer would otherwise look answered.
        if (c.flags & F_CALL_PENDING == 0) {
            c.callSentAt = uint40(block.timestamp);
            c.flags |= F_CALL_PENDING;
            _write(key, c);
            emit HealthCall(key, block.timestamp);
        } else if (c.flags & F_RESYNC != 0) {
            // the call a re-sync waits for: answerable now; the arbiter stays frozen until it is answered
            c.flags &= ~F_RESYNC;
            _write(key, c);
            emit HealthCall(key, block.timestamp);
        }
    }

    /// @dev frozen at a past time t: a call sent more than D before t and not answered by t. Lossy if a
    ///      later call has replaced it, but a later call means the arbiter was selectable, so unfrozen.
    function _frozenWhen(Ck memory c, uint256 t) internal view returns (bool) {
        if (uint256(c.callSentAt) + callDeadline >= t) return false;
        return c.flags & F_CALL_PENDING != 0 || c.callAnsweredAt > t;
    }

    function _frozenAt(Ck memory c, uint256 t) internal view returns (bool) {
        return c.flags & F_CALL_PENDING != 0 && t > uint256(c.callSentAt) + callDeadline;
    }

    // ================================================================== selection
    function _eligibleAt(Ck memory c, uint256 maxFee, uint256 t) internal view returns (bool) {
        uint8 f = c.flags;
        if (f & (F_PAUSED | F_BANNED | F_EXITING) != 0 || f & F_REGISTERED == 0) return false;
        if (f & F_UNDERSTAKED != 0 || c.blockedUntil > t || c.fee > maxFee) return false;
        return !_frozenAt(c, t);
    }

    function _weight(Ck memory c, SelectParams calldata sp) internal view returns (uint256) {
        uint256 rep = ((1000 - sp.alpha) * c.quality + sp.alpha * c.timeliness) / 1000;  // 0..cap
        uint256 w = 1000 + rep * 1000 / points.cap;                                       // 1000..2000
        // Score the fee the requester pays: below the floor every arbiter costs the same, so a near-zero
        // posted fee wins no weight (item 8). A fee at or below the base cost gets the full boost (v1 gave
        // it none, while a fee just above the base cost got nearly the full boost).
        uint256 fee = c.fee < sp.minFee ? sp.minFee : c.fee;
        uint256 maxScaling = sp.maxFeeBasedScalingFactor * 1e18;
        uint256 ratio = fee > sp.estimatedBaseCost
            ? (sp.maxFee - sp.estimatedBaseCost) * 1e18 / (fee - sp.estimatedBaseCost)
            : maxScaling;
        if (ratio > maxScaling) ratio = maxScaling;
        if (ratio > 1e18) w = w * ratio / 1e18;
        return w;
    }

    /**
     * @notice Select `count` arbiters from the state as of block `atBlock` (timestamp `atTime`), using
     *         only `seed` for randomness, then send health calls to the jurors and `liveRandom` other
     *         shortlisted arbiters.
     * @dev With fewer eligible (shortlisted) arbiters than `count`, all of them are drawn and the remaining
     *      slots repeat them in draw order (slot k holds pick k mod m), so a thin pool (testing, start-up, a
     *      niche class) still gets an answer from what is there. A repeated arbiter answers, is paid and is
     *      scored once per slot. With hundreds of arbiters per class this never happens; the aggregator caps
     *      `count` at the shortlist size, so repeats only come from a pool that has fewer eligible.
     */
    function selectArbiters(SelectParams calldata sp, bytes32 seed, uint256 atBlock, uint256 atTime)
        external
        onlyApproved
        returns (Selected[] memory sel)
    {
        if (sp.alpha > 1000 || sp.count == 0 || sp.estimatedBaseCost >= sp.maxFee || sp.maxFeeBasedScalingFactor < 1)
            revert BadParams();
        if (atBlock >= block.number) revert FutureBlock();
        if (atTime + MAX_DRAW_AGE < block.timestamp) revert StaleBlock();
        bytes32[] storage list = classList[sp.requestedClass];
        uint256 n = _lenAt(sp.requestedClass, atBlock);
        if (n == 0) revert NoEligibleArbiters();

        uint256 s = uint256(seed);
        uint256 cap = shortlistSize;
        uint256 scanLimit = maxScan < n ? maxScan : n;
        Walk memory wk = _walk(seed, n, scanLimit);
        bytes32[] memory sk = new bytes32[](cap);
        uint256[] memory w = new uint256[](cap);
        uint256[] memory fees = new uint256[](cap);   // fee as of B: a later fee change cannot break the draw
        uint256 m;
        uint256 total;
        for (uint256 i = 0; i < scanLimit && m < cap; i++) {
            bytes32 key = list[_nextPos(wk)];
            if (key == bytes32(0)) continue;          // a freed slot (counts as a visit)
            Ck memory c = _at(key, atBlock);
            if (_eligibleAt(c, sp.maxFee, atTime)) {
                sk[m] = key;
                fees[m] = c.fee;
                uint256 wi = _weight(c, sp);
                w[m] = wi;
                total += wi;
                m++;
            }
        }
        if (m == 0) revert NoEligibleArbiters();

        sel = new Selected[](sp.count);
        bool[] memory taken = new bool[](m);
        uint256 remaining = total;
        for (uint256 k = 0; k < sp.count; k++) {
            if (k >= m) {
                sel[k] = sel[k % m];                   // a thin pool: repeat in draw order
                continue;
            }
            uint256 pick;
            uint256 pivot = uint256(keccak256(abi.encodePacked(seed, k))) % remaining;
            uint256 acc;
            for (pick = 0; pick < m; pick++) {
                if (taken[pick]) continue;
                acc += w[pick];
                if (acc > pivot) break;
            }
            taken[pick] = true;
            remaining -= w[pick];
            sel[k] = Selected(metas[sk[pick]].oracle, sk[pick], fees[pick]);
            _call(sk[pick]);                       // every juror gets a health call
        }
        uint256 probes = liveRandom;
        uint256 p0 = (s >> 8) % m;
        for (uint256 j = 0; j < m && probes > 0; j++) {
            uint256 p = (p0 + j) % m;
            if (!taken[p]) {
                _call(sk[p]);
                probes--;
            }
        }
    }

    /**
     * @notice Pick up to `count` beacons for a draw (item 9's beacon flag) from `cls`, entirely from the
     *         state as of block `atBlock` (time `atTime`): registered, and not paused, banned, exiting,
     *         under-staked, blocked or frozen. Each beacon gets a health call, and its beacon value is
     *         its next hash-chain value as of block B+1 (revealAfter): its answer to that call, or to
     *         an earlier one if it answered after B+1. The value was fixed by the end of B+1, so
     *         nothing later (who starts the stage, when, or a chain rotation) changes the pick or the
     *         values.
     * @dev Visits the class list in a seed-derived random order (as selection does), at most `maxScan`
     *      entries. Fewer than `count` are returned only if the walk finds fewer.
     */
    function pickBeacons(bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint256 count)
        external
        onlyApproved
        returns (bytes32[] memory keys)
    {
        if (atBlock >= block.number) revert FutureBlock();
        if (atTime + MAX_DRAW_AGE < block.timestamp) revert StaleBlock();
        keys = new bytes32[](count);
        uint256 n = _lenAt(cls, atBlock);
        uint256 m;
        if (n > 0) {
            bytes32[] storage list = classList[cls];
            uint256 scanLimit = maxScan < n ? maxScan : n;
            Walk memory wk = _walk(seed, n, scanLimit);
            for (uint256 i = 0; i < scanLimit && m < count; i++) {
                bytes32 key = list[_nextPos(wk)];
                if (key == bytes32(0)) continue;      // a freed slot (counts as a visit)
                Ck memory c = _at(key, atBlock);
                if (c.flags & (F_REGISTERED | F_PAUSED | F_BANNED | F_EXITING | F_UNDERSTAKED) == F_REGISTERED
                    && c.blockedUntil <= atTime && !_frozenAt(c, atTime)) {
                    keys[m] = key;
                    m++;
                    _call(key);
                }
            }
        }
        assembly ("memory-safe") {   // shrink in place (lengths only decrease)
            mstore(keys, m)
        }
    }

    /// @dev The visiting order of a selection walk: random positions in [0, n) without repeats.
    struct Walk {
        uint256 seen;    // memory pointer to a bitmap of visited positions, one bit per list entry
        uint256 n;
        bytes32 key;     // keccak256(seed, "walk"): separate from the seed's other uses (the weighted picks)
        uint256 ctr;     // keccak counter
        uint256 pool;    // unused random bits
        uint256 left;    // 32-bit draws left in pool
        uint256 draws;   // random draws left before the sweep
        uint256 sweep;   // next position of the sweep
    }

    /// @dev A walk that visits up to `limit` (<= n) positions of a list of length n.
    function _walk(bytes32 seed, uint256 n, uint256 limit) internal pure returns (Walk memory w) {
        uint256[] memory seen = new uint256[]((n + 255) >> 8);   // zeroed; n / 256 words
        uint256 ptr;
        assembly ("memory-safe") {
            ptr := add(seen, 32)
        }
        bytes32 key = keccak256(abi.encodePacked(seed, "walk"));
        w = Walk(ptr, n, key, 0, 0, 0, 2 * limit, uint256(key) % n);
    }

    /**
     * @dev The next unvisited position: a uniform random sample without replacement. Each keccak gives
     *      eight 32-bit draws, each taken mod n (a relative bias below n / 2^32), and a draw that hits a
     *      visited position is discarded. Random draws find the last unvisited positions slowly, so
     *      after 2 x limit draws the walk finishes with a sweep from a random start over the unvisited
     *      positions: the cost stays bounded, every position can still be reached (so `scansAll` holds),
     *      and the sweep only runs once most of the list has been visited without filling the
     *      shortlist, when nearly every eligible entry is taken anyway. The caller visits at most n.
     */
    function _nextPos(Walk memory w) internal pure returns (uint256 y) {
        uint256 seen = w.seen;
        uint256 n = w.n;
        unchecked {
            while (w.draws != 0) {
                w.draws--;
                if (w.left == 0) {
                    w.pool = uint256(keccak256(abi.encodePacked(w.key, w.ctr++)));
                    w.left = 8;
                }
                y = (w.pool & 0xffffffff) % n;
                w.pool >>= 32;
                w.left--;
                if (_mark(seen, y)) return y;
            }
            while (true) {
                y = w.sweep;
                w.sweep = y + 1 == n ? 0 : y + 1;
                if (_mark(seen, y)) return y;
            }
        }
    }

    /// @dev set bit y of the bitmap at `seen`; false if it was already set
    function _mark(uint256 seen, uint256 y) private pure returns (bool fresh) {
        assembly ("memory-safe") {
            let slot := add(seen, shl(5, shr(8, y)))
            let word := mload(slot)
            let bit := shl(and(y, 255), 1)
            fresh := iszero(and(word, bit))
            if fresh { mstore(slot, or(word, bit)) }
        }
    }

    // ================================================================== scoring (Table 1 -> Table 2)
    /**
     * @notice Apply one round's outcomes. codes[i]: low nibble timeliness event, bits 4-5 quality
     *         class, bit 7 committed. Frozen arbiters that did not commit are skipped (being down is
     *         handled by the freeze, never by points); a commit proves the arbiter was up.
     */
    /// @param roundEnd the round's deadline: being frozen is judged then, not at settlement, so an arbiter
    ///        that recovers before settlement is not charged for the outage, and one that stays frozen
    ///        past settlement gains nothing it would not have had at round end
    function applyOutcomes(bytes32[] calldata keys, uint8[] calldata codes, uint256 roundEnd) external onlyApproved {
        if (keys.length != codes.length) revert BadParams();
        Points memory pt = points;
        uint256 burnTotal;
        for (uint256 i = 0; i < keys.length; i++) {
            uint8 code = codes[i];
            if (code == 0) continue;
            bytes32 key = keys[i];
            Ck memory c = _cur(key);
            if (c.flags & F_REGISTERED == 0 || c.flags & F_BANNED != 0) continue;
            if (code & C_COMMITTED == 0 && _frozenWhen(c, roundEnd)) {
                emit OutcomeSkippedFrozen(key);
                continue;
            }
            int256 t = int256(uint256(c.timeliness));
            int256 q = int256(uint256(c.quality));
            uint8 te = code & 0x0F;
            uint8 qe = (code >> 4) & 0x03;
            if (te == T_DELIVERED) t += int256(uint256(pt.gain));
            else if (te == T_MISS_FINISHED) t -= int256(uint256(pt.major));
            else if (te == T_MISS_FAILED) t -= int256(uint256(pt.fail));
            else if (te == T_NOCOMMIT_FAILED) t -= int256(uint256(pt.nocommit));
            if (qe == Q_CLOSE) q += int256(uint256(pt.gain));
            else if (qe == Q_OFF) q -= int256(uint256(pt.minor));
            else if (qe == Q_FAR) q -= int256(uint256(pt.major));
            int256 capI = int256(uint256(pt.cap));
            if (t > capI) t = capI;
            if (q > capI) q = capI;
            bool hit = false;
            if (t <= 0) { t = int256(uint256(pt.start)); hit = true; }
            if (q <= 0) { q = int256(uint256(pt.start)); hit = true; }
            c.timeliness = uint16(uint256(t));
            c.quality = uint16(uint256(q));
            if (hit) burnTotal += _block(key, c);
            _write(key, c);
            emit ScoresUpdated(key, uint256(q), uint256(t));
        }
        if (burnTotal > 0) _burn(burnTotal);
    }

    /// @dev Block with lazy offense decay (updates `c` in memory); returns the VDKA to burn. A hit while
    ///      already blocked (another in-flight round settling) adds no offense and no burn.
    function _block(bytes32 key, Ck memory c) internal returns (uint256 burned) {
        if (c.blockedUntil > block.timestamp) return 0;
        Meta storage m = metas[key];
        uint256 offenses = m.offenses;
        if (offenses > 0 && block.timestamp > m.cleanFrom) {
            uint256 forgiven = (block.timestamp - m.cleanFrom) / decayPeriod;
            offenses = forgiven >= offenses ? 0 : offenses - forgiven;
        }
        uint256 dur = uint256(lockDuration) << offenses;
        uint40 until = uint40(block.timestamp + dur);
        c.blockedUntil = until;
        m.cleanFrom = until;
        uint256 b = uint256(burnPerBlock) << offenses;
        offenses += 1;
        m.offenses = uint8(offenses);
        bool ban = offenses >= maxOffenses;
        if (ban) {
            c.flags |= F_BANNED;
            if (burnOnBan) b = m.stake;
        }
        if (b > m.stake) b = m.stake;
        m.stake -= uint96(b);
        _stakeFlag(c, m.stake);
        burned = b;
        emit ArbiterBlocked(key, until, offenses, b);
        if (ban) emit ArbiterBanned(key, b);
    }

    function _burn(uint256 amount) internal {
        try IBurnableToken(address(verdiktaToken)).burn(amount) {} catch {
            if (!verdiktaToken.transfer(DEAD, amount)) revert TransferFailed();
        }
    }

    // ================================================================== views
    struct ArbiterView {
        address oracle;
        uint256 quality;
        uint256 timeliness;
        uint256 offenses;
        uint256 flags;
        uint256 blockedUntil;
        uint256 fee;
        uint256 callSentAt;
        uint256 callAnsweredAt;
        uint256 stake;
        uint256 checkpoints;
        uint256 exitAt;          // when completeExit is allowed (0 = not exiting)
    }

    function getArbiter(bytes32 key) external view returns (ArbiterView memory v) {
        Ck memory c = _cur(key);
        Meta storage m = metas[key];
        v = ArbiterView(m.oracle, c.quality, c.timeliness, m.offenses, c.flags, c.blockedUntil, c.fee,
            c.callSentAt, c.callAnsweredAt, m.stake, cks[key].length, m.exitAt);
    }

    function jobIdOf(bytes32 key) external view returns (bytes32) {
        return metas[key].jobId;
    }

    /// @notice The classes the arbiter is registered in (emptied by completeExit; its slots are freed).
    function arbiterClasses(bytes32 key) external view returns (uint64[] memory) {
        return classesOf[key];
    }

    function isFrozen(bytes32 key) external view returns (bool) {
        return _frozenAt(_cur(key), block.timestamp);
    }

    /// @notice What an arbiter's node needs to answer its health calls: whether a call is outstanding,
    ///         when it was sent, and the current hash-chain head (the next answer is its preimage).
    ///         One call, so a Chainlink job can read it with a single ethcall (TODO item 16).
    function healthState(bytes32 key) external view returns (bool pending, uint256 sentAt, bytes32 head) {
        Ck memory c = _cur(key);
        pending = c.flags & F_CALL_PENDING != 0;         // also while re-syncing: the next answer sends the call
        sentAt = c.callSentAt;
        HeadCk[] storage a = heads[key];
        if (a.length > 0) head = a[a.length - 1].head;
    }

    function isEligible(bytes32 key, uint256 maxFee) external view returns (bool) {
        return _eligibleAt(_cur(key), maxFee, block.timestamp);
    }

    /// @notice Number of arbiters currently eligible for `cls` at fee ceiling `maxFee` (off-chain view).
    function eligibleCount(uint64 cls, uint256 maxFee) external view returns (uint256 c) {
        bytes32[] storage list = classList[cls];
        for (uint256 i = 0; i < list.length; i++) {
            bytes32 k = list[i];
            if (_eligibleAt(_cur(k), maxFee, block.timestamp)) c++;
        }
    }

    /// @notice Slots in the class list, including freed ones (what a selection walks)
    function classSize(uint64 cls) external view returns (uint256) {
        return classList[cls].length;
    }

    /// @notice Freed slots waiting for the next registration in `cls`
    function freeSlotCount(uint64 cls) external view returns (uint256) {
        return freeSlots[cls].length;
    }

    /// @notice The arbiter's slot index in `cls` plus one (0 = not listed)
    function slotIn(bytes32 key, uint64 cls) external view returns (uint256) {
        return slotOf[key][cls];
    }

    /// @notice Whether a selection walks the whole class list, so that whether it finds enough
    ///         eligible arbiters does not depend on the seed (lists never shrink, freed slots are reused,
    ///         so this holds as of B too)
    function scansAll(uint64 cls) external view returns (bool) {
        return classList[cls].length <= maxScan;
    }

    // ================================================================== owner configuration
    /// @notice v1 name for approvedContracts, kept because every deployed ArbiterOperator gates requests
    ///         with rk.isContractApproved(requester) for each keeper on its list (and checks the function
    ///         exists when the keeper is added). Without it every dispatch to a real operator reverts.
    function isContractApproved(address c) external view returns (bool) {
        return approvedContracts[c];
    }

    function setApproved(address aggregator, bool ok) external onlyOwner {
        approvedContracts[aggregator] = ok;
        emit ContractApproval(aggregator, ok);
    }

    function setPoints(Points calldata p) external onlyOwner {
        if (p.cap == 0 || p.start == 0 || p.start > p.cap) revert BadParams();
        points = p;
    }

    /// @dev `unbonding` applies to exits requested from now on, and must be at least MIN_UNBONDING
    function setTiming(uint40 lock, uint40 decay, uint40 deadline, uint40 unbonding) external onlyOwner {
        if (decay == 0 || unbonding < MIN_UNBONDING) revert BadParams();
        lockDuration = lock;
        decayPeriod = decay;
        callDeadline = deadline;
        unbondingPeriod = unbonding;
    }

    function setPenalties(uint8 _maxOffenses, uint96 _burnPerBlock, bool _burnOnBan) external onlyOwner {
        if (_maxOffenses == 0 || _maxOffenses > 16) revert BadParams();
        maxOffenses = _maxOffenses;
        burnPerBlock = _burnPerBlock;
        burnOnBan = _burnOnBan;
    }

    function setSelection(uint16 _shortlist, uint16 _maxScan, uint8 _liveRandom) external onlyOwner {
        if (_shortlist == 0 || _maxScan < _shortlist) revert BadParams();
        shortlistSize = _shortlist;
        maxScan = _maxScan;
        liveRandom = _liveRandom;
    }

    function setStakeRequirement(uint256 s) external onlyOwner {
        stakeRequirement = s;
    }
}
