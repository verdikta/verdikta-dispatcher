// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@chainlink/contracts/src/v0.8/operatorforwarder/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ReputationKeeper.sol";
import "./AggregatorLib.sol";
import "./ScoringLib.sol";

interface IOracleOwnerAgg { function owner() external view returns (address); }

interface IJuryBeacons {
    function quorum() external view returns (uint8);
    function start(bytes32 aggId, bytes32 seed, uint64 cls, uint256 atBlock, uint256 atTime, uint8 quorum_)
        external
        returns (uint256 picked);
    function result(address aggregator, bytes32 aggId)
        external
        view
        returns (uint8 state, bytes32 mix, uint256 readyAt, address[] memory payees);
}

/**
 * @title ReputationAggregator (example implementation of TODO items 14, 9 and 11)
 * @notice Commit-reveal aggregation with ETH escrow (as today), plus:
 *   - two-phase request (item 9): the request only escrows and records the query in block B; the jury
 *     is drawn by drawJury() from block B+2 with seed keccak256(aggId, blockhash(B+1)) and the
 *     keeper's state as of B, so nobody can predict or re-roll it when the request is signed. The
 *     drawer earns 2 x the per-arbiter fee (the requester only, for the first 30 s). Block hashes are
 *     read with BLOCKHASH within 256 blocks (51 s at Base's 0.2 s blocks) and from the EIP-2935
 *     history contract up to 8,191 blocks (~27 min). Rounds never expire before the draw; a round
 *     whose seed was never sealed within that window is cancelled to the treasury, never refunded (a
 *     refund would be a free re-roll). A draw that finds no eligible arbiter fails and refunds;
 *   - optional beacons (item 9's per-request flag, for Jumbo): the first drawJury() starts the beacon
 *     stage in JuryBeacons, a second one draws with keccak256(aggId, blockhash(B+1), mix of the first
 *     `quorum` beacon values) once they are in. Each used beacon is paid one fee. If the quorum is
 *     missed by the beacon deadline the round ends with no result and the unspent prepay goes to the
 *     treasury (a refund would be a free re-roll);
 *   - M+ / T+ promotion (item 14): the commit phase closes at the M+-th commit (M+ = M + ceil((K-M)/2)),
 *     or once T+ has passed since the draw with at least M commits. Closing records block C, and
 *     promote() draws M of all commits received from block C+2 with
 *     keccak256(aggId, "promote", blockhash(C+1)), so the arbiter that closes the phase cannot
 *     predict the draw and answering early earns nothing;
 *   - late reveals: promoted arbiters may reveal until the round deadline, after finalization; late
 *     reveals are classified on arrival against the stored median and spread;
 *   - settlement after the deadline: one batched keeper call carrying every slot's outcome code
 *     (Table 1), with failed rounds settled on the same path;
 *   - a settlement queue: every new request settles up to `settlePerRequest` due rounds, so
 *     settlement never depends on an outside keeper bot (anyone may also call settle());
 *   - getOutcomeScores (item 11): every counted reveal's score for one outcome, so a consumer can
 *     apply a Q-of-N rule (item 12).
 *   Calls to arbiter contracts get a fixed gas stipend, and every call whose failure is tolerated
 *   first checks that enough gas is left, so neither an arbiter (gas bomb) nor a caller (a tight
 *   gas limit) can make one slot, or the keeper's settlement, fail on purpose.
 * @dev Round ids are sequential (aggId = bytes32(roundId)), which lets a Chainlink request id map to
 *      (round, slot) in a single storage word. Scores are on the arbiters' 0..1,000,000 scale.
 */
