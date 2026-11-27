// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ReputationKeeper.sol";
import "./AggregatorLib.sol";
import "./ScoringLib.sol";

interface IOracleOwnerAgg { function owner() external view returns (address); }

interface IJuryBeacons {
    function quorum() external view returns (uint8);
    function start(bytes32 aggId, bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint8 quorum_, uint256 maxFee)
        external
        returns (uint256 picked);
    function result(address aggregator, bytes32 aggId)
        external
        view
        returns (uint8 state, bytes32 mix, uint256 readyAt, address[] memory payees);
}

/**
 * @title ReputationAggregator (example implementation of TODO items 14, 9, 11, 8, 4 and 5)
 * @notice Commit-reveal aggregation with ETH escrow (as today), plus:
 *   - two-phase request (item 9): the request only escrows and records the query in block B; the jury
 *     is drawn by drawJury() from block B+2 with seed keccak256(aggId, blockhash(B+1)) and the
 *     keeper's state as of B, so nobody can predict or re-roll it when the request is signed. The
 *     drawer earns 2 x the per-arbiter fee (the requester only, for the first 30 s). Block hashes are
 *     read with BLOCKHASH within 256 blocks (51 s at Base's 0.2 s blocks) and from the EIP-2935
 *     history contract up to 8,191 blocks (~27 min). Rounds never expire before the draw; a round
 *     whose seed was never sealed within that window is cancelled to the arbiter pool, never refunded
 *     (a refund would be a free re-roll). A draw that finds no eligible arbiter fails and refunds;
 *   - optional beacons (item 9's per-request flag, for Jumbo): the first drawJury() starts the beacon
 *     stage in JuryBeacons, a second one draws with keccak256(aggId, blockhash(B+1), mix of the first
 *     `quorum` beacon values) once they are in. Each used beacon is paid one fee. If the quorum is
 *     missed by the beacon deadline the round ends with no result and the unspent prepay goes to the
 *     arbiter pool (a refund would be a free re-roll);
 *   - M+ / T+ promotion (item 14): the commit phase closes at the M+-th commit (M+ = M + ceil((K-M)/2)),
 *     or once T+ has passed since the draw with at least M commits. Closing records block C, and
 *     promote() draws M of all commits received from block C+2 with
 *     keccak256(aggId, "promote", blockhash(C+1)), so the arbiter that closes the phase cannot
 *     predict the draw and answering early earns nothing;
 *   - late reveals: promoted arbiters may reveal until the round deadline, after finalization; late
 *     reveals are classified on arrival against the stored median and spread;
 *   - settlement after the deadline: one batched keeper call carrying every slot's outcome code
 *     (Table 1), with failed rounds settled on the same path;
 *   - a settlement queue: every new request settles due rounds in queue order until settlePerRequest x
 *     its K slots are spent (the last may overshoot, so the first due round is always settled); a round not yet due stops the walk, so rounds
 *     behind a long-timeout round wait for it or for anyone's settle();
 *   - getOutcomeScores (item 11): every counted reveal's score for one outcome, so a consumer can
 *     apply a Q-of-N rule (item 12).
 *   - a requester-set jury (item 15): K/M/N/P and the round timeout come with each request, within the
 *     owner's bounds (maxJury, at most the keeper's shortlist; maxTimeout; above T+), so one deployment
 *     serves every bounty class; each new request settles due rounds within a budget of
 *     settlePerRequest x its own K slots;
 *   - a requester-set fee floor (item 8): each juror is paid max(its posted fee, minFee), and its bonus
 *     scales off that, so a requester can make every attempt cost at least K x minFee. Eligibility
 *     still uses the ceiling only;
 *   - commits bound to the round (items 4 and 5): keccak256(abi.encode(aggId, operator, response, salt)),
 *     all 32 bytes, with a 128-bit salt, so no commit can be opened two ways in practice;
 *   - no treasury: a round with M commits that was never promoted shares its unspent prepay equally among
 *     the slots that committed (CommitPayment); every other forfeit credits the arbiter pool
 *     (ethOwed[address(0)], which nobody can withdraw), and each successful draw pays an eighth of the
 *     pool to one registered arbiter that the keeper picks from the draw's seed (PoolPayment).
 *   Calls to arbiter contracts get a fixed gas stipend, and every call whose failure is tolerated
 *   first checks that enough gas is left, so neither an arbiter (gas bomb) nor a caller (a tight
 *   gas limit) can make one slot, or the keeper's settlement, fail on purpose.
 * @dev Round ids are sequential (aggId = bytes32(roundId)), which lets a Chainlink request id map to
 *      (round, slot) in a single storage word. Scores are on the arbiters' 0..1,000,000 scale.
 */
contract ReputationAggregator is Ownable, ReentrancyGuardTransient, Pausable {

    // ------------------------------------------------------------------ constants
    uint8 private constant PH_DRAW = 1;           // escrowed, awaiting the jury draw
    uint8 private constant PH_BEACON = 2;         // sealed, awaiting the beacon values
    uint8 private constant PH_COMMIT = 3;
    uint8 private constant PH_CLOSING = 4;        // commit window closed, awaiting the sealed promotion draw
    uint8 private constant PH_REVEAL = 5;
    uint8 private constant PH_FINAL = 6;          // aggregated, awaiting settlement
    uint8 private constant PH_SETTLED = 7;
    uint8 private constant PH_FAILED = 8;         // failed and settled
    /// @dev The arbiter pool (it replaces the treasury of earlier v2 drafts): the ledger entry
    ///      ethOwed[address(0)], which nobody can withdraw (msg.sender is never address(0), and withdrawEthFor
    ///      refuses it). Each draw pays an eighth of it to one registered arbiter (AggregatorLib.payPool).
    address private constant POOL = address(0);
    uint8 private constant PH_CANCELLED = 9;      // never drawable: prepay sent to the arbiter pool

    uint8 private constant S_DISPATCHED = 1;
    uint8 private constant S_COMMITTED = 2;
    uint8 private constant S_PROMOTED = 4;
    uint8 private constant S_REVEALED = 8;
    uint8 private constant S_COUNTED = 16;

    uint256 private constant MAX_CID_COUNT = 10;
    uint256 private constant MAX_CID_LENGTH = 100;
    uint256 private constant MAX_ADDENDUM_LENGTH = 1000;
    uint256 private constant MAX_REVEAL_CID_LENGTH = MAX_CID_LENGTH + 33;   // ":" + 32 hex salt (items 4, 5)
    uint256 private constant MAX_SCORE = 1e34;
    /// @dev EIP-2935 block-hash history (8,191 blocks); live on Base (checked 2026-11-17)
    address private constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 private constant HISTORY_WINDOW = 8191;
    uint256 private constant OWNER_GAS = 30_000;
    uint40 private constant PROMOTE_GRACE = 30;   // seconds left to promote after a late close

    // outcome codes for the keeper (ReputationKeeper constants)
    uint8 private constant T_DELIVERED = 1;
    uint8 private constant T_MISS_FINISHED = 2;
    uint8 private constant T_MISS_FAILED = 3;
    uint8 private constant T_NOCOMMIT_FAILED = 4;
    uint8 private constant C_COMMITTED = 0x80;

    // ------------------------------------------------------------------ types
    /// @dev two words written at the draw (the operator is in requestRef and the keeper's record of `key`)
    struct Slot {
        address payee;        // s0
        uint64 fee;           // the posted fee as of B; paid = max(fee, the round's floor)
        uint8 flags;
        uint8 qcode;
        bytes32 key;          // s1
        bytes32 commitHash;   // s2: keccak256(abi.encode(aggId, operator, response, salt)), all 32 bytes
    }

    /// @notice getSlot's view (the v2 layout): fee is the amount paid; committedAt is no longer recorded (0)
    struct SlotView {
        address oracle;
        uint96 fee;
        bytes32 key;
        address payee;
        uint40 committedAt;
        uint8 flags;
        uint8 qcode;
        bytes32 commitHash;
    }

    /// @notice The jury a request asks for (item 15's class presets): K drawn, M promoted, N counted, P
    ///         clustered, and the round timeout from the draw
    struct Jury {
        uint8 K;
        uint8 M;
        uint8 N;
        uint8 P;
        uint40 timeout;
    }

    struct Round {
        address requester;    // s0
        uint40 start;
        uint8 K;
        uint8 M;
        uint8 N;
        uint8 P;
        uint8 phase;
        uint8 commits;
        uint8 reveals;
        uint96 ethReceived;   // s1
        uint96 baseCredited;
        uint40 windowEnd;     // T+ of the request until the draw, then draw time + T+
        uint8 bonusMult;
        uint8 mPlus;
        uint8 drawFees;       // draw reward in fees, fixed at request (the escrow was sized on it)
        uint96 bonusCredited; // s2
        uint40 deadline;
        uint32 requestBlock;
        uint32 closeBlock;
        uint16 alpha;
        uint16 scaling;
        uint8 promoteFees;    // promote reward in fees, fixed at request
        uint8 beaconFees;     // beacon values paid (the quorum), fixed at request; 0 = no beacons
        uint128 spread;       // s3
        uint40 requestTime;
        uint88 rewardCredited; // draw and promote rewards, beacon payments
        uint96 effMaxFee;     // s4
        uint96 baseCost;
        uint64 cls;
        uint96 minFee;        // s5: fee floor (item 8): each juror is paid max(posted fee, minFee)
        uint40 timeout;       // the request's round timeout, from the draw
        bytes32 sealedHash;   // s6
        string payload;
        uint128[] aggregated; // scores are clamped to MAX_SCORE < 2^113: two per word, lossless
        uint128[] median;
        uint8[] order;        // counted slots, in reveal order
        string justifications;
        mapping(uint256 => Slot) slots;
        mapping(uint256 => uint128[]) likes;
        mapping(uint256 => string) cids;
    }

    // ------------------------------------------------------------------ errors
    error BadInput();
    error KeeperNotSet();
    error InsufficientPayment();
    error BadSelectionCount();
    error UnknownRequest();
    error NotDue();
    error WrongPhase();
    error NotAuthorized();
    error NothingOwed();
    error EthTransferFailed();
    error InvalidConfig();
    error TooEarly();
    error SeedExpired();
    error DrawExpired();
    error OutOfGas();

    // ------------------------------------------------------------------ events
    event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
    event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);
    event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash);
    event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted);
    event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock);
    event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash);
    event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward);
    event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons);
    event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    /// @notice A share of the arbiter pool, paid at a draw to a random registered arbiter's payee
    ///         (emitted by AggregatorLib.payPool, in this contract's context)
    event PoolPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    /// @notice A never-promoted round's unspent prepay, shared by the slots that committed (one per slot)
    event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    /// @notice An undrawable round cancelled: its whole prepay credits the arbiter pool
    event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool);
    event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode);
    event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
    event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase);
    event RoundSettled(bytes32 indexed aggRequestId, bool failed);
    event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
    event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
    /// @notice Unspent prepay credited: to the requester, or to the arbiter pool when `requester` is address(0)
    event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);
    event EthWithdrawn(address indexed payee, uint256 amount);
    /// @dev reason: 1 owner() reverted, 2 commit dispatch reverted, 3 reveal dispatch reverted, 4 keeper call reverted
    event SlotSkipped(bytes32 indexed aggRequestId, uint256 pollIndex, uint8 reason);

    // ------------------------------------------------------------------ config
    uint8 public maxJury = 50;                 // largest K a request may ask for (keeper shortlist, tx gas)
    uint40 public maxTimeout = 3600;           // longest round timeout a request may ask for
    uint8 public bonusMultiplier = 3;
    uint8 public settlePerRequest = 2;
    uint8 public drawRewardFees = 2;           // drawer reward, in per-arbiter fees
    uint8 public promoteRewardFees = 1;        // promote() caller's reward, so third parties call it
    uint40 public requesterDrawPriority = 30;  // seconds in which only the requester earns the reward
    uint40 public tPlus = 155;                 // mean + 2 SD of honest commit latency (item 14, Oct-Nov 2026)
    uint40 public revealWindow = 120;          // reveal time guaranteed after promotion (reveal p90 54 s)
    uint40 private constant DRAW_GRACE = 1 days; // no draw after this; the round can then only be cancelled
    /// @dev stipend per oracle request: the LINK transferAndCall and the operator's onTokenTransfer (the request
    ///      is built once per round, outside the stipend); a gas-burning operator costs at most this
    uint32 public dispatchGas = 250_000;
    uint256 public spreadFloor = 30_000;       // 3 points on the arbiters' 0..1,000,000 scale
    uint256 public maxOracleFee = 4e14;
    uint256 private constant MAX_LIKELIHOOD_LENGTH = 20;

    /// @dev LINK (ERC-677): requests go out as transferAndCall(operator, 0, operatorRequest(...))
    address private immutable link;
    ReputationKeeper public keeper;
    IJuryBeacons public beacons;

    // ------------------------------------------------------------------ state
    uint256 public roundCount;
    mapping(uint256 => Round) internal rounds;
    /// @notice chainlink request id => operator << 96 | roundId << 8 | slot, until the request is fulfilled
    ///         (one fulfilment per request, from its operator only); 0 after
    mapping(bytes32 => uint256) public requestRef;
    mapping(address => uint256) public ethOwed;
    uint256[] public settleQueue;
    uint256 public settleHead;

    constructor(address link_, address _keeper) Ownable(msg.sender) {
        link = link_;
        keeper = ReputationKeeper(_keeper);
    }

    // ================================================================== request
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 alpha,
        uint256 maxFee,
        uint256 minFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass,
        bool withBeacons,
        Jury calldata j
    ) external payable nonReentrant whenNotPaused returns (bytes32 aggId) {
        if (address(keeper) == address(0)) revert KeeperNotSet();
        string memory payload =
            AggregatorLib.buildCommitPayload(cids, addendumText, MAX_CID_COUNT, MAX_CID_LENGTH, MAX_ADDENDUM_LENGTH);

        // the jury (item 15): K/M/N/P and the timeout are the request's. K must fit the keeper's shortlist,
        // or the draw would fill the rest of the jury with repeats from a pool that has more arbiters
        AggregatorLib.checkJury(j.K, j.M, j.N, j.P, j.timeout, tPlus, maxJury, maxTimeout, keeper.shortlistSize());

        // settle due rounds first: bounded work. Rounds are settled until settlePerRequest x this request's K
        // slots are spent; the last may overshoot, so the first due round is settled whatever its size
        _settleDue(uint256(settlePerRequest) * j.K);

        uint256 effMaxFee = maxFee < maxOracleFee ? maxFee : maxOracleFee;
        if (estimatedBaseCost >= effMaxFee || alpha > 1000 || maxFeeBasedScalingFactor < 1 || maxFeeBasedScalingFactor > type(uint16).max)
            revert BadInput();
        uint256 required = maxTotalFee(maxFee, minFee, withBeacons, j.K, j.P);
        if (required > type(uint88).max) revert BadInput();   // so every credited total fits its field
        // credit covers only what msg.value does not; any excess value goes back to credit, so the
        // escrow is exactly `required` (a forfeit to the pool never takes more than the round's prepay)
        uint256 fromCredit = msg.value < required ? required - msg.value : 0;
        uint256 credit = ethOwed[msg.sender];
        if (credit < fromCredit) revert InsufficientPayment();
        ethOwed[msg.sender] = credit - fromCredit + (msg.value + fromCredit - required);

        uint256 id = ++roundCount;
        aggId = bytes32(id);
        Round storage r = rounds[id];
        r.requester = msg.sender;
        (r.K, r.M, r.N, r.P) = (j.K, j.M, j.N, j.P);
        r.phase = PH_DRAW;
        r.ethReceived = uint96(required);
        r.bonusMult = bonusMultiplier;
        r.drawFees = drawRewardFees;
        r.promoteFees = promoteRewardFees;
        if (withBeacons) r.beaconFees = beacons.quorum();
        r.requestBlock = uint32(block.number);
        r.requestTime = uint40(block.timestamp);
        r.alpha = uint16(alpha);
        r.scaling = uint16(maxFeeBasedScalingFactor);
        r.effMaxFee = uint96(effMaxFee);
        r.baseCost = uint96(estimatedBaseCost);
        r.cls = requestedClass;
        r.minFee = uint96(minFee);
        r.timeout = j.timeout;
        r.windowEnd = tPlus;  // the T+ this timeout was checked against; the draw adds its time
        r.payload = payload;
        emit RequestFunded(aggId, msg.sender, fromCredit, msg.value);
        emit RequestAIEvaluation(aggId, cids);
    }

    /// @notice Escrow for one request: juror x (K + B x P [+ beacon quorum if `withBeacons`]) +
    ///         eff x (drawRewardFees + promoteRewardFees); reverts if `withBeacons` and no beacon contract
    ///         is set. eff = min(maxFee, maxOracleFee) is the fee ceiling; juror = max(eff, minFee) bounds
    ///         what a juror or a beacon is paid (item 8). The floor may exceed the ceiling: the ceiling
    ///         limits which arbiters are eligible, not what a requester chooses to pay. The draw and promote
    ///         rewards are paid on eff, so a requester that draws or promotes its own round gets none of
    ///         the floor back. K and P are the jury the request will ask for.
    function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) public view returns (uint256) {
        uint256 eff = maxFee < maxOracleFee ? maxFee : maxOracleFee;
        uint256 juror = minFee > eff ? minFee : eff;
        uint256 n = uint256(K) + uint256(bonusMultiplier) * P;
        if (withBeacons) n += beacons.quorum();
        return juror * n + eff * (uint256(drawRewardFees) + promoteRewardFees);
    }

    // ================================================================== two-phase draw (item 9)
    /// @notice Store blockhash(B+1) while it is still readable (permissionless, ~30k gas).
    function sealSeed(bytes32 aggId) external {
        Round storage r = rounds[uint256(aggId)];
        if (r.phase != PH_DRAW || r.sealedHash != bytes32(0)) revert WrongPhase();
        _seal(r, aggId);
    }

    function _seal(Round storage r, bytes32 aggId) internal {
        if (block.number < uint256(r.requestBlock) + 2) revert TooEarly();
        bytes32 h = _blockHash(uint256(r.requestBlock) + 1);
        if (h == bytes32(0)) revert SeedExpired();
        r.sealedHash = h;
        emit SeedSealed(aggId, h);
    }

    /// @dev blockhash(n) for the last 256 blocks, else EIP-2935 history up to 8,191 blocks, else 0
    function _blockHash(uint256 n) internal view returns (bytes32 h) {
        if (n >= block.number) return 0;
        uint256 age = block.number - n;
        if (age <= 256) return blockhash(n);
        if (age > HISTORY_WINDOW) return 0;
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    /// @dev revert unless a call given `g` gas can actually receive it (EIP-150 forwards 63/64), so a
    ///      caller cannot pick a gas limit that makes a tolerated call fail
    function _needGas(uint256 g) internal view {
        if (gasleft() < g * 64 / 63 + 20_000) revert OutOfGas();
    }

    /**
     * @notice Draw the jury and send the commit requests (permissionless, from block B+2). The result
     *         depends only on the sealed seed and the keeper's state as of B, so who draws and when
     *         does not matter. Reward: 2 x eff, to the requester if it draws within 30 s, otherwise to
     *         whoever draws after 30 s (a third party drawing earlier earns nothing). If no arbiter was
     *         eligible at B the round fails and the requester is refunded: no jury could be drawn, so
     *         the refund is no re-roll. After a beacon stage that holds only if the selection walk
     *         covers the whole class list; otherwise the prepay goes to the arbiter pool.
     *
     *         With beacons, the first call only starts the beacon stage (no reward) and the draw needs
     *         a second call once the quorum is in; the 30 s priority then runs from the quorum-th value.
     *         A second call after the beacon deadline without the quorum ends the round: the beacons
     *         that answered are paid and the rest of the prepay goes to the arbiter pool.
     *
     *         A draw that draws a jury also pays an eighth of the arbiter pool to one registered arbiter's
     *         payee, picked by the keeper from this draw's seed (PoolPayment); if the keeper finds none
     *         available in two tries, the pool waits for the next draw.
     *
     *         No draw more than DRAW_GRACE (1 day) after the request: such a round can only be cancelled
     *         to the arbiter pool (cancelUnsealed). That bounds how old a block a draw reads, which the
     *         keeper's unbonding (at least 2 days) and slot reuse rely on.
     */
    function drawJury(bytes32 aggId) external nonReentrant {
        uint256 id = uint256(aggId);
        Round storage r = rounds[id];
        uint256 eff = r.effMaxFee;
        uint256 anchor = r.requestTime;
        bytes32 seed;
        if (r.phase != PH_DRAW && r.phase != PH_BEACON) revert WrongPhase();
        if (block.timestamp > anchor + DRAW_GRACE) revert DrawExpired();
        if (r.phase == PH_DRAW) {
            if (r.sealedHash == bytes32(0)) _seal(r, aggId);
            if (r.beaconFees != 0) {
                uint256 picked = beacons.start(aggId, keccak256(abi.encodePacked(aggId, "beacons", r.sealedHash)),
                    r.cls, r.requestBlock, r.requestTime, r.beaconFees, eff);
                if (picked < r.beaconFees) {
                    r.phase = PH_FAILED;          // pool shortage, as for an empty jury pool: refund
                    _refund(r, aggId, r.requester);
                    emit EvaluationFailed(aggId, PH_DRAW);
                } else {
                    r.phase = PH_BEACON;
                    emit BeaconStageStarted(aggId, picked);
                }
                return;
            }
            seed = keccak256(abi.encodePacked(aggId, r.sealedHash));
        } else {
            (uint8 st, bytes32 mix, uint256 readyAt, address[] memory payees) = beacons.result(address(this), aggId);
            if (st != 2 && st != 3) revert TooEarly();
            uint256 pay = r.minFee > eff ? r.minFee : eff;    // a beacon is paid as a juror: the floor (item 8)
            // at most the quorum escrowed: a beacon contract reporting more would be paid from others' funds
            if (payees.length > r.beaconFees) revert BadSelectionCount();
            for (uint256 i = 0; i < payees.length; i++) {
                ethOwed[payees[i]] += pay;
                emit BeaconPayment(aggId, payees[i], pay);
            }
            r.rewardCredited += uint88(pay * payees.length);
            if (st == 3) {
                r.phase = PH_FAILED;              // quorum missed: no result, and no refund (a free re-roll)
                _refund(r, aggId, POOL);
                emit EvaluationFailed(aggId, PH_BEACON);
                return;
            }
            seed = keccak256(abi.encodePacked(aggId, r.sealedHash, mix));
            anchor = readyAt;
        }
        ReputationKeeper.Selected[] memory sel;
        (uint256 atB, uint256 atT) = (r.requestBlock, r.requestTime);
        uint256 g = gasleft();
        try keeper.selectArbiters(
            ReputationKeeper.SelectParams(r.K, r.alpha, eff, r.minFee, r.baseCost, r.scaling, r.cls), seed, atB, atT
        ) returns (ReputationKeeper.Selected[] memory s_) {
            sel = s_;
        } catch {
            if (gasleft() < g / 63) revert OutOfGas();
            r.phase = PH_FAILED;
            // After a beacon stage, a failure that could depend on the seed (the walk covers only part
            // of the class list) is a re-roll the beacons' timing could choose, so no refund then
            _refund(r, aggId, r.beaconFees != 0 && !keeper.scansAll(r.cls) ? POOL : r.requester);
            emit EvaluationFailed(aggId, PH_DRAW);
            return;
        }
        if (sel.length != r.K) revert BadSelectionCount();

        r.phase = PH_COMMIT;
        r.start = uint40(block.timestamp);
        r.windowEnd += uint40(block.timestamp);
        r.mPlus = uint8(uint256(r.M) + (uint256(r.K) - r.M + 1) / 2);
        r.deadline = uint40(block.timestamp) + r.timeout;
        // one request template for all K slots: the CBOR parameters are the same, only the operator, the
        // job id and the nonce are patched per slot
        bytes memory tpl = AggregatorLib.requestTemplate(bytes(r.payload), aggId, this.fulfill.selector);
        uint96 base;
        uint256 floor_ = r.minFee;
        for (uint256 i = 0; i < sel.length; i++) base += _pollSlot(r, aggId, id, i, sel[i], tpl, eff, floor_);
        r.baseCredited = base;

        uint256 reward;
        bool early = block.timestamp <= anchor + requesterDrawPriority;
        if (!early || msg.sender == r.requester) {
            reward = eff * r.drawFees;
            ethOwed[msg.sender] += reward;
            r.rewardCredited += uint88(reward);
        }
        // the arbiter pool: 1/POOL_SHARE of it to a random registered arbiter, from this draw's seed (fixed by
        // a block hash after the request, the same whoever draws). A forfeiting round never picks its own
        // winner, so a forfeit cannot be steered back to its requester. Capped gas: an operator's owner()
        // cannot make the draw fail; no winner, and the pool waits for the next draw
        AggregatorLib.payPool(ethOwed, address(keeper), seed, aggId, base, atB, atT);
        settleQueue.push(id);
        emit JuryDrawn(aggId, msg.sender, reward);
    }

    /// @notice A round that can never be drawn goes to the arbiter pool, never back to the requester (a
    ///         refund would be a free re-roll): unsealed once blockhash(B+1) left the 8,191-block
    ///         history, or sealed but undrawn for DRAW_GRACE, after which drawJury refuses (a draw that
    ///         cannot fit in a transaction, or a beacon stage nobody concluded; its beacons are then not
    ///         paid).
    function cancelUnsealed(bytes32 aggId) external nonReentrant {
        Round storage r = rounds[uint256(aggId)];
        if (r.phase != PH_DRAW && r.phase != PH_BEACON) revert WrongPhase();
        if (r.sealedHash == bytes32(0) ? block.number <= uint256(r.requestBlock) + 1 + HISTORY_WINDOW
                                       : block.timestamp <= uint256(r.requestTime) + DRAW_GRACE) revert TooEarly();
        r.phase = PH_CANCELLED;
        ethOwed[POOL] += r.ethReceived;
        emit RoundCancelled(aggId, r.ethReceived);
    }

    function _pollSlot(
        Round storage r,
        bytes32 aggId,
        uint256 id,
        uint256 i,
        ReputationKeeper.Selected memory s,
        bytes memory tpl,
        uint256 effMaxFee,
        uint256 minFee
    ) internal returns (uint96 credited) {
        if (s.fee > effMaxFee) revert InsufficientPayment();
        uint256 paid = s.fee < minFee ? minFee : s.fee;    // the floor (item 8); the bonus scales off it
        Slot storage sl = r.slots[i];
        sl.key = s.key;
        // low-level, so a malformed return (short, or dirty high bits) skips the slot instead of
        // reverting the draw, which would leave the round undrawable
        _needGas(OWNER_GAS);
        // copy only the first word: a callee returning a huge buffer would otherwise make every later
        // slot pay to expand memory (a return-data bomb)
        address o = s.oracle;
        uint256 w;
        assembly ("memory-safe") {
            mstore(0, 0x8da5cb5b00000000000000000000000000000000000000000000000000000000)   // owner()
            let ok := staticcall(OWNER_GAS, o, 0, 4, 0, 32)   // a separate statement: Yul evaluates
            if and(ok, gt(returndatasize(), 31)) { w := mload(0) }   // arguments right to left
        }
        if (w == 0 || w >> 160 != 0) {
            sl.fee = uint64(s.fee);
            emit SlotSkipped(aggId, i, 1);
            return 0;
        }
        address payee = address(uint160(w));
        if (_dispatch(tpl, s.oracle, s.jobId, (id << 8) | i, 0)) {
            (sl.payee, sl.fee, sl.flags) = (payee, uint64(s.fee), S_DISPATCHED);
            ethOwed[payee] += paid;
            credited = uint96(paid);
            emit BasePayment(aggId, i, payee, paid);
        } else {
            sl.fee = uint64(s.fee);
            emit SlotSkipped(aggId, i, 2);
        }
    }

    /// @dev One oracle request with the fixed stipend: LINK transferAndCall(oracle, 0, operatorRequest) from the
    ///      round's template, with this slot's operator, job id and nonce patched in. False if the operator
    ///      reverted, burned the stipend or LINK returned false. The nonce is (ref << 1 | reveal), unique per
    ///      request, so the request id keccak256(this, nonce) needs no counter. Only the first word of the
    ///      return data is copied (no return-data bomb).
    function _dispatch(bytes memory tpl, address oracle, bytes32 jobId, uint256 ref, uint256 reveal) internal returns (bool ok) {
        uint256 nonce = (ref << 1) | reveal;
        uint256 dg = dispatchGas;
        address l = link;
        _needGas(dg);
        assembly ("memory-safe") {
            let p := add(tpl, 32)
            mstore(add(p, 4), oracle)
            mstore(add(p, 200), jobId)
            mstore(add(p, 264), nonce)
            mstore(0, 0)
            ok := call(dg, l, 0, p, mload(tpl), 0, 32)
            ok := and(ok, and(gt(returndatasize(), 31), eq(mload(0), 1)))
        }
        if (ok) requestRef[keccak256(abi.encodePacked(address(this), nonce))] = (uint256(uint160(oracle)) << 96) | ref;
    }

    // ================================================================== commit / reveal
    function fulfill(bytes32 requestId, uint256[] memory response, string memory cid) public nonReentrant {
        uint256 ref = requestRef[requestId];
        if (ref >> 96 != uint160(msg.sender)) revert UnknownRequest();   // unknown, fulfilled, or not its operator
        delete requestRef[requestId];                                    // one fulfilment per request
        ref &= type(uint96).max;
        uint256 id = ref >> 8;
        uint256 s = ref & 0xff;
        Round storage r = rounds[id];
        Slot storage sl = r.slots[s];
        if (block.timestamp > r.deadline) return;               // too late: settlement decides

        if (response.length == 1 && bytes(cid).length == 0) {
            // ---------------- commit
            bytes32 h = bytes32(response[0]);
            if (r.phase != PH_COMMIT || h == bytes32(0) || sl.flags & S_COMMITTED != 0) return;
            sl.commitHash = h;
            sl.flags |= S_COMMITTED;
            uint256 c = ++r.commits;
            emit CommitReceived(bytes32(id), s, h);
            if (c >= r.mPlus || (block.timestamp > r.windowEnd && c >= r.M)) _closeWindow(r, id);  // M+ / T+
            return;
        }

        // ---------------- reveal (accepted until the deadline, also after finalization)
        if (r.phase != PH_REVEAL && r.phase != PH_FINAL) return;   // incl. CLOSING: no reveal requests yet
        if (sl.flags & (S_PROMOTED | S_REVEALED) != S_PROMOTED) return;
        // one value (a one-number answer: exact 1-D cluster) up to MAX_LIKELIHOOD_LENGTH; a reveal
        // always has a CID, so a one-value reveal is never taken for a commit
        if (response.length == 0 || response.length > MAX_LIKELIHOOD_LENGTH) return;
        if (bytes(cid).length > MAX_REVEAL_CID_LENGTH) return;
        (bool ok, string memory cleanCid, uint256 salt) = AggregatorLib.parseCidSalt(cid);
        if (!ok) return;
        // items 4 and 5: Keccak, all 32 bytes, bound to the round. An arbiter chooses its own salt, so only
        // the hash keeps it from opening one commit two ways: a 128-bit commit without the round would
        // let a collision found once offline (~2^64 work) be reused in every round
        if (keccak256(abi.encode(bytes32(id), msg.sender, response, salt)) != sl.commitHash) return;
        for (uint256 i = 0; i < response.length; i++) if (response[i] > MAX_SCORE) response[i] = MAX_SCORE;
        sl.flags |= S_REVEALED;

        if (r.phase == PH_REVEAL) {
            sl.flags |= S_COUNTED;
            _store(r.likes[s], response);
            r.cids[s] = cleanCid;
            r.order.push(uint8(s));
            emit RevealReceived(bytes32(id), s, false, 0);
            if (++r.reveals == r.N) _finalize(r, id);
        } else {
            uint8 q = ScoringLib.classifyOne(response, _load(r.median), r.spread);
            sl.qcode = q;
            emit RevealReceived(bytes32(id), s, true, q);
        }
    }

    /// @notice Close the commit phase once T+ has passed and at least M commits are in (anyone: the
    ///         requester, a committed arbiter's node, a keeper). Needed when no commit arrives after T+.
    function closeCommits(bytes32 aggId) external nonReentrant {
        uint256 id = uint256(aggId);
        Round storage r = rounds[id];
        if (r.phase != PH_COMMIT || block.timestamp <= r.windowEnd || r.commits < r.M || block.timestamp > r.deadline)
            revert WrongPhase();
        _closeWindow(r, id);
    }

    function _closeWindow(Round storage r, uint256 id) internal {
        r.phase = PH_CLOSING;
        r.closeBlock = uint32(block.number);
        // a close in the deadline's last second must still leave time to promote from C+2
        uint40 pd = uint40(block.timestamp) + PROMOTE_GRACE;
        if (pd > r.deadline) r.deadline = pd;
        emit CommitWindowClosed(bytes32(id), block.number);
    }

    /// @notice Draw the promoted commits from block C+2 (permissionless; same result whoever calls).
    function promote(bytes32 aggId) external nonReentrant {
        uint256 id = uint256(aggId);
        Round storage r = rounds[id];
        if (r.phase != PH_CLOSING || block.timestamp > r.deadline) revert WrongPhase();
        if (block.number < uint256(r.closeBlock) + 2) revert TooEarly();
        bytes32 h = _blockHash(uint256(r.closeBlock) + 1);
        if (h == bytes32(0)) revert SeedExpired();
        _promote(r, id, keccak256(abi.encodePacked(aggId, "promote", h)));
        // promoted arbiters always get revealWindow to answer, however late promote() was called
        uint40 rd = uint40(block.timestamp) + revealWindow;
        if (rd > r.deadline) r.deadline = rd;
        uint256 reward = uint256(r.effMaxFee) * r.promoteFees;   // anyone may call: nobody can withhold it
        ethOwed[msg.sender] += reward;
        r.rewardCredited += uint88(reward);
    }

    function _promote(Round storage r, uint256 id, bytes32 seedIn) internal {
        uint256 k = r.K;
        uint256 m = r.M;
        bool[] memory committed = new bool[](k);
        for (uint256 i = 0; i < k; i++) committed[i] = r.slots[i].flags & S_COMMITTED != 0;
        uint256[] memory chosen = ScoringLib.pickPromoted(committed, m, seedIn);
        r.phase = PH_REVEAL;
        bytes32 aggId = bytes32(id);
        bytes memory tpl = AggregatorLib.requestTemplate("", aggId, this.fulfill.selector);
        for (uint256 j = 0; j < m; j++) {
            uint256 s = chosen[j];
            Slot storage sl = r.slots[s];
            sl.flags |= S_PROMOTED;
            string memory hx = AggregatorLib.bytes32ToHexLower(sl.commitHash);   // the payload "2:<commit hash>"
            assembly ("memory-safe") {
                mstore(add(tpl, 432), mload(add(hx, 32)))
                mstore(add(tpl, 464), mload(add(hx, 64)))
            }
            (address oracle, bytes32 jobId) = keeper.oracleJob(sl.key);
            if (!_dispatch(tpl, oracle, jobId, (id << 8) | s, 1)) emit SlotSkipped(aggId, s, 3);
        }
        emit CommitPhaseComplete(aggId, m);
    }

    // ================================================================== finalize
    function _finalize(Round storage r, uint256 id) internal {
        uint256 n = r.order.length;
        uint256[][] memory ll = new uint256[][](n);
        uint256[] memory ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) (ll[i], ids[i]) = (_load(r.likes[r.order[i]]), r.order[i]);
        // aggregate resizes the vectors to their most common length first, and breaks cluster ties
        // by a seeded order of the slots, not by who revealed first
        (bool[] memory inCl, uint256[] memory agg, uint8[] memory codes, uint256[] memory med, uint256 spread) =
            ScoringLib.aggregate(ll, r.P, spreadFloor, r.sealedHash, ids);
        uint96 bonus;
        bytes memory just;
        uint256 floor_ = r.minFee;
        for (uint256 i = 0; i < n; i++) {
            if (!inCl[i]) continue;
            uint256 s = r.order[i];
            Slot storage sl = r.slots[s];
            uint256 b = (sl.fee < floor_ ? floor_ : sl.fee) * r.bonusMult;   // the paid fee (item 8)
            if (b > 0) {
                ethOwed[sl.payee] += b;
                bonus += uint96(b);
                emit BonusPayment(bytes32(id), s, sl.payee, b);
            }
            just = just.length == 0 ? bytes(r.cids[s]) : abi.encodePacked(just, ",", r.cids[s]);
        }
        _store(r.aggregated, agg);
        r.justifications = string(just);
        r.bonusCredited = bonus;
        for (uint256 i = 0; i < n; i++) r.slots[r.order[i]].qcode = codes[i];
        _store(r.median, med);
        r.spread = uint128(spread);
        r.phase = PH_FINAL;
        _refund(r, bytes32(id), r.requester);
        emit FulfillAIEvaluation(bytes32(id), agg, string(just));
    }

    /// @dev a vector into packed storage (every value is at most MAX_SCORE < 2^128)
    function _store(uint128[] storage a, uint256[] memory v) internal {
        for (uint256 i = 0; i < v.length; i++) a.push(uint128(v[i]));
    }

    function _load(uint128[] storage a) internal view returns (uint256[] memory v) {
        v = new uint256[](a.length);
        for (uint256 i = 0; i < v.length; i++) v[i] = a[i];
    }

    function _refund(Round storage r, bytes32 aggId, address to) internal {
        uint256 refund = uint256(r.ethReceived) - r.baseCredited - r.bonusCredited - r.rewardCredited;
        if (refund > 0) {
            ethOwed[to] += refund;
            emit RequesterRefunded(aggId, to, refund);
        }
    }

    // ================================================================== settlement
    /// @notice Settle a round after its deadline: fail it if it never finished, then report every
    ///         slot's outcome to the keeper in one call. Anyone may call; requests also settle due rounds.
    function settle(bytes32 aggId) external nonReentrant {
        Round storage r = rounds[uint256(aggId)];
        if (r.phase < PH_COMMIT || r.phase >= PH_SETTLED) revert WrongPhase();
        if (block.timestamp <= r.deadline) revert NotDue();
        _settle(r, uint256(aggId));
    }

    /// @dev Settles due rounds in queue order until `budget` slots are spent. The last round settled may
    ///      overshoot the budget (by at most its own K), so the first due round is always settled, whatever
    ///      its size, and a big round at the head cannot stall the queue behind it. A round not yet past its
    ///      deadline stops the walk (it is not skipped): rounds behind a long-timeout round wait for it, or
    ///      for anyone's settle(). Until a round settles, its scores (and penalties) and a failed round's
    ///      refund wait; a result is readable from finalization.
    function _settleDue(uint256 budget) internal {
        uint256 h = settleHead;
        uint256 len = settleQueue.length;
        // already-settled entries (settle() called directly) count as steps too, so holes in the queue
        // cannot make a request's walk unbounded
        uint256 limit = uint256(settlePerRequest) * 8;
        for (uint256 steps = 0; steps < limit && h < len; steps++) {
            Round storage r = rounds[settleQueue[h]];
            if (r.phase < PH_SETTLED) {
                if (budget == 0 || block.timestamp <= r.deadline) break;
                budget = r.K < budget ? budget - r.K : 0;
                _settle(r, settleQueue[h]);
            }
            h++;
        }
        settleHead = h;
    }

    function _settle(Round storage r, uint256 id) internal {
        uint8 ph = r.phase;
        bool failed = ph != PH_FINAL;
        bytes32 aggId = bytes32(id);
        uint256 share;
        if (failed) {
            // M commits were in but the round was never promoted (closed and not promoted, or not
            // closed after T+). No refund, so a requester that dislikes the jury or the promotion draw
            // cannot abort for one: the unspent prepay is shared equally by the slots that committed
            // (they did the work; anyone could have promoted), and the indivisible rest goes to the arbiter pool
            if (ph == PH_CLOSING || (ph == PH_COMMIT && r.commits >= r.M)) {
                share = (uint256(r.ethReceived) - r.baseCredited - r.bonusCredited - r.rewardCredited) / r.commits;
                r.rewardCredited += uint88(share * r.commits);
                _refund(r, aggId, POOL);
            } else {
                _refund(r, aggId, r.requester);
            }
            emit EvaluationFailed(aggId, ph);   // phase it failed in: 3 commit, 4 promotion, 5 reveal
        }
        uint256 k = r.K;
        bytes32[] memory keys = new bytes32[](k);
        uint8[] memory codes = new uint8[](k);
        for (uint256 i = 0; i < k; i++) {
            Slot storage sl = r.slots[i];
            uint8 f = sl.flags;
            uint8 code;
            if (ph == PH_COMMIT) {
                // -400 only to a slot that was DISPATCHED and did not commit, only if the round failed for
                // lack of commits (not for want of a closeCommits call), and only if at least half of M
                // committed. Fewer commits do not show the job could be done: with none, or a handful,
                // the failure is the request's (evidence honest arbiters refuse or cannot fetch, maybe
                // with a lone colluding commit, whose hash is never opened) or the network's (a shared
                // outage), not the jurors'. Review 2026-11-26 #7. Downtime is the health calls' to catch.
                // 2 * commits >= M implies commits >= 1 (M >= 1).
                uint256 commits = r.commits;
                if (f & (S_DISPATCHED | S_COMMITTED) == S_DISPATCHED && commits < r.M && 2 * commits >= r.M) {
                    code = T_NOCOMMIT_FAILED;
                }
            } else if (ph == PH_CLOSING) {
                code = 0;   // enough commits arrived; nobody promoted, so nobody failed to deliver
            } else if (f & S_PROMOTED != 0) {
                if (f & S_REVEALED != 0) code = failed ? T_DELIVERED : uint8(T_DELIVERED | (sl.qcode << 4));
                else code = failed ? T_MISS_FAILED : T_MISS_FINISHED;
            }
            if (code != 0 && f & S_COMMITTED != 0) code |= C_COMMITTED;   // proved up: scored even if frozen
            if (share != 0 && f & S_COMMITTED != 0) {
                ethOwed[sl.payee] += share;
                emit CommitPayment(aggId, sl.payee, share);
            }
            keys[i] = sl.key;
            codes[i] = code;
        }
        r.phase = failed ? PH_FAILED : PH_SETTLED;
        uint256 g = gasleft();
        try keeper.applyOutcomes(keys, codes, r.deadline) {} catch {
            if (gasleft() < g / 63) revert OutOfGas();   // starved by the caller: never skip the scores
            emit SlotSkipped(aggId, type(uint256).max, 4);
        }
        emit RoundSettled(aggId, failed);
    }

    // ================================================================== views
    function getEvaluation(bytes32 aggId) external view returns (uint256[] memory, string memory, bool) {
        Round storage r = rounds[uint256(aggId)];
        bool valid = r.phase == PH_FINAL || r.phase == PH_SETTLED;
        return (_load(r.aggregated), r.justifications, valid);
    }

    /// @notice Item 11: every counted reveal's raw score for `outcome`, in reveal order (a short reveal
    ///         gives 0). `valid` is false until the round is finalized, and for a failed round.
    function getOutcomeScores(bytes32 aggId, uint256 outcome) external view returns (uint256[] memory scores, bool valid) {
        Round storage r = rounds[uint256(aggId)];
        if ((r.phase != PH_FINAL && r.phase != PH_SETTLED) || outcome >= r.aggregated.length) return (scores, false);
        uint256 n = r.order.length;
        scores = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint128[] storage v = r.likes[r.order[i]];
            if (outcome < v.length) scores[i] = v[outcome];
        }
        valid = true;
    }

    function getSlot(bytes32 aggId, uint256 i) external view returns (SlotView memory v) {
        Round storage r = rounds[uint256(aggId)];
        Slot storage sl = r.slots[i];
        if (sl.key != bytes32(0)) (v.oracle, ) = keeper.oracleJob(sl.key);
        uint256 fee = sl.fee < r.minFee ? r.minFee : sl.fee;
        if (sl.key == bytes32(0)) fee = 0;
        (v.fee, v.key, v.payee, v.flags, v.qcode, v.commitHash) = (uint96(fee), sl.key, sl.payee, sl.flags, sl.qcode, sl.commitHash);
    }

    /// @notice phase (1 draw, 2 beacons, 3 commit, 4 closing, 5 reveal, 6 final, 7 settled, 8 failed,
    ///         9 cancelled), draw blocks, and the escrow: received, base fees, bonuses, rewards (draw,
    ///         promote, beacons). Received minus the three credited amounts is refunded at the end.
    ///         Then the timing a consumer's view needs: the round deadline (0 until the draw; settle
    ///         is due after it), the commit window's end (0 until the draw, then the draw time plus the T+ of the
    ///         request), the commits received,
    ///         and the request time (drawJury's 1-day limit and cancelUnsealed run from it).
    function getRoundInfo(bytes32 aggId)
        external
        view
        returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock,
                 uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards,
                 uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)
    {
        Round storage r = rounds[uint256(aggId)];
        return (r.phase, r.requestBlock, r.sealedHash, r.closeBlock, r.ethReceived, r.baseCredited, r.bonusCredited,
                r.rewardCredited, r.deadline, r.deadline == 0 ? 0 : r.windowEnd, r.commits, r.requestTime);
    }

    /// @notice The jury a round was requested with (zero for an unknown round)
    function getJury(bytes32 aggId) external view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) {
        Round storage r = rounds[uint256(aggId)];
        return (r.K, r.M, r.N, r.P, r.timeout);
    }

    function isFailed(bytes32 aggId) external view returns (bool) {
        return rounds[uint256(aggId)].phase == PH_FAILED;
    }

    // ================================================================== ETH withdrawals
    function _withdrawTo(address payee) internal {
        uint256 amount = ethOwed[payee];
        if (amount == 0) revert NothingOwed();
        ethOwed[payee] = 0;
        (bool ok, ) = payable(payee).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit EthWithdrawn(payee, amount);
    }

    function withdrawEth() external nonReentrant {
        _withdrawTo(msg.sender);
    }

    function withdrawEthFor(address payee) external nonReentrant {
        if ((msg.sender != payee && msg.sender != owner()) || payee == POOL) revert NotAuthorized();
        _withdrawTo(payee);
    }

    // ================================================================== owner configuration
    /// @notice Bounds on the jury a request may ask for: the largest K, the longest timeout, and T+ (seconds,
    ///         from measured honest commit latency: mean + 2 SD), which every timeout must exceed. Each request
    ///         also checks K against the keeper's shortlist (a shortlist lowered after a request makes that
    ///         round's draw repeat arbiters). Every request's timeout is also capped at one day
    ///         (AggregatorLib.MAX_TIMEOUT, whatever maxTimeout says): the keeper's unbonding period (at least
    ///         2 days) assumes a round settles within a day of its draw. A round keeps the T+ of its
    ///         request, so changing T+ never strands a round in flight.
    function setLimits(uint8 maxJury_, uint40 maxTimeout_, uint40 tPlus_) external onlyOwner {
        if (maxJury_ == 0 || tPlus_ == 0 || maxTimeout_ <= tPlus_) revert InvalidConfig();
        (maxJury, maxTimeout, tPlus) = (maxJury_, maxTimeout_, tPlus_);
    }

    /// @notice Bonus multiplier (at most 20), rounds settled per request, the per-call dispatch stipend
    ///         (100k..2M), the quality spread floor and the fee ceiling.
    function setParams(uint8 bonusMult, uint8 settlePerReq, uint32 dispatchGas_, uint256 spreadFloor_, uint256 maxOracleFee_)
        external
        onlyOwner
    {
        if (bonusMult > 20 || dispatchGas_ < 100_000 || dispatchGas_ > 2_000_000 || spreadFloor_ > MAX_SCORE)
            revert InvalidConfig();
        (bonusMultiplier, settlePerRequest, dispatchGas, spreadFloor, maxOracleFee) =
            (bonusMult, settlePerReq, dispatchGas_, spreadFloor_, maxOracleFee_);
    }

    /// @dev applies to new requests only: each round keeps the fees its escrow was sized on
    function setRewards(uint8 drawFees_, uint40 priority, uint8 promoteFees_, uint40 revealWindow_) external onlyOwner {
        if (revealWindow_ == 0) revert InvalidConfig();
        (drawRewardFees, requesterDrawPriority, promoteRewardFees, revealWindow) = (drawFees_, priority, promoteFees_, revealWindow_);
    }

    /// @notice Keeper and beacon contract (0 = beacons off). Rounds in flight keep calling the new ones:
    ///         change the keeper only when no round awaits settlement, and the beacon contract only when no
    ///         round is in its beacon stage.
    function setContracts(address keeper_, address beacons_) external onlyOwner {
        if (keeper_ == address(0)) revert InvalidConfig();
        (keeper, beacons) = (ReputationKeeper(keeper_), IJuryBeacons(beacons_));
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