contract ReputationAggregator is ChainlinkClient, Ownable, ReentrancyGuard, Pausable {
    using Chainlink for Chainlink.Request;

    // ------------------------------------------------------------------ constants
    uint8 private constant PH_DRAW = 1;           // escrowed, awaiting the jury draw
    uint8 private constant PH_BEACON = 2;         // sealed, awaiting the beacon values
    uint8 private constant PH_COMMIT = 3;
    uint8 private constant PH_CLOSING = 4;        // commit window closed, awaiting the sealed promotion draw
    uint8 private constant PH_REVEAL = 5;
    uint8 private constant PH_FINAL = 6;          // aggregated, awaiting settlement
    uint8 private constant PH_SETTLED = 7;
    uint8 private constant PH_FAILED = 8;         // failed and settled
    uint8 private constant PH_CANCELLED = 9;      // never drawable: prepay sent to the treasury

    uint8 private constant S_DISPATCHED = 1;
    uint8 private constant S_COMMITTED = 2;
    uint8 private constant S_PROMOTED = 4;
    uint8 private constant S_REVEALED = 8;
    uint8 private constant S_COUNTED = 16;

    uint256 private constant MAX_CID_COUNT = 10;
    uint256 private constant MAX_CID_LENGTH = 100;
    uint256 private constant MAX_ADDENDUM_LENGTH = 1000;
    uint256 private constant MAX_REVEAL_CID_LENGTH = MAX_CID_LENGTH + 21;
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
    struct Slot {
        address oracle;       // s0
        uint96 fee;
        bytes32 key;          // s1
        address payee;        // s2
        uint40 committedAt;
        uint8 flags;
        uint8 qcode;
        bytes16 commitHash;   // s3
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
        uint40 windowEnd;     // draw time + T+
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
        bytes32 sealedHash;   // s5
        string payload;
        uint256[] aggregated;
        uint256[] median;
        uint8[] order;        // counted slots, in reveal order
        string justifications;
        mapping(uint256 => Slot) slots;
        mapping(uint256 => uint256[]) likes;
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
    error OnlySelf();
    error InvalidConfig();
    error TooEarly();
    error SeedExpired();
    error OutOfGas();

    // ------------------------------------------------------------------ events
    event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
    event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);
    event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes16 commitHash);
    event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted);
    event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock);
    event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash);
    event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward);
    event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons);
    event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    event RoundCancelled(bytes32 indexed aggRequestId, uint256 toTreasury);
    event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode);
    event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
    event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase);
    event RoundSettled(bytes32 indexed aggRequestId, bool failed);
    event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
    event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
    event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);
    event EthWithdrawn(address indexed payee, uint256 amount);
    /// @dev reason: 1 owner() reverted, 2 commit dispatch reverted, 3 reveal dispatch reverted, 4 keeper call reverted
    event SlotSkipped(bytes32 indexed aggRequestId, uint256 pollIndex, uint8 reason);

    // ------------------------------------------------------------------ config
    uint8 public K = 6;
    uint8 public M = 5;
    uint8 public N = 4;
    uint8 public P = 3;
    uint8 public bonusMultiplier = 3;
    uint8 public settlePerRequest = 2;
    uint8 public drawRewardFees = 2;           // drawer reward, in per-arbiter fees
    uint8 public promoteRewardFees = 1;        // promote() caller's reward, so third parties call it
    uint40 public requesterDrawPriority = 30;  // seconds in which only the requester earns the reward
    address public treasury;
    uint40 public responseTimeoutSeconds = 300;
    uint40 public tPlus = 155;                 // mean + 2 SD of honest commit latency (item 14, Oct-Nov 2026)
    uint40 public revealWindow = 120;          // reveal time guaranteed after promotion (reveal p90 54 s)
    uint40 private constant DRAW_GRACE = 1 days; // a sealed round nobody could draw for this long is cancelled
    /// @dev stipend per oracle request (CBOR build + LINK transferAndCall + operator): an honest request
    ///      needs ~125k, ~175k at the largest payload (TestOperator); a gas-burning operator costs at most this
    uint32 public dispatchGas = 250_000;
    uint256 public spreadFloor = 30_000;       // 3 points on the arbiters' 0..1,000,000 scale
    uint256 public maxOracleFee = 4e14;
    uint256 private constant MAX_LIKELIHOOD_LENGTH = 20;

    ReputationKeeper public keeper;
    IJuryBeacons public beacons;

    // ------------------------------------------------------------------ state
    uint256 public roundCount;
    mapping(uint256 => Round) internal rounds;
    mapping(bytes32 => uint256) public requestRef;      // chainlink request id => roundId << 8 | slot
    mapping(address => uint256) public ethOwed;
    uint256[] public settleQueue;
    uint256 public settleHead;

    constructor(address link, address _keeper) Ownable(msg.sender) {
        _setChainlinkToken(link);
        keeper = ReputationKeeper(_keeper);
        treasury = msg.sender;
    }

    // ================================================================== request
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass,
        bool withBeacons
    ) external payable nonReentrant whenNotPaused returns (bytes32 aggId) {
        if (address(keeper) == address(0)) revert KeeperNotSet();
        string memory payload =
            AggregatorLib.buildCommitPayload(cids, addendumText, MAX_CID_COUNT, MAX_CID_LENGTH, MAX_ADDENDUM_LENGTH);

        // settle due rounds first: bounded work, so settlement never waits for an outside caller
        _settleDue(settlePerRequest);

        uint256 effMaxFee = maxFee < maxOracleFee ? maxFee : maxOracleFee;
        if (estimatedBaseCost >= effMaxFee || alpha > 1000 || maxFeeBasedScalingFactor < 1 || maxFeeBasedScalingFactor > type(uint16).max)
            revert BadInput();
        uint256 required = maxTotalFee(maxFee, withBeacons);
        // credit covers only what msg.value does not; any excess value goes back to credit, so the
        // escrow is exactly `required` (a treasury path never takes more than the round's prepay)
        uint256 fromCredit = msg.value < required ? required - msg.value : 0;
        uint256 credit = ethOwed[msg.sender];
        if (credit < fromCredit) revert InsufficientPayment();
        ethOwed[msg.sender] = credit - fromCredit + (msg.value + fromCredit - required);

        uint256 id = ++roundCount;
        aggId = bytes32(id);
        Round storage r = rounds[id];
        r.requester = msg.sender;
        r.K = K;
        r.M = M;
        r.N = N;
        r.P = P;
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
        r.payload = payload;
        emit RequestFunded(aggId, msg.sender, fromCredit, msg.value);
        emit RequestAIEvaluation(aggId, cids);
    }

    /// @notice Escrow for one request: eff x (K + B x P + drawRewardFees + promoteRewardFees), plus the
    ///         beacon quorum if `withBeacons` (reverts if no beacon contract is set).
    function maxTotalFee(uint256 maxFee, bool withBeacons) public view returns (uint256) {
        uint256 eff = maxFee < maxOracleFee ? maxFee : maxOracleFee;
        uint256 n = uint256(K) + uint256(bonusMultiplier) * P + drawRewardFees + promoteRewardFees;
        if (withBeacons) n += beacons.quorum();
        return eff * n;
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
     *         covers the whole class list; otherwise the prepay goes to the treasury.
     *
     *         With beacons, the first call only starts the beacon stage (no reward) and the draw needs
     *         a second call once the quorum is in; the 30 s priority then runs from the quorum-th value.
     *         A second call after the beacon deadline without the quorum ends the round: the beacons
     *         that answered are paid and the rest of the prepay goes to the treasury.
     */
    function drawJury(bytes32 aggId) external nonReentrant {
        uint256 id = uint256(aggId);
        Round storage r = rounds[id];
        uint256 eff = r.effMaxFee;
        uint256 anchor = r.requestTime;
        bytes32 seed;
        if (r.phase == PH_DRAW) {
            if (r.sealedHash == bytes32(0)) _seal(r, aggId);
            if (r.beaconFees != 0) {
                uint256 picked = beacons.start(aggId, keccak256(abi.encodePacked(aggId, "beacons", r.sealedHash)),
                    r.cls, r.requestBlock, r.requestTime, r.beaconFees);
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
        } else if (r.phase == PH_BEACON) {
            (uint8 st, bytes32 mix, uint256 readyAt, address[] memory payees) = beacons.result(address(this), aggId);
            if (st != 2 && st != 3) revert TooEarly();
            for (uint256 i = 0; i < payees.length; i++) {
                ethOwed[payees[i]] += eff;
                emit BeaconPayment(aggId, payees[i], eff);
            }
            r.rewardCredited += uint88(eff * payees.length);
            if (st == 3) {
                r.phase = PH_FAILED;              // quorum missed: no result, and no refund (a free re-roll)
                _refund(r, aggId, treasury);
                emit EvaluationFailed(aggId, PH_BEACON);
                return;
            }
            seed = keccak256(abi.encodePacked(aggId, r.sealedHash, mix));
            anchor = readyAt;
        } else {
            revert WrongPhase();
        }
        ReputationKeeper.Selected[] memory sel;
        uint256 g = gasleft();
        try keeper.selectArbiters(
            ReputationKeeper.SelectParams(r.K, r.alpha, eff, r.baseCost, r.scaling, r.cls), seed, r.requestBlock, r.requestTime
        ) returns (ReputationKeeper.Selected[] memory s_) {
            sel = s_;
        } catch {
            if (gasleft() < g / 63) revert OutOfGas();
            r.phase = PH_FAILED;
            // After a beacon stage, a failure that could depend on the seed (the walk covers only part
            // of the class list) is a re-roll the beacons' timing could choose, so no refund then
            _refund(r, aggId, r.beaconFees != 0 && !keeper.scansAll(r.cls) ? treasury : r.requester);
            emit EvaluationFailed(aggId, PH_DRAW);
            return;
        }
        if (sel.length != r.K) revert BadSelectionCount();

        r.phase = PH_COMMIT;
        r.start = uint40(block.timestamp);
        r.windowEnd = uint40(block.timestamp) + tPlus;
        r.mPlus = uint8(uint256(r.M) + (uint256(r.K) - r.M + 1) / 2);
        r.deadline = uint40(block.timestamp) + responseTimeoutSeconds;
        string memory payload = r.payload;
        uint96 base;
        for (uint256 i = 0; i < sel.length; i++) base += _pollSlot(r, aggId, id, i, sel[i], payload, eff);
        r.baseCredited = base;

        uint256 reward;
        bool early = block.timestamp <= anchor + requesterDrawPriority;
        if (!early || msg.sender == r.requester) {
            reward = eff * r.drawFees;
            ethOwed[msg.sender] += reward;
            r.rewardCredited += uint88(reward);
        }
        settleQueue.push(id);
        emit JuryDrawn(aggId, msg.sender, reward);
    }

    /// @notice A round that can never be drawn goes to the treasury, never back to the requester (a
    ///         refund would be a free re-roll): unsealed once blockhash(B+1) left the 8,191-block
    ///         history, or sealed but undrawn for DRAW_GRACE (a draw that cannot fit in a transaction,
    ///         or a beacon stage nobody concluded; its beacons are then not paid).
    function cancelUnsealed(bytes32 aggId) external nonReentrant {
        Round storage r = rounds[uint256(aggId)];
        if (r.phase != PH_DRAW && r.phase != PH_BEACON) revert WrongPhase();
        if (r.sealedHash == bytes32(0) ? block.number <= uint256(r.requestBlock) + 1 + HISTORY_WINDOW
                                       : block.timestamp <= uint256(r.requestTime) + DRAW_GRACE) revert TooEarly();
        r.phase = PH_CANCELLED;
        ethOwed[treasury] += r.ethReceived;
        emit RoundCancelled(aggId, r.ethReceived);
    }

    function _pollSlot(
        Round storage r,
        bytes32 aggId,
        uint256 id,
        uint256 i,
        ReputationKeeper.Selected memory s,
        string memory payload,
        uint256 effMaxFee
    ) internal returns (uint96 credited) {
        if (s.fee > effMaxFee) revert InsufficientPayment();
        Slot storage sl = r.slots[i];
        sl.oracle = s.oracle;
        sl.fee = uint96(s.fee);
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
            emit SlotSkipped(aggId, i, 1);
            return 0;
        }
        address payee = address(uint160(w));
        (bool sent, bytes32 opReq) = _dispatch(aggId, s.oracle, s.key, payload);
        if (sent) {
            sl.payee = payee;
            sl.flags = S_DISPATCHED;
            requestRef[opReq] = (id << 8) | i;
            ethOwed[payee] += s.fee;
            credited = uint96(s.fee);
            emit BasePayment(aggId, i, payee, s.fee);
        } else {
            emit SlotSkipped(aggId, i, 2);
        }
    }

    /// @dev one oracle request with the fixed stipend; false if the operator reverted or burned it all
    function _dispatch(bytes32 aggId, address oracle, bytes32 key, string memory payload) internal returns (bool, bytes32) {
        bytes32 jobId = keeper.jobIdOf(key);
        uint256 dg = dispatchGas;
        _needGas(dg);
        try this.dispatchOracleRequest{gas: dg}(aggId, oracle, jobId, payload) returns (bytes32 opReq) {
            return (true, opReq);
        } catch {
            return (false, 0);
        }
    }

    /// @dev self-call trampoline so a reverting operator hook fails only its own slot
    function dispatchOracleRequest(bytes32 aggId, address operator, bytes32 jobId, string calldata payload)
        external
        returns (bytes32)
    {
        if (msg.sender != address(this)) revert OnlySelf();
        Chainlink.Request memory req = _buildOperatorRequest(jobId, this.fulfill.selector);
        req._add("cid", payload);
        req._add("aggId", AggregatorLib.bytes32ToHex(aggId));
        return _sendOperatorRequestTo(operator, req, 0);
    }

    // ================================================================== commit / reveal
    function fulfill(bytes32 requestId, uint256[] memory response, string memory cid)
        public
        recordChainlinkFulfillment(requestId)
        nonReentrant
    {
        uint256 ref = requestRef[requestId];
        if (ref == 0) revert UnknownRequest();
        uint256 id = ref >> 8;
        uint256 s = ref & 0xff;
        Round storage r = rounds[id];
        Slot storage sl = r.slots[s];
        if (block.timestamp > r.deadline) return;               // too late: settlement decides

        if (response.length == 1 && bytes(cid).length == 0) {
            // ---------------- commit
            bytes16 h = bytes16(bytes32(response[0] << 128));
            if (r.phase != PH_COMMIT || h == bytes16(0) || sl.flags & S_COMMITTED != 0) return;
            sl.commitHash = h;
            sl.committedAt = uint40(block.timestamp);
            sl.flags |= S_COMMITTED;
            uint256 c = ++r.commits;
            emit CommitReceived(bytes32(id), s, h);
            if (c >= r.mPlus || (block.timestamp > r.windowEnd && c >= r.M)) _closeWindow(r, id);  // M+ / T+
            return;
        }

        // ---------------- reveal (accepted until the deadline, also after finalization)
        if (r.phase != PH_REVEAL && r.phase != PH_FINAL) return;   // incl. CLOSING: no reveal requests yet
        if (sl.flags & (S_PROMOTED | S_REVEALED) != S_PROMOTED) return;
        if (response.length < 2 || response.length > MAX_LIKELIHOOD_LENGTH) return;
        if (bytes(cid).length > MAX_REVEAL_CID_LENGTH) return;
        (bool ok, string memory cleanCid, uint256 salt) = AggregatorLib.parseCidSalt(cid);
        if (!ok) return;
        if (bytes16(sha256(abi.encode(msg.sender, response, salt))) != sl.commitHash) return;
        for (uint256 i = 0; i < response.length; i++) if (response[i] > MAX_SCORE) response[i] = MAX_SCORE;
        sl.flags |= S_REVEALED;

        if (r.phase == PH_REVEAL) {
            sl.flags |= S_COUNTED;
            r.likes[s] = response;
            r.cids[s] = cleanCid;
            r.order.push(uint8(s));
            emit RevealReceived(bytes32(id), s, false, 0);
            if (++r.reveals == r.N) _finalize(r, id);
        } else {
            uint8 q = ScoringLib.classifyOne(response, r.median, r.spread);
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
        for (uint256 j = 0; j < m; j++) {
            uint256 s = chosen[j];
            Slot storage sl = r.slots[s];
            sl.flags |= S_PROMOTED;
            string memory payload = string(abi.encodePacked("2:", AggregatorLib.bytes16ToHexLower(sl.commitHash)));
            (bool sent, bytes32 opReq) = _dispatch(aggId, sl.oracle, sl.key, payload);
            if (sent) requestRef[opReq] = (id << 8) | s;
            else emit SlotSkipped(aggId, s, 3);
        }
        emit CommitPhaseComplete(aggId, m);
    }

    // ================================================================== finalize
    function _finalize(Round storage r, uint256 id) internal {
        uint256 n = r.order.length;
        uint256[][] memory ll = new uint256[][](n);
        for (uint256 i = 0; i < n; i++) ll[i] = r.likes[r.order[i]];
        (ll, ) = AggregatorLib.normalizeToModal(ll);
        (bool[] memory inCl, uint256[] memory agg, uint8[] memory codes, uint256[] memory med, uint256 spread) =
            ScoringLib.aggregate(ll, r.P, spreadFloor);
        uint96 bonus;
        bytes memory just;
        for (uint256 i = 0; i < n; i++) {
            if (!inCl[i]) continue;
            uint256 s = r.order[i];
            Slot storage sl = r.slots[s];
            uint256 b = uint256(sl.fee) * r.bonusMult;
            if (b > 0) {
                ethOwed[sl.payee] += b;
                bonus += uint96(b);
                emit BonusPayment(bytes32(id), s, sl.payee, b);
            }
            just = just.length == 0 ? bytes(r.cids[s]) : abi.encodePacked(just, ",", r.cids[s]);
        }
        r.aggregated = agg;
        r.justifications = string(just);
        r.bonusCredited = bonus;
        for (uint256 i = 0; i < n; i++) r.slots[r.order[i]].qcode = codes[i];
        r.median = med;
        r.spread = uint128(spread);
        r.phase = PH_FINAL;
        _refund(r, bytes32(id), r.requester);
        emit FulfillAIEvaluation(bytes32(id), agg, string(just));
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

    function _settleDue(uint256 maxCount) internal {
        uint256 h = settleHead;
        uint256 len = settleQueue.length;
        // already-settled entries (settle() called directly) count as steps too, so holes in the queue
        // cannot make a request's walk unbounded
        uint256 limit = maxCount * 8;
        uint256 c;
        for (uint256 steps = 0; steps < limit && h < len; steps++) {
            Round storage r = rounds[settleQueue[h]];
            if (r.phase < PH_SETTLED) {
                if (c == maxCount || block.timestamp <= r.deadline) break;
                _settle(r, settleQueue[h]);
                c++;
            }
            h++;
        }
        settleHead = h;
    }

    function _settle(Round storage r, uint256 id) internal {
        uint8 ph = r.phase;
        bool failed = ph != PH_FINAL;
        bytes32 aggId = bytes32(id);
        if (failed) {
            // M commits were in but the round was never promoted (closed and not promoted, or not
            // closed after T+): the unspent prepay goes to the treasury, so a requester that dislikes
            // the jury or the promotion draw cannot abort for a refund
            _refund(r, aggId, ph == PH_CLOSING || (ph == PH_COMMIT && r.commits >= r.M) ? treasury : r.requester);
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
                // -400 only if the round failed for lack of commits (not for want of a closeCommits call)
                if (f & S_COMMITTED == 0 && r.commits < r.M) code = T_NOCOMMIT_FAILED;
            } else if (ph == PH_CLOSING) {
                code = 0;   // enough commits arrived; nobody promoted, so nobody failed to deliver
            } else if (f & S_PROMOTED != 0) {
                if (f & S_REVEALED != 0) code = failed ? T_DELIVERED : uint8(T_DELIVERED | (sl.qcode << 4));
                else code = failed ? T_MISS_FAILED : T_MISS_FINISHED;
            }
            if (code != 0 && f & S_COMMITTED != 0) code |= C_COMMITTED;   // proved up: scored even if frozen
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
        return (r.aggregated, r.justifications, valid);
    }

    /// @notice Item 11: every counted reveal's raw score for `outcome`, in reveal order (a short reveal
    ///         gives 0). `valid` is false until the round is finalized, and for a failed round.
    function getOutcomeScores(bytes32 aggId, uint256 outcome) external view returns (uint256[] memory scores, bool valid) {
        Round storage r = rounds[uint256(aggId)];
        if ((r.phase != PH_FINAL && r.phase != PH_SETTLED) || outcome >= r.aggregated.length) return (scores, false);
        uint256 n = r.order.length;
        scores = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256[] storage v = r.likes[r.order[i]];
            if (outcome < v.length) scores[i] = v[outcome];
        }
        valid = true;
    }

    function getSlot(bytes32 aggId, uint256 i) external view returns (Slot memory) {
        return rounds[uint256(aggId)].slots[i];
    }

    /// @notice phase (1 draw, 2 beacons, 3 commit, 4 closing, 5 reveal, 6 final, 7 settled, 8 failed,
    ///         9 cancelled), draw blocks, and the escrow: received, base fees, bonuses, rewards (draw,
    ///         promote, beacons). Received minus the three credited amounts is refunded at the end.
    function getRoundInfo(bytes32 aggId)
        external
        view
        returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock,
                 uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards)
    {
        Round storage r = rounds[uint256(aggId)];
        return (r.phase, r.requestBlock, r.sealedHash, r.closeBlock, r.ethReceived, r.baseCredited, r.bonusCredited, r.rewardCredited);
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
        if (msg.sender != payee && msg.sender != owner()) revert NotAuthorized();
        _withdrawTo(payee);
    }

    // ================================================================== owner configuration
    /// @dev P >= 2 unless N = 1: the cluster always holds at least the closest pair, and the escrow
    ///      only covers B x P bonuses.
    /// @notice Jury and timing for new requests. P >= 2 unless N = 1: the cluster always holds at least
    ///         the closest pair, and the escrow only covers B x P bonuses. T+ (seconds) comes from measured
    ///         honest commit latency (mean + 2 SD) and must be below the timeout.
    function setConfig(uint8 _K, uint8 _M, uint8 _N, uint8 _P, uint40 timeout, uint40 tPlus_) external onlyOwner {
        if (!(_K >= _M && _M >= _N && _N >= _P && _N >= 1 && (_P >= 2 || _N == 1) && _P >= 1) || tPlus_ == 0 || timeout <= tPlus_)
            revert InvalidConfig();
        (K, M, N, P, responseTimeoutSeconds, tPlus) = (_K, _M, _N, _P, timeout, tPlus_);
    }

    /// @notice Bonus multiplier (at most 20), rounds settled per request, the per-call dispatch stipend
    ///         (100k..2M), the quality spread floor and the fee ceiling.
    function setParams(uint8 bonusMult, uint8 settlePerReq, uint32 dispatchGas_, uint256 spreadFloor_, uint256 maxOracleFee_)
        external
        onlyOwner
    {
        if (bonusMult > 20 || dispatchGas_ < 100_000 || dispatchGas_ > 2_000_000) revert InvalidConfig();
        (bonusMultiplier, settlePerRequest, dispatchGas, spreadFloor, maxOracleFee) =
            (bonusMult, settlePerReq, dispatchGas_, spreadFloor_, maxOracleFee_);
    }

    /// @dev applies to new requests only: each round keeps the fees its escrow was sized on
    function setRewards(uint8 drawFees_, uint40 priority, uint8 promoteFees_, uint40 revealWindow_) external onlyOwner {
        if (revealWindow_ == 0) revert InvalidConfig();
        (drawRewardFees, requesterDrawPriority, promoteRewardFees, revealWindow) = (drawFees_, priority, promoteFees_, revealWindow_);
    }

    /// @notice Keeper, beacon contract (0 = beacons off) and treasury. Rounds in flight keep calling the
    ///         new ones: change the keeper only when no round awaits settlement, and the beacon contract
    ///         only when no round is in its beacon stage.
    function setContracts(address keeper_, address beacons_, address treasury_) external onlyOwner {
        if (keeper_ == address(0) || treasury_ == address(0)) revert InvalidConfig();
        (keeper, beacons, treasury) = (ReputationKeeper(keeper_), IJuryBeacons(beacons_), treasury_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
