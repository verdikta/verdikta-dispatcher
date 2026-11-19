# TODO

Planned work for the reputation-based aggregator contracts. Newest ideas at the
bottom; check items off as they land.

---

## 1. Batch the keeper calls in finalization to cut gas

**Status:** not started
**Scope:** `ReputationAggregator.sol` + `ReputationKeeper.sol` (both must change together)

### Problem
Finalization is the gas cliff of a round: the Nth (final) reveal triggers
`_finalizeAggregation`, which loops over all K polled slots in `_processPollSlot`
and makes **two external calls into the keeper per slot** — one `getOracleInfo`
(just to read the `isActive` flag) and one `updateScores` (which writes reputation
state). That is up to ~2K cross-contract calls, all charged to whichever oracle
happened to submit the last reveal. The per-call overhead (and the keeper's own
SLOADs/SSTOREs) dominates the finalize cost, and none of it can be moved off the
Nth reveal because the scores depend on the final clustering.

### Idea
Collapse those per-slot calls into a single batched call to the keeper:

- Add a batch entrypoint on the keeper, e.g.
  `updateScoresBatch(address[] oracles, bytes32[] jobIds, int8[] qualityDeltas, int8[] timelinessDeltas)`,
  applying all K updates in one call (same per-oracle logic as `updateScores`,
  including the slashing/blocking checks and the `usedOracles` authorization guard).
- Optionally fold the active-status read into the same call (return an `active[]`
  array, or have the keeper skip inactive entries internally) so the K separate
  `getOracleInfo` static calls disappear too.
- In the aggregator, `_finalizeAggregation` builds the four arrays as it walks the
  slots / cluster result, then makes one `updateScoresBatch` call instead of K
  individual `updateScores` calls. Bonus crediting stays in the aggregator.

### Why it's deferred
Requires a coordinated change across both contracts (new keeper ABI + redeploy of
both), so it is out of scope for the current round of aggregator-only edits.

### Expected payoff
Turns ~2K external calls into ~1, removing the bulk of the per-call overhead from
the final reveal. Does not change protocol behavior or fund accounting — purely a
gas optimization of how the existing per-oracle score updates are dispatched.

### Notes / related
- An alternative way to take the tally off the unlucky Nth oracle entirely is to
  decouple finalization into its own permissionless `finalize(aggId)` call. That is
  a separate, larger design change (changes oracle/requester UX) and is **not** part
  of this item.
- A smaller, aggregator-only partial win (dropping the redundant per-slot
  `getOracleInfo` active-recheck) was considered and deferred — it carries a minor
  behavior change for oracles deactivated mid-round, so it was left out for now.

---

## 2. Make oracle selection cost independent of registry size

**Status:** not started
**Scope:** `ReputationKeeper.sol` (selection indexing) — keeper change

### Problem
`ReputationKeeper.selectOracles` scans the whole `registeredOracles` array twice on
every request (once to count eligible oracles, once to fill the eligible array) before
shortlisting, so per-request selection gas is O(registeredOracles) and grows linearly
as more oracles register.

### Idea
Avoid the full-array scan per request:

- Maintain a per-class index of registered oracles (e.g. `mapping(uint64 => bytes32[])`)
  updated on register/deregister/setActive, so `selectOracles` iterates only candidates
  for the requested class.
- Or paginate/sample over a bounded window instead of the whole registry.
- Either way, keep the eligibility predicate (active, fee <= maxFee, not blocked,
  hasClass) and the weighted-selection semantics unchanged.

### Why it's deferred
Lives entirely in the keeper, out of scope for the current aggregator-only edits, and
would need its own redeploy + migration of the index state.

### Expected payoff
Keeps per-request selection gas roughly constant regardless of registry size.

### Notes / related
- `resetAllReputations` does the same full-registry walk and would benefit from the
  same indexing.

---

## 3. Let a requester direct the unspent-prepay refund to a third party

**Status:** not started
**Scope:** `ReputationAggregator.sol` (request entrypoint + `_refundRequester`)

### Problem
`requestAIEvaluationWithApproval` keys the `ethOwed` refund of any unspent prepay to the
**caller** (`msg.sender`). That's correct when the caller is the end user, but wrong when a
contract requests **on behalf of** someone else — the refund strands on the intermediary.

The Verdikta bounty program (`example-bounty-program`) hits this directly. Because refunds go
to the caller, BountyEscrow can't be the requester (all submissions' refunds would pool into
one `ethOwed[BountyEscrow]` with no on-chain way to attribute each refund to the right hunter
— the per-request refund is only emitted as the `RequesterRefunded` event, not exposed as a
getter). To work around it, BountyEscrow deploys a **throwaway `EvaluationWallet` contract per
submission** purely so each submission's refund lands in its own isolated `ethOwed[wallet]`
bucket. That wallet costs a full deploy per submission, is single-use (so the "credit
auto-applies to your next request" path is dead weight), and can't be withdrawn by the hunter
(only the wallet is `msg.sender`) — so BountyEscrow must pull the credit out and forward it, a
hand-off that had to be made revert-proof to avoid a DoS (a hunter contract that rejects ETH
could otherwise brick submission resolution and lock the creator's escrow).

### Idea
Add an optional **refund beneficiary** to the request, e.g. an overload:

    requestAIEvaluationWithApproval(..., address refundTo)

Store it per aggregation (default `refundTo = msg.sender` for the existing signature) and have
`_refundRequester` credit `ethOwed[refundTo]` instead of `ethOwed[requester]`. Keep the
fund-from-credit path (`_fundFromCredit`) keyed to the actual `msg.sender` — only the
settlement-refund destination changes. Safe: `refundTo` only ever *receives* a credit (can't be
harmed), and the caller spends its own `msg.value`, so there's no new griefing surface.

### Expected payoff
The bounty program could make **BountyEscrow the direct requester** with `refundTo = hunter`,
so each hunter's unspent prepay lands in their own `ethOwed[hunter]` account — withdrawable
directly by the hunter (the normal playground/arbiter model). That lets the bounty program
**delete the per-submission `EvaluationWallet` entirely**: no per-submission deploy gas, no
pull-and-forward hand-off, and the close-out DoS vanishes at the source (close-out no longer
needs to move ETH to the hunter — the refund just sits as the hunter's own aggregator credit).

### Why it's deferred
Aggregator-side change needing its own redeploy. The bounty program already ships a
contract-side workaround (per-submission wallets + a pull-payment ledger in BountyEscrow,
deployed 2026-06-10) that closes the correctness/DoS gap without touching the aggregator, so
this is a simplification/efficiency win, not a blocker.

### Notes / related
- The per-request refund is currently observable only via `RequesterRefunded(aggId, requester,
  amount)`; if `refundTo` is added, emit it there too.
- Alternative that avoids changing the request signature: expose the per-aggId refund as a view
  (e.g. a settled-refund getter) so an intermediary could attribute pooled refunds on-chain —
  but `refundTo` is cleaner and removes the intermediary entirely.

---

## 4. Increase the commit salt from 80 to 128 bits

**Status:** not started
**Scope:** `ReputationAggregator.sol` + `AggregatorLib.sol` + arbiter node (commit/reveal format change)

### Problem
The salt an arbiter binds into its commitment is 80 bits: the reveal carries
`"<cid>:<20 hex chars>"`, enforced by `AggregatorLib.isValidCidSalt` / `parseCidSaltUnchecked`.
It is also the arbiter's contribution to `rollingEntropy` (`_updateEntropy` takes
`bytes10(uint80(saltUint))`). 80 bits is on the low side for both jobs.

### Idea
- Widen the salt to 128 bits: 32 hex chars in the reveal string.
- Update `isValidCidSalt` / `parseCidSaltUnchecked` (fixed length 20 -> 32).
- Update `MAX_REVEAL_CID_LENGTH` (`MAX_CID_LENGTH + 21` -> `MAX_CID_LENGTH + 33`).
- Mix the full value into entropy: `_updateEntropy(bytes16(uint128(saltUint)))`.
- Arbiter node: generate 16 random bytes for the salt and emit 32 hex chars.

### Why it's deferred
It changes the commit/reveal wire format, so the aggregator redeploy and the arbiter-node
release must ship together. Old-format reveals would fail `isValidCidSalt` against the new
contract, and new-format reveals would fail against the old one.

### Notes / related
- Land together with item 5: both change the commitment format, so do one coordinated
  node release instead of two.
- Update `test/aggregatorEth.test.js` and the commit/reveal descriptions in
  `docs/contracts/arbiter-operator.md`, `docs/advanced/security.md`, `docs/api/events.md`.
- The legacy LINK aggregator (`ReputationAggregatorLINK.sol`) has been removed from the
  tree, so only `ReputationAggregator.sol` needs to change.

---

## 5. Use Keccak-256 everywhere (replace the one SHA-256 use)

**Status:** not started
**Scope:** `ReputationAggregator.sol` + arbiter node (commit hash change)

### Problem
The reveal check is the only SHA-256 use in the live contract:
`bytes16(sha256(abi.encode(msg.sender, response, saltUint)))` in `fulfill`. Everything else
(aggId, entropy mixing, proposed hash chains) uses keccak256. SHA-256 goes through a
precompile call, which costs more gas than the native KECCAK256 opcode, and mixing two hash
functions in one protocol is an avoidable source of off-chain mismatch bugs.

### Idea
- Change the check to `bytes16(keccak256(abi.encode(msg.sender, response, saltUint)))`.
- Arbiter node computes the commitment with keccak256 over the same ABI encoding.
- Update the comment on the zero-commit guard in `fulfill` that refers to `sha256(...)`.

### Why it's deferred
Same lockstep problem as item 4: every arbiter must switch at the same moment the new
aggregator goes live, or its reveals will hash-mismatch and it will be penalized as a
no-show.

### Notes / related
- Ship with item 4 (one format change).
- The commitment is still truncated to 128 bits (`bytes16`); that is unchanged by this item.

---

## 6. Verifiable entropy from arbiter hash chains, to stop selection steering

**Status:** not started (design discussed 2026-10-30)
**Scope:** `ReputationAggregator.sol` + `ReputationKeeper.sol` + arbiter node (new request mode)

### Problem
Every input to `selectOracles` is known before the request is sent: `entropyBuf` and
`selectionCounter` are public, `block.timestamp` is predictable, and on Base `PREVRANDAO`
comes from the L1 origin block. Since Base moved to 0.2 s blocks (2026-11-05), about 60
consecutive blocks share one `PREVRANDAO` and about 5 share one `block.timestamp` (whole seconds),
so the seed changes about once a second. The first stage (the 20-arbiter shortlist, see
`selectOracles`) uses only `block.timestamp` and `block.prevrandao`. So a requester can
simulate selection locally and time the request so that colluding arbiters are selected
(with P = 2, two colluders that agree form the winning cluster). Arbiter-supplied entropy
today (reveal salts) only affects later draws, and is public by the time anyone requests.

### Idea
Each arbiter commits to a hash chain at registration, and selection is deferred until
after the request is fixed, using values revealed from those chains.
- **Hash chain.** The arbiter picks a secret seed `s`, computes `v_n = s`,
  `v_{i-1} = keccak256(v_i)`, and registers the tip `v_0`. Each call reveals the next value.
  The contract checks `keccak256(v) == lastRevealed[key]` and stores `v`. Off-chain, a
  chain of 10^5 to 10^6 values with checkpoints every ~1000 is cheap to build and serve.
- **Exactly one step per call, no skipping.** If later values were accepted
  (`H^k(v) == last`), an arbiter could pick among its next k values. With one step, its
  only choice is to answer or withhold.
- **Deferred selection.**
  - The request records the round, escrows ETH and sends hash-chain calls to 6 random
    beacon arbiters. Beacons only need to be registered and not frozen, so pick random
    indexes into `registeredOracles` rather than running `selectOracles`.
  - The **first** valid reply triggers the draw:
    `seed = keccak256(aggId, v_first, blockhash(requestBlock))`.
  - The shortlist and the K-arbiter jury are drawn from `seed`, then the commit requests
    are sent.
  - The requester cannot know `blockhash(requestBlock)` or any beacon's next value when
    signing.
- **Trigger robustness.** Do the draw and dispatch in a gas-capped try/catch self-call so
  the beacon's reply always records even if the draw fails. Add a permissionless
  `startCommitPhase(aggId)` as the fallback (for an out-of-gas trigger, or a beacon
  deadline that passed with no replies). Read `blockhash(requestBlock)` through the EIP-2935
  history contract, whose window is 8,191 blocks (about 27 min at 0.2 s blocks); the
  `BLOCKHASH` opcode's 256 blocks are now only 51 s. Set the beacon deadline inside that window
  (for example 120 s); if it passes, fail and refund the round rather than falling back to a
  later block's hash, which would let the caller choose timing.
- **Who pays.** The draw costs roughly what the request costs today (~3.1M gas, growing
  with the registry; see item 2). Reimburse whoever triggers from the requester's prepay:
  - Add a fixed, owner-set `triggerGasReserveWei` to `maxTotalFee`. It must be fixed,
    not computed from basefee: BountyEscrow requires `msg.value == maxTotalFee(...)`
    exactly at start.
  - Pay `gasUsed * min(tx.gasprice, basefee + tipCap)`, capped at the reserve, as an
    `ethOwed` credit to the operator's `owner()` (the same payee rule as base fees).
  - Unused reserve refunds through the existing `_refundRequester` path.
- **Timeout clock.** Start `responseTimeoutSeconds` at commit dispatch, not at the
  request, so the beacon wait does not eat into the arbiters' time.
  `finalizeEvaluationTimeout` must also be able to end a round still in the beacon stage,
  so that BountyEscrow's `failTimedOutSubmission` can always close it.

### Why it's deferred
Large protocol change: new keeper state (chain tips, last revealed values), a new
aggregator round stage, a new arbiter request mode and node-side chain management, and a
redeploy of both contracts.

### Notes / related
- **Superseded as the near-term fix by item 9** (two-phase request, seed from
  `blockhash(B+1)`). A colluding first-responder beacon knows its own draw before answering,
  which in the risk model lowers the limit below item 9's. Keep beacons only as later
  hardening against the sequencer, in a form where withholding is uninformed.
- **Residual risk: racing.** A colluding beacon can choose to answer first or hang back,
  which lets it veto a draw but not choose one. Item 7's freeze rule makes withholding
  costly, and setting `slashAmountConfig` above 0 would add a stake cost.
- **Small interim fix (keeper only):** feed `entropyBuf` and `selectionCounter` into the
  shortlist draw. Today two selections in the same block get the same shortlist. This
  does not fix predictability.
- **Alternatives considered:** Chainlink VRF on Base (native-ETH payment, a fee and a few
  blocks per request), or unique signatures (BLS/VRF) from arbiters. Both avoid hash
  chains, but on-chain verification costs more gas and BLS depends on precompile support
  on Base.
- The hash-chain call is the same request as item 7's liveness test; build them together.
- **Base block timing (checked 2026-11-17).**
  - Base mainnet has made 0.2 s blocks since block ~53,556,261 (2026-11-05 18:00 UTC). The
    EIP-2935 history contract (`0x0000F90827F1C53a10cb7A02335B175320002935`) is live and returned
    the correct hash for blocks up to 8,000 back.
  - Beacon reply time is not measured yet (no hash-chain calls exist). A reply takes the same
    path as a reveal (node job, no inference, fulfill transaction), and mainnet reveals take a
    median of 15 s (p90 30 s, fastest 4–8 s; item 14, "Real latency"). That fits a 120 s deadline
    with room, but not by much inside 51 s during an outage, so use EIP-2935.
  - **Risk model rerun** (`selection_randomness_risk.py`, 0.2 s blocks, planning defaults, $0.50
    base fee). As written here, with `blockhash(requestBlock)`, the limit is about **$23**, the same
    as on 2 s blocks: a submitter working with a colluding beacon knows its next value, so it
    predicts the seed and grinds the request. Seeding from the reply's block instead
    (`beacon_seed_uses_response_block`) falls from about $120 to about **$7**, because a
    colluding beacon gets one re-roll per block until the first honest reply lands: about 2
    blocks before, about 75 now. Both are far below item 9's ~$400, which is why item 9 replaces
    this item.

---

## 7. Freeze arbiters that fail a hash-chain call; unfreeze on answer

**Status:** not started (design discussed 2026-10-30)
**Scope:** `ReputationKeeper.sol` + `ReputationAggregator.sol` + arbiter node (shares item 6's request mode)

### Problem
Dead arbiters keep being selected, and a round fails when more than K - M of its K polled
arbiters are down (with the default 6/4, three dead arbiters fail the round at the
5-minute timeout). Reputation removes them slowly:
- A no-show loses only 20 timeliness points and no quality points, so with a low `alpha`
  its selection weight barely drops.
- The "mild" threshold (-300) does not stop selection.
- Only the severe threshold (-900) or 25 consecutive worsening scores blocks an arbiter.
- `minScoreForSelection` keeps every arbiter's weight above zero.

Penalizing commit no-shows harder is unfair: a live but slower arbiter whose commit
arrives after the round finalizes looks identical to a dead one (`fulfill` reverts with
`AggregationComplete`).

### Idea
Judge liveness only by the item-6 hash-chain call, never by commits. The call needs no AI
work, so a short fixed deadline separates dead from slow fairly.
- **Who gets the calls.** The beacon calls in each request double as liveness tests.
  Arbiters that missed a commit in a settled round are marked **suspects** (one cheap
  write, still eligible) and are called first in the next request, then random arbiters.
  A dead arbiter then costs at most about one real round slot.
- **Freeze (lazy, no extra tx).** Store `callSentAt` / `callAnsweredAt` per arbiter. In
  the eligibility loop of `selectOracles`, skip any arbiter with an unanswered call older
  than the deadline D (e.g. 60s, owner-settable).
- **Unfreeze.** An arbiter is unfrozen when it answers a hash-chain call:
  - Late answers to the outstanding call count.
  - After restarting a node, the operator can call a self-service
    `requestHealthCall(oracle, jobId)` and pay the gas, so recovery does not depend on
    being picked at random. A restarted node may never process the old request.
  - The node should make this call automatically whenever it is frozen and healthy again, and
    the owner should be able to send calls to all frozen arbiters at once. Without that, a wide
    outage can deadlock: with every arbiter frozen, requests revert, so no calls go out and
    nobody unfreezes (see item 14, "Pool shortage").
- **Use a separate `frozen` state, not `blocked`.** `blocked` carries a 24-hour lock,
  slashing and auto-unblock inside `updateScores`. A frozen arbiter's reputation is
  untouched.

### Why it's deferred
Depends on item 6's hash-chain request mode and node support. Keeper and aggregator
redeploy.

### Notes / related
- **The call must exercise the AI pipeline.** Run it through the external adapter with a
  cheap AI-provider health check. Otherwise an arbiter whose AI backend is down passes
  every call, keeps failing real work, and is never frozen. Add backoff for arbiters that
  are frozen repeatedly (e.g. require two consecutive answers).
- **Pool-size guard.** If freezing drops the eligible count below K, `_weightedSelect`
  starts repeating arbiters in multiple slots. Fall back to reduced weight instead of
  exclusion in that case.
- **Gas.** The requester pays to send the calls. Arbiters pay to answer with no fee,
  which is part of staying eligible.
- Freezing protects future rounds, not the round in progress. Raising K (e.g.
  `setConfig(7, 4, 3, 2, 300)`, no redeploy) gives in-flight rounds slack in the meantime.
- **Related reputation tweaks:** give no-shows a small quality penalty, or block after
  ~3 consecutive misses. These are owner-settable or small keeper changes.

---

## 8. Requester-set minimum arbiter fee, to make repeated attempts uneconomic

**Status:** not started (design discussed 2026-11-01)
**Scope:** `ReputationAggregator.sol` + `ReputationKeeper.sol` (selection scoring) + bounty program
(`BountyEscrow.sol`, `EvaluationWallet.sol`). Breaking change to the request signature and
`maxTotalFee`; that is acceptable, since the next aggregator release is breaking anyway.

### Problem
When a lot is at stake, a query that is too cheap invites spam. An attacker can submit
low-effort entries over and over, hoping the arbiters return a false positive. An attempt
pays whenever p × stake > cost per attempt. Example: a $5,000 bounty with a 1% chance of a
false pass is worth $50 per attempt. At $0.50 per query the attacker profits from
resubmitting endlessly; at $60 they lose money. Today the requester can only set a ceiling
(`_maxOracleFee`). Cheap arbiters are always paid their posted fee, so the cost per attempt
cannot be raised.

### Idea
Add a per-request floor `_minOracleFee`. An arbiter whose fee is above the ceiling is still
rejected, as now. An arbiter whose fee is below the floor is paid the floor.
- **Keep eligibility and payment separate.** Eligibility stays `fee <= effMaxFee`, where
  `effMaxFee = min(_maxOracleFee, maxOracleFee)`. The amount paid is `max(fee, minFee)`.
  `minFee` may **exceed** `effMaxFee` and the global `maxOracleFee`. The global ceiling
  exists to keep LINK-scale arbiters out of selection, not to cap what a requester chooses
  to pay. This matters: at 0.0004 ETH × K = 6 the most anyone can be charged today is
  ~0.0024 ETH (a few dollars), far short of the $60 example.
- **Escrow.** `required = max(effMaxFee, minFee) * (K + B*P)`, and
  `maxTotalFee(maxOracleFee, minOracleFee)` returns the same value. Solvency holds the same
  way as now: the charge-time guard in `_pollOracle` checks against the same bound the escrow
  was sized on.
- **Payment.** In `_pollOracle`, keep `if (fee > effMaxFee) revert`, then store the paid
  amount in `pollFees` and credit it to `ethOwed` / `baseCredited`. The bonus at finalize is
  `pollFees[slot] * bonusMultiplierSnap`, so it scales off the paid amount automatically.
  That is intended. Consider emitting both the posted fee and the paid amount in
  `BasePayment`.
- **Keeper scoring (required).** `getSelectionScore` boosts cheaper arbiters. Below the
  floor every arbiter costs the requester the same, so score on `max(fee, minFee)`.
  Otherwise the cheapest arbiters win selection weight for no saving, and arbiters have a
  reason to post near-zero fees just to win selection while still collecting the floor,
  which makes posted fees meaningless. Pass `minFee` through `SelectionParams`.
- **Fix the existing boost discontinuity at the same time.** The boost applies only when
  `fee > estimatedBaseCost`. An arbiter priced at or below `estimatedBaseCost` gets a factor
  of 1 (no boost), while one priced just above it gets close to
  `maxFeeBasedScalingFactor`. Fees at or below the base cost should get the maximum boost.
- **Who sets the floor.** It only deters an attacker if the attacker cannot choose it. In
  the bounty case the attacker *is* the requester, so the **bounty creator** must set it:
  add `minOracleFee` to BountyEscrow's per-bounty oracle params (alongside `maxOracleFee`,
  `alpha`, `estimatedBaseCost`) and pass it through `EvaluationWallet`. Any application where
  submitters call the aggregator directly gets no protection from this; document that.

### Sizing guidance (for docs / bounty UI)
- The cost of an attempt that cannot be avoided is the base fee, credited to all K arbiters
  up front and never refunded: **K × minFee** (6 × minFee with the defaults). When a cluster
  forms, the bonus usually adds up to **B × P × minFee** more (another 6 ×). The leftover
  escrow is refunded.
- So a $60 deterrent means minFee ≈ $10, not $60. The bounty UI should ask the creator for a
  target cost per attempt and divide by K, rather than asking for a per-arbiter figure.
- Leave a margin above p × stake. p is the creator's guess, and each failed attempt returns
  arbiter justifications that help the attacker improve the next try, so p can rise.
- The floor is in wei, so a dollar-sized deterrent drifts with the ETH price over a
  long-lived bounty.

### Why it's deferred
It changes the request signature, `maxTotalFee`, and keeper selection scoring, so it needs a
coordinated redeploy of the aggregator and keeper plus a bounty-program release.

### Notes / related
- **Leakage when the floor goes to arbiters.** An attacker who also runs arbiters gets back
  the share paid to their own arbiters whenever they are selected (and an attacker-run
  arbiter that refuses dispatch is simply not credited), so their real cost is lower than
  K × minFee. Honest submitters also pay the full floor on every attempt.
- **Planned complement: payback to the bounty creator.** We may ultimately want both. In
  addition to the arbiter floor, the bounty contract can take a submission deposit that is
  **forfeited to the bounty creator on failure** and returned on success. An honest
  submitter with good work pays nothing extra, the attacker still pays ~(1 − p) × deposit per
  attempt, and running arbiters recovers none of it. That part lives entirely in
  BountyEscrow and needs no aggregator change. A likely split: a moderate floor so arbiters
  are paid properly for high-stakes work, plus a deposit for most of the deterrent.
- `maxTotalFee` also changes in item 6 (`triggerGasReserveWei`) and item 9 (the 2 × fee
  trigger reward). If they land in the same release, change its signature once.
- With item 3 (`refundTo`), BountyEscrow becomes the direct requester. That is also the
  natural place to hold and settle the creator-payback deposit.
- Update `test/aggregatorEth.test.js`, `docs/advanced/fees.md`,
  `docs/contracts/reputation-aggregator.md`, `docs/advanced/eth-payment-migration.md`, the
  `maxTotalFee` examples under `docs/examples/`, and `README.md`.

---

## 9. Two-phase request: commit first, draw the jury from a later block hash

**Status:** not started in the deployed contracts (design discussed 2026-11-07). Implemented in this
folder's v2 contracts with item 14, including the beacon flag (`JuryBeacons`). The v2 contracts replaced
v1 here on 2026-11-18; v1 is tag `aggregator-v0.1.0`.
**Scope:** `ReputationAggregator.sol` + `ReputationKeeper.sol` (selection inputs, checkpoints) +
bounty program (`BountyEscrow.sol`, `EvaluationWallet.sol`, site, agent skill and docs). Breaking
change to the request flow and `maxTotalFee`.

### Problem
Every input to `selectOracles` is known before the request is sent (see item 6). A requester
simulates the draw for each coming block and submits only when it polls two colluding arbiters.
Two colluders that report the same score are always the closest pair, so they decide the round.
Waiting costs nothing, so raising the fee barely helps. `scripts/selection_randomness_risk.py`
at its planning defaults (300 eligible arbiters, 3% colluders, SD 3) with a $0.50 base fee puts
the most value one decision should carry at **~$4.50** ($4.32–4.69 across seeds, rerun 2026-11-17).
A 10× higher fee raises that only 2.8×.

Item 6's first-responder beacon stops the requester from predicting the draw, but adds a
colluding beacon that can. It knows its own next value, and `blockhash(requestBlock)` is public
once the request is mined, so it answers only when its draw is good. In the model (rerun
2026-11-17) the limit is about $23: a submitter working with a colluding beacon predicts the seed
and grinds it. Seeding from the reply's block instead gives about $7 on Base's 0.2 s blocks (item 6,
"Base block timing").

### Idea
Split each request into two transactions in different blocks. The requester is committed before
the randomness exists.
- **Commit (block B).** The request escrows the prepay and records the query, `aggId`,
  `requestBlock = B` and the requester. No selection or polling happens yet. The requester
  cannot cancel the round.
- **Seed.** `seed = keccak256(aggId, blockhash(B+1))`. Nobody knows it when B's transaction is
  signed. Use B+1, not B: the requester's own transaction is in B, and Flashblocks show most of
  B's contents before it closes. Do not use `prevrandao` or `timestamp`. On Base (0.2 s blocks
  since 2026-11-05) about 60 consecutive blocks share one `prevrandao`, the L1-origin value, and
  about 5 share one `timestamp`, which is in whole seconds.
- **Enforcement.** `blockhash` returns 0 for the current and future blocks, so the draw must
  require `blockhash(B+1) != 0`, which means `block.number >= B+2`. No wrapper contract, bundle
  or batch can do both steps in one block.
- **Read the hash through EIP-2935.** The `BLOCKHASH` opcode covers 256 blocks, which at 0.2 s
  blocks is 51 s: less than a hunter takes to click "Start evaluation". Base has the EIP-2935
  history contract (`0x0000F90827F1C53a10cb7A02335B175320002935`, checked 2026-11-17), which
  returns hashes 8,191 blocks back, about 27 min. Read `blockhash(B+1)` with the opcode when it is
  within 256 blocks and from the history contract otherwise.
- **Seal.** Permissionless `sealSeed(aggId)` stores `blockhash(B+1)` (~30k gas) while it is
  still within the history window. The draw seals first if needed. Once sealed, the window no
  longer matters.
- **Draw.** Permissionless `drawJury(aggId)` from block B+2 on. It must be a pure function of
  the seed and of state as of block B, so who draws, and when, cannot change the result:
  - Remove `block.prevrandao`, `block.timestamp` and `selectionCounter` from selection
    (`ReputationKeeper.sol` ~504 and ~561). Derive the shortlist and every weighted pick from
    the seed. Otherwise the drawer's block re-rolls the draw, and other requests can shift
    `selectionCounter` between the two steps.
  - Checkpoint selection inputs by block number, the `ERC20Votes.getPastVotes` pattern:
    selection score, registration and deregistration, and blocked, locked or frozen status. The
    draw reads the values at B. Without this, whoever draws can wait until another round's
    reputation update or a registry change shifts the weights, then draw on a good state.
  - Then dispatch commit requests as today. Start `responseTimeoutSeconds` at the draw, not at
    the request.
- **Trigger reward: 2 × `eff`**, the per-arbiter fee the escrow is sized on. No separate gas
  reimbursement.
  - `maxTotalFee = eff * (K + B*P + 2 + 1)`, which is 15 × `eff` with the default 6/3/2. The 1 is
    the `promote` reward (adopted 2026-11-18, below).
  - For the first **30 s** after the commit (by `block.timestamp`, not a block count; Base
    blocks are 0.2 s, on mainnet since 2026-11-05, so 30 s is about 150 blocks), only the
    requester's draw earns the reward, credited back to the requester. After that, whoever draws is credited the reward in `ethOwed`. Anyone may draw
    earlier without the reward; the result is the same.
  - For now the hunter draws (bounty site, agent skill). Keepers, Chainlink Automation or
    market bots can take over later with no contract change.
- **Beacon flag (per request).** The requester chooses in the commit transaction whether the draw
  also uses hash-chain beacons (item 6's chains, item 13's "4 polled, first 2 used"). The flag is
  fixed at commit: choosing after block B+1 is known would be a free re-roll.
  - **Off:** `seed = keccak256(aggId, blockhash(B+1))`, drawn from B+2 as above.
  - **On:** `blockhash(B+1)` also picks 4 beacons from the registered, unfrozen arbiters, which are
    sent hash-chain calls. The draw waits for the first 2 valid values and uses
    `seed = keccak256(aggId, blockhash(B+1), v1, v2)`. The prepay adds 2 beacon fees
    (`maxTotalFee = eff * (K + B*P + 2 + 1 + 2)`); the 2 replying beacons are paid.
  - **Deadline.** If fewer than 2 values arrive by an owner-set deadline (for example 120 s, which
    needs the EIP-2935 window, not `BLOCKHASH`'s 51 s), the round ends with no result: the hunter
    may re-run (item 12) but gets no refund, which would be a free re-roll. 3 or 4 colluding
    beacons can force this by withholding.
  - **What it buys and costs.** A bribed sequencer is left about 40 usable seeds instead of 256.
    But a cartel holding beacon seats chooses among 2–6 seeds by when it reveals, in about half of
    all rounds, which helps it both force and block. That only pays for large juries; see item 15
    for which classes set the flag.
  - **Stricter variant (not yet modelled).** Requiring all 4 values, rather than the first 2,
    removes the choice of which values land first. A colluding beacon is then left with a veto:
    withhold, end the round with no result, and force a re-run. That matches the "uninformed
    withholding" condition in the notes below better, at the cost of more rounds with no result.
  - **BountyEscrow** stores the flag per bounty (from its class) and passes it at every start. The
    aggregator needs the beacon stage only for flagged requests; check the bytecode budget (22,032
    of 24,576 bytes today).
- **No expiry before the draw.** A round cannot time out or refund until it is drawn. A
  requester who abandons a bad draw leaves the prepay locked, and anyone can draw it after 30 s
  for the reward, so abandoning buys no re-roll. An honest requester whose client died loses
  nothing.
- **The one exception.** If nobody sealed or drew the round within the history window (8,191
  blocks, about 27 min), the round can never be drawn. A permissionless cancel then sends the prepay to the treasury. It must not refund the
  requester: a refund would be a free re-roll.
- **Lessons from the v2 example contracts** (reviewed 2026-11-18):
  - **A sealed round can become undrawable.** A selected arbiter could revert the draw by burning all
    gas in its operator or by returning malformed `owner()` data. Since the seed is fixed, the round
    would then be stuck forever with its prepay. Fixes:
    - Give each call to an arbiter contract a fixed stipend: 250k per request (an honest one needs
      about 125k, or 175k at the largest payload) and 30k for `owner()`.
    - Read `owner()` with a low-level call, so a bad answer skips the slot.
    - Let a sealed round undrawn for a day be cancelled to the treasury.
  - **Check the gas before every tolerated call.** Every call whose failure is tolerated must first
    check that its stipend is really available, and settlement must revert rather than skip the
    keeper call when it is starved. Otherwise a drawer or settler can pick a gas limit that drops the
    last slots, or every score update.
  - **Fewer than K eligible at B: fail the round with a refund.** No jury could be drawn, so it is no
    re-roll. Never repeat slots: one arbiter would vote and be charged twice.
  - **Fix every reward and fee count in the round at request.** An owner change before the draw
    otherwise breaks the escrow arithmetic, and through the settlement queue blocks every request.
  - **Checkpoint stake eligibility too** (a flag updated when the stake changes). A live stake read
    lets an under-staked arbiter decide, after seeing the seed, whether to top up and re-roll the draw.
  - **Visit the class list in random order, not by a stride (2026-11-19).** The first version walked
    the list from `seed % n` with a fixed coprime stride. Class lists are append-only, so a cartel
    that registers back to back stays one block, and the strides 1 and n − 1 walk straight through
    it; the bump to a coprime stride also made n − 1 six times as likely as other strides. For a 15%
    cartel (45 of 300) in one block, P(≥ 34 of the 60 shortlisted) was about 3 × 10⁻³ per round
    against 3 × 10⁻¹⁹ for a random sample, and P(≥ 20) about 1% against 4 × 10⁻⁵.
    - The walk now draws random positions without repeats: eight 32-bit draws per keccak, each mod
      n, with a memory bitmap of visited positions (n / 256 words). After 2 × min(n, `maxScan`)
      draws it finishes with a sweep of the unvisited positions from a random start, so its cost is
      bounded and every entry can still be reached (`scansAll` still holds). `pickBeacons` uses the
      same walk.
    - Cost: about 270 gas per visited position against 195 for the stride, the same at 300 or
      300,000 arbiters (a seed-keyed Feistel shuffle, also tried, cost 900–2,400). Selection stays
      2.9M at K = 50.
    - `keeper.rules.test.js` checks a 10-of-40 block against the hypergeometric tails (the stride
      walk put 51 of 1,000 seeds in them; the random walk 5, against 8.4 expected) and that the walk
      reaches every entry.
- **Promotion (item 14's M+ / T+) has the same withholding problem** as the draw. The promotion seed
  is `blockhash(C+1)`, so whoever can call `promote` sees the draw first. If only the requester
  calls it, the requester can abort a draw it dislikes and pay only the base fees, which re-rolls
  promotion. The v2 example:
  - **Pays `promote`'s caller 1 × `eff`**, so third parties call it and it can't be withheld.
    `maxTotalFee` becomes `eff * (K + B*P + 2 + 1)`, plus 2 with beacons. Adopted (owner,
    2026-11-18); item 15's costs include it.
  - **Sends a round that closed but was never promoted to the treasury.** The unspent prepay is not
    refunded.
  - **Gives promoted arbiters 120 s to reveal after `promote`**, extending the deadline if needed.
    Otherwise calling `promote` late (or a colluder sending the M+-th commit late) leaves no time
    to reveal, and the round fails with every honest promoted arbiter charged −500.

- **Beacon flag as implemented (2026-11-18).** `JuryBeacons` is a separate contract, to keep the
  aggregator under the 24,576-byte limit (24,076 bytes). Decisions the design left open:
  - **Everything as of B.** The keeper picks the 4 beacons from the class's state as of B. An
    independent review found that the first version, which skipped arbiters whose chain had moved
    since B, let whoever started the stage steer it. Health calls from another round move honest
    heads but not the cartel's, and pushing out enough candidates bought a refund. Now nothing after
    B changes the pick or the values.
  - **A beacon call is a health call (2026-11-19).** The beacon answers it like any arbiter, with its
    next chain value, which the keeper verifies. Its beacon value is its first value revealed after
    block B+1 (`revealAfter`): normally its answer to the beacon call, or its answer to an earlier
    call if it answered one after B+1.
    - So the value was fixed by the end of B+1, and a later rotation reveals it first, so it cannot
      choose the value. Anchoring at B+1 rather than B keeps an honest answer included in B+1 from
      giving its value to that block's builder.
    - A beacon can't answer at the keeper and keep its value from JuryBeacons any more. But it can
      still answer just after the 120 s deadline, so withholding costs about a minute of freeze.
    - There is no separate submission, so the node needs no beacon-specific code.
    - Head entries are never overwritten and record the block and time of each reveal. A rotation
      writes the revealed value, then the new head.
  - **Who may be a beacon:** registered, and not paused, banned, exiting, under-staked, blocked or
    frozen at B. Only the arbiter (operator owner or authorized sender) can answer, so no relayer
    chooses which values arrive first.
  - **Order:** the first 2 reveals by block are used, with ties going to the lower beacon index, and
    they are mixed in beacon-index order. Arrival decides which values are used but not their order,
    which halves a cartel's choices. `result` reads only completed blocks, so transaction order within
    a block cannot change it, and a ready result is final.
  - **Starting the stage:** the first `drawJury` seals and starts it, unrewarded. The second draws and
    earns the reward, with the requester's 30 s priority counted from the quorum.
  - **Missed quorum:** a draw after the 120 s deadline fails the round. The answering beacon is paid
    and the rest goes to the treasury. If fewer than 2 candidates exist at B, the round is refunded
    (pool shortage).
  - **Payment:** each used beacon's operator owner is read with a 30k stipend at the draw. An owner that
    cannot be read goes unpaid, and the draw goes ahead.
  - **Cost:** about 0.39M gas to start. A beacon answer is an ordinary health answer (123k). Jumbo is
    about $0.57 a round in gas with beacons, $0.56 without.
  - **Withholding is cheap** (second review, 2026-11-19). A beacon that answers just after the deadline
    is frozen only from the 60 s call deadline until then, with no score change. With the default
    2 of 4, a cartel needs 3 seats to force a no-result round; with all 4 required, 1. The option is
    −400 timeliness for a beacon whose value was not in when the stage missed its quorum (deferred).
  - **Other fixes from the second review:**
    - A jury shortage after the beacon stage is refunded only if selection walks the whole class list
      (`scansAll`). Otherwise the outcome depended on the seed, and a beacon's timing could buy a
      refunded re-roll, so it goes to the treasury.
    - `completeExit` refuses while a health call is pending: exit and re-registration could drop a
      beacon call unanswered.
    - The stage picks at least the round's fixed quorum when the owner has lowered `polled`.
    - The owner() stipend check counts the cold-account cost.
    - Swapping the beacon contract mid-stage remains an owner constraint (documented).
- **Other fixes from the 2026-11-18 review** (all with tests):
  - A requester could skip `closeCommits` (with one colluding juror not committing) for a refund. A
    round with M commits that was never promoted now sends its prepay to the treasury.
  - `owner()` return data is no longer copied: a 64 KB answer made every later slot pay for memory
    (about 10 such jurors put Jumbo's draw over the cap).
  - The settlement-queue walk counts already-settled entries, so ~2,900 holes can no longer make
    every request run out of gas.
  - A close in the deadline's last second extends the deadline by 30 s so `promote` can still run.
  - Credit no longer pays for what `msg.value` covers, so the escrow is exactly `maxTotalFee`.
  - Only an arbiter's owner can top up its stake.

### Expected payoff
At the risk model's defaults (300 eligible arbiters, 3% colluders, SD 3) with a $0.50 base fee:
- Requester prediction is gone. The limit becomes the blind re-submit bound, **~$400** (the
  ideal-RNG row; $374–420 across seeds), up from ~$4.50. At today's $0.046 fee: $1.51 → ~$37.
- A bribed sequencer can still grind `blockhash(B+1)` by reordering or including transactions.
  The builder rows are ~$1,150 to $1,200, above the re-submit bound, so the sequencer does not
  bind at these parameters.
- **Rerun 2026-11-17** with Base's 0.2 s blocks and the measured latencies: these figures are
  unchanged beyond Monte Carlo noise. The design never counts blocks except for the hash window,
  and it uses the timestamp for the 30 s reward window.

### Why it's deferred
It adds a new round stage to the aggregator, checkpointed keeper state, a selection rewrite and a
new `maxTotalFee`. That means a redeploy of both contracts, plus bounty-program, site and agent
updates for the second transaction.

### Notes / related
- **Bounty program.** The aggregator's requester is the submission's `EvaluationWallet` clone.
  For the hunter to recoup the reward, the draw must go through BountyEscrow and the wallet, as
  a passthrough like `startEvaluation`. The credit then returns with `refundLeftoverEth` to
  `Submission.funder`. The submission stays `PendingVerdikta` until drawn, and
  `failTimedOutSubmission` must not refund an undrawn round. Site: after the submit
  transaction confirms, wait for block B+2 and prompt "Start evaluation". Agent skill, API docs
  and `nextAction`: add the draw step.
- **Reward economics.** At today's fee, 2 × 0.00002 ETH ≈ $0.09, against ~3.1M gas ≈ $0.04 at
  0.006 gwei. If gas spikes more than about 2×, third parties stop drawing until it falls. That
  is acceptable because rounds do not expire. Draw gas grows with the registry (item 2), so
  measure it at 300 arbiters.
- **Item 6.** This replaces item 6 as the near-term fix. Beacons remain an optional hardening step
  against the sequencer (the beacon flag above), but only where withholding is uninformed: every
  assigned beacon must reveal, with values due before the deciding entropy exists. Alternatives are a pinned future
  drand round or threshold BLS signatures from an arbiter committee. First-responder beacons as
  written in item 6 lower the limit in the model.
- **Item 7** gets its liveness calls from item 6's hash-chain requests. If item 6 waits, item 7
  needs a different liveness call.
- **Item 8.** With a fee floor, size the reward on the amount the escrow uses,
  `max(effMaxFee, minFee)`. Change the `maxTotalFee` signature once if both land together.
- **EIP-2935 is live on Base** (checked 2026-11-17). Its 8,191-block window is about 27 min at
  0.2 s blocks. Without it the 256-block `BLOCKHASH` window (51 s) would make the seal a race the
  hunter's site could easily lose, and a lost seal sends the prepay to the treasury.
- **Risk model.** `scripts/selection_randomness_risk.py` models this design as scenario S3
  (the sequencer can grind B+1). Its block timing (`block_time_s` = 0.2) and chain facts are in its
  section N8.

---

## 10. True best-cluster selection instead of greedy closest-pair seeding

**Status:** not started (design discussed 2026-11-07)
**Scope:** `AggregatorLib.sol` (`findBestCluster`). The aggregator links the library, so it
needs a redeploy.

### Problem
`findBestCluster` seeds the cluster with the closest pair, then repeatedly adds the response with
the smallest summed distance to the current members until it has P. For P = 2 that is the exact
best pair. For P >= 3 it is not. Two colluders that report identical vectors are always the
closest pair (distance 0), so they always seed the cluster, and the members added are the honest
responses nearest them. By reporting an extreme score they pull the cluster mean. Example: with
P = 3, two colluders at 100 and honest scores near 80 give (100 + 100 + 80) / 3 = 93.3.

So under greedy seeding, colluders need only about P/2 of the cluster, not P. At a 10-point gap
below the threshold, k colluders at 100 pass when k·100 + (P − k)·80 >= 90·P. Raising P with
greedy clustering can even make things worse. P = 3 or 4 still needs only 2 colluders, but polls
more arbiters, so 2 colluders turn up more often.

### Idea
Pick the P-member subset of the counted responses with the smallest total pairwise distance (sum
of squared distances over every pair in the subset).
- **Distance matrix.** Compute the n × n distances once (n(n−1)/2 `calculateDistance` calls) and
  score subsets from the matrix.
- **Exact enumeration.** C(n, P) subsets, each summing P(P−1)/2 matrix entries. With the
  recommended n = 2P − 1 that is 10 subsets for P = 3, 35 for P = 4, 126 for P = 5 and 462 for
  P = 6.
- **Cheaper alternative if gas matters at larger P.** For each response, take it plus its P − 1
  nearest, score that group, and keep the best (O(n² log n)). It is not always the exact optimum.
  But with an honest majority (at least P honest responses counted), a group centred on an honest
  response contains only honest responses, so colluders still need P.
- **Deterministic tie-break:** the first subset in reveal order, as the closest-pair scan does
  today.
- **P = 2 is unchanged.** The best pair is the closest pair, so the current 6/4/3/2 config
  behaves exactly as now.
- With true clustering, P colluders among the 2P − 1 counted responses always win. P − 1 can still
  win sometimes: they report just above the threshold, and when the honest responses happen to be
  spread out, the colluders plus the highest honest response form the tightest group. In the risk
  model (P = 3, N = 5, nominal 80, threshold 90, SD 3) two colluders win about 8% of the rounds
  that poll them, and those rounds dominate the risk at P = 3. Item 11's Q-of-N rule removes this:
  with Q = P, colluders need P scores at or above the threshold.

### Recommended configs
`setConfig(K, M, N, P, timeout)` with N = 2P − 1 counted, M = 2P reveal requests and K = 2P + 2
commits polled, a buffer of 2. These are owner-settable with no redeploy, for example
`setConfig(8, 6, 5, 3, 300)`. The existing checks (K >= M >= N >= P >= 2) already allow them.
K must fit within the selection shortlist (`shortlist_size` 20), and the class needs at least K
eligible arbiters.

### Expected payoff
Estimated from the risk model's assumptions (300 eligible arbiters, nominal 80, threshold 90, SD 3,
the item 9 two-phase request, a $1,000 sequencer bribe), with the cluster mean as the pass rule:
- P = 3, K = 8, first 2 of 4 beacons, $5 base fee: about **$33K** per decision at 3% colluders,
  against about $4.2K with greedy clustering. At 5% colluders about $9K; at 10% about $1.4K.
- P = 5, K = 12, today's $0.05 fee, no beacons: about $15K at 3% colluders.
- A larger P also tightens the honest cluster (the mean of P values), so pure spam gets harder.

Earlier versions of this item quoted about $90K, $17K and $2.1K for the first config and about
$300K for the second. Those figures are for **item 11's Q-of-N rule** with Q = P (re-computed
2026-11-10: $88K, $17K and $1.9K; $245K), not for the cluster mean. Under the cluster mean the
P − 1 colluder case above sets the limit. Under Q-of-N the cluster decides only the bonus, so the
larger gain comes from item 11. True clustering still matters for consumers that use the cluster
mean and for who earns the bonus.

### Why it's deferred
It is a library change with an aggregator redeploy and new tests. A larger P also raises the
per-round cost (`fee × (K + B×P)`) and latency: the round waits for the (2P)-th commit and the
(2P − 1)-th reveal.

### Notes / related
- **Gas.** Measure exact enumeration for P = 3 to 6 with realistic likelihood-vector lengths. For
  long vectors the distance matrix dominates.
- **Tests.** For P = 3 to 5, two identical extreme reveals plus an honest majority must select the
  honest group. For P = 2, results must match the current implementation on random inputs.
- `setConfig`'s comment on P >= 2 refers to the closest-pair seed. Keep the bound, since bonus
  accounting assumes at least two winners, and update the comment.
- Bonus credits and reputation updates are per cluster member and do not change.
- `scripts/selection_randomness_risk.py` models true clustering by default (`cluster_rule`), with
  greedy available for comparison.

---

## 11. Per-arbiter score getter, so consumers can apply a Q-of-N threshold

**Status:** not started (design discussed 2026-11-09)
**Scope:** `ReputationAggregator.sol` (one new view) + consumers (`BountyEscrow.sol`). Needs an
aggregator redeploy. No arbiter-node or keeper change, and no new storage.

### Problem
Consumers can read only the cluster mean (`getEvaluation`). A contract cannot test how many
arbiters individually cleared a threshold. The values exist on-chain in `responses[i].likelihoods`,
but `aggregatedEvaluations` is internal and no getter exposes them. Emitting them would not help,
because a contract cannot read events.

### Idea
Add a view that returns every counted arbiter's score for one outcome, in reveal order:

    function getOutcomeScores(bytes32 aggId, uint256 outcome)
        external view returns (uint256[] memory scores, bool valid)
    {
        AggregatedEvaluation storage agg = aggregatedEvaluations[aggId];
        if (!agg.isComplete || agg.failed || outcome >= agg.aggregatedLikelihoods.length)
            return (new uint256[](0), false);

        uint256 n = agg.responses.length;
        scores = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256[] storage v = agg.responses[i].likelihoods;
            if (outcome < v.length) scores[i] = v[outcome];   // short reveal stays 0
        }
        valid = true;
    }

- **Caller picks the outcome.** A "top outcome" return would add tie-breaking, let the cluster
  choose which column comes back, and give the wrong column for thresholds at or below 50.
- **Consumer applies the rule.** It counts scores >= T and passes if the count is >= Q, comparing
  at raw scale before any integer division. "At least Q of N are >= T" is the same as "the Q-th
  highest is >= T"; with Q = P and N = 2P − 1 that is the median.
- **The threshold stays out of the aggregator.** T and Q are applied after finalization and are
  never sent to arbiters, so they add no new value to rally behind.
- **Flag, not revert,** matching `getEvaluation`, so a consumer's settlement cannot get stuck on it.

### Expected payoff
- The scores are the same stored reveals that were hash-checked against the commit and that
  clustering scored and paid on. Arbiters commit before knowing who will cluster, so all N values
  were written under the clustering incentive. Pay is unchanged.
- Colluders need Q of the N counted reveals, whatever the cluster does. Example with greedy
  clustering, N = 5, P = 3, T = 90, Q = 3 and accept scores `[100, 81, 100, 80, 79]` (the 100s
  colluding): the cluster mean is 93.7 and passes; the count is 2 and fails.
- Measured gas for an on-chain read plus the threshold count (test harness with the same `Response`
  layout and compiler settings, 4-score vectors): N = 3, ~26k; N = 12, ~72k (about $0.001 at
  0.006 gwei and $2,300/ETH); N = 30, ~165k. About 10.5k fixed plus 5k per arbiter. The outcome
  index and vector length do not change it. Off-chain reads via `eth_call` are free. The final
  reveal pays nothing extra.

### Design targets (set 2026-11-10)
Q, N and the fee are chosen to meet all three:
- **Keep out work scored 80 or below.** Forcing a pass for a submission whose honest arbiters
  typically answer 80 must cost an attacker more than the value at stake. The target is **$100K**
  per decision.
- **T = 90**, the explicit threshold each counted score is compared against.
- **Accept work scored 95 at least 99.9% of the time** when there is no attack.

These are the defaults of `python3 scripts/selection_randomness_risk.py --config-search` (`--true 80`,
`--threshold 90`, `--good-true 95`, `--min-good 0.999`, `--target 100000`). Its cheapest results
at 3% colluders, SD 3, with the item 9 two-phase request, no beacons and a $1,000 sequencer bribe:

| K/M/N | Q | Fee each | Hunter cost/round | Re-submit limit | Sequencer limit | Good pass |
|---|---|---|---|---|---|---|
| 18/13/9 | 6 | $0.05 (today's) | $1.25 | $716K | $2.5M | 99.90% |
| 17/12/8 | 5 | $0.11 to $0.16 | ~$3.80 | $100K | $110K | 99.94% |
| 15/11/7 | 4 | ~$2 | ~$47 | $100K | $9K (fails) | 99.91% |

- P only sets who earns the bonus here, so P = 2 is cheapest. A larger P costs more bonus.
- No cluster-mean config meets the 99.9% target: the best reaches 97.7%, and P = 5 reaches 89.6%.
- K = 17 or 18 must fit the selection shortlist (`shortlist_size` 20), and the class needs at least
  K eligible arbiters.
- The 99.9% assumes the SD 3 noise target. Today's measured noise is heavy-tailed (normal-SD
  equivalent 7.1), so recheck with `--sigma-within` once arbiter noise is re-measured.
- Q = 6 of 9 means 4 counted colluders can block a pass. The "attacked" column (about 99%) is a
  good submission's pass rate while colluders block whenever they can.

### Why it's deferred
It needs an aggregator redeploy, plus a BountyEscrow change to use it. The current build is 22,032
of 24,576 bytes, so it fits, but it shares the remaining 2,544 bytes with the other items here.

### Notes / related
- **Today's config gains nothing.** At N = 3, P = 2, Q = 2, two colluders win under either rule. It
  needs a larger config (see item 10's recommended ones).
- **Overlap with item 10.** True clustering also fixes the example above, and with Q = P colluders
  need P either way. This item is the cheaper route (no subset enumeration), and it lets a consumer
  set Q above P for high-stakes decisions without changing the aggregator config. A higher Q also
  raises false rejections and lets N − Q + 1 colluders block a pass.
- **Non-cluster values now count.** Today an out-of-cluster report has no effect on the result;
  under Q-of-N it does. That is what makes colluders need Q, but it also gives honest noise more
  weight, so Q and T need calibrating against measured arbiter noise. Add this rule to
  `scripts/selection_randomness_risk.py` to compare it with the cluster mean.
- **Cluster membership is not stored** (`cluster` is memory-only and `BonusPayment` has no `aggId`).
  A rule over all N does not need it. A cluster-based rule would need a bitmap, ~22k gas on the
  final reveal.
- **Inactive at finalization.** `_processPollSlot` leaves such an arbiter out of the mean and pays no
  bonus, but its reveal still appears in this column. Leave it in and document it: the value was
  still bound by the commit, and the case should be rare.
- **Scope of the secrecy.** Withholding T stops honest arbiters anchoring on it, but colluders do not
  need it: they can report 100 under a per-arbiter rule.
- A successful round always has exactly N reveals (`finalizeEvaluationTimeout` fails any round short
  of N), so Q can be absolute or a fraction of N.
- Update `test/aggregatorEth.test.js`, `docs/contracts/reputation-aggregator.md` and the consumer
  examples under `docs/examples/`.

---

## 12. Bounty-side decision rules: Q-of-N pass, bond forfeited only on a hard fail, re-run on block

**Status:** not started (design discussed 2026-11-11). Sized for the $100K bounty in item 13.
**Scope:** bounty program (`BountyEscrow.sol`, `EvaluationWallet.sol`, site, agent skill and docs).
Depends on item 11 (`getOutcomeScores`). No aggregator change beyond item 11; the aggregator
config (K/M/N/P) and the existing race rules (first M commits, first N reveals) stay as they are.

### Problem
A blocking cartel and a forcing cartel pull the same lever in opposite directions. With one
pass/fail line, every config that is hard to force is easy to block, and the reverse. Holding
good work at a 90% pass rate while colluders block whenever they can is what forces K up in the
risk model. Today a block is also costly for an honest hunter: a failed or dead round ends the
submission (`finalizeSubmission` marks it `Failed`; `failTimedOutSubmission` does the same for a
round with no result). The hunter loses their place in the payout order, and a copy of their work
submitted later can win (the residual exposure noted at `_hasEarlierPendingByOther`).

### Idea
Read each counted arbiter's score with `getOutcomeScores(aggId, ACCEPT)` and sort every round into
one of four outcomes, using three per-bounty parameters set by the creator: the threshold T (the
existing `threshold`), the pass quota Q and the forfeit line R (R <= Q):

| Outcome | Condition | Result |
|---|---|---|
| Pass | at least Q of the N scores >= T | paid (subject to payout priority) |
| Soft fail | R to Q - 1 scores >= T | hunter may re-run; keeps place and bond |
| No result | round failed to finish: beacon quorum missed (item 6 / 9), fewer than M commits, fewer than N reveals | hunter may re-run; keeps place and bond |
| Hard fail | fewer than R scores >= T | bond forfeited to the creator; submission ends |

- **Bond.** The hunter posts a bond with the prepay at start. It is returned on a pass and on
  any exit that is not a hard fail, and forfeited to the creator on a hard fail. This replaces
  item 8's "deposit forfeited on failure", which would cost honest hunters their deposit
  whenever a cartel blocks them.
- **Why R sits below Q.** To make an honest hunter forfeit, a cartel must push the count below R:
  good work (honest score ~95) gets >= T from almost every honest arbiter, so that takes about
  N - R + 1 counted colluders. Bad work (honest score ~80) almost never gets >= T from honest
  arbiters, so avoiding forfeit takes about R counted colluders, and attackers lose the bond on
  nearly every failed attempt. With R = Q every block would also cost the honest hunter the bond.
- **Re-run.** A soft fail or no result moves the submission to a new state (e.g.
  `AwaitingRerun`) instead of `Failed`. The hunter re-runs it for a fresh prepay; the same
  `EvaluationWallet` makes a new request, and the new jury is drawn from a fresh seed. The
  submission keeps its index, so it keeps payout priority (`_hasEarlierPendingByOther` and the
  pending list must treat `AwaitingRerun` as still in evaluation).
- **Re-runs are capped** at 6 rounds per submission, the first plus 5 re-runs (owner, 2026-11-18;
  item 15 shows why 6 rather than 5), and must start within a re-run window
  (e.g. a few hours, and before `submissionDeadline`). Otherwise a submission that soft-fails or
  is blocked can hold the head of the queue indefinitely, and every later passing submission's
  payout waits behind it. When the cap or the window runs out, the submission ends as `Failed`
  and the bond is returned (the last outcome was not a hard fail).
- **Both blocking routes are covered.** Under race counting a cartel blocks either by
  withholding (the round does not finish) or by voting low (the round finishes and fails). If
  only unfinished rounds could re-run, the cartel would vote low instead, so soft fails must
  re-run too.
- **Honest noise is covered too.** A good submission that falls short through arbiter noise
  usually lands in the soft-fail band, so it re-runs rather than failing. A single round then
  only needs to pass good work most of the time (~90%), with the final false-negative rate set by
  the hard-fail rate (well under 1%). That, and relaxing the blocked pass rate to ~50%, is what
  lowers K.

### Expected payoff
From `scripts/selection_randomness_risk.py`-style exact calculations (300 eligible arbiters, SD 3,
nominal 80, T = 90, good work 95, V = $100K, $1,000 sequencer bribe, colluders always win the
commit/reveal races, per-round good pass >= 90%, good-work hard fail <= 1% with or without a
blocking cartel, blocked pass per round >= 50%, fee $0.046):

| Colluders | Seed | K/M/N | Q | R | Bond | Good pass per round | Pass per round while blocked | Bad work keeps bond | Sequencer limit | Fees per round |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | two-phase, no beacons | 12/10/8 | 7 | 4 | $2 | 91.8% | 51.8% | 4.6% | $139K | $0.92 |
| 10% | two-phase, no beacons | 16/13/10 | 8 | 5 | $2 | 98.0% | 67.2% | 2.1% | $133K | $1.13 |
| 10% | + first 2 of 4 beacons | 16/13/10 | 7 | 5 | $40 | 98.9% | 76.9% | 2.5% | $164K | $1.23 |
| 20% | two-phase, no beacons | 44/33/30 | 20 | 14 | $1 | 91.9% | 56.5% | 6.3% | $151K | $2.63 |
| 20% | + first 2 of 4 beacons | 50/37/33 | 21 | 15 | $11 | 96.4% | 54.8% | 8.4% | $216K | $3.05 |

- **These rows are optimistic (found 2026-11-12).** They model only one way to sink a round:
  colluders not committing, so fewer than M commits arrive. A cartel can also commit fast and then
  never reveal. Only the first M committers get reveal requests (`_dispatchRevealRequests`), so
  once more than M − N of them stay silent the round has fewer than N reveals and fails. Configs
  with a small M − N gap (12/10/8, 16/13/10) are much easier to block than the table shows. Item 13
  re-sizes with both routes (the cartel picks the worse split).
- At 20% colluders the same targets without these rules (blocked pass >= 90%, good pass >= 99% per
  round, cluster-mean or Q-of-N pass) need K of about 90. The rules roughly halve it, but K still
  exceeds the 20-arbiter shortlist (`shortlist_size`). At 10% colluders K = 12 to 16 fits today's
  shortlist.
- Under race counting the first-2-of-4 beacons do not lower K here: their silencing (~4%) only
  costs a re-run, but colluding beacons still give the cartel a choice of seeds.
- "Bad work keeps bond" is the chance per round that a bad submission soft-fails or gets no
  result, i.e. keeps its bond and its place. It is the queue-squatting rate (see below).
- **Bond rule of thumb:** bond ≈ V × (bad-work pass rate per round) ÷ (bad-work hard-fail
  rate). The re-run rule does not change the attacker's economics beyond that: a bad submission
  that draws R or more colluders soft-fails and keeps its bond, which the bond size already
  accounts for.
- **Cost to honest hunters:** about 1 / (blocked pass rate) rounds while a cartel blocks every
  round (~2 rounds at 50%), each costing one prepay. Without an attack, ~1 / (good pass rate).
- **Queue squatting:** a cartel-backed bad submission keeps its bond and its place at the
  "bad work kept bond" rate per round. Prefer a higher R, and keep the re-run cap low.

### Why it's deferred
It needs item 11 (an aggregator redeploy) and a BountyEscrow release with new per-bounty
parameters (Q, R, bond), a new submission state and re-run entrypoint, and site / agent-skill
changes. The sizing above also assumes the two-phase request (item 9).

### Notes / related
- **Alternatives considered:** a hunter-only appeal to a second, larger jury, and a two-sided
  appeal (the creator or anyone can challenge a pass). Both also split the blocking requirement
  across rounds. Re-running the same config is simpler: one config, no challenge window, no
  watcher.
- **Q and R are applied by the consumer, never sent to arbiters**, like T in item 11.
- **Per-bounty parameters.** Add `quota` (Q), `forfeitLine` (R) and `bond` to `CreateParams` /
  `Bounty`, next to `threshold`. Validate R <= Q at creation, and Q <= N at each start (N from
  the live aggregator config; reject the start otherwise).
- **`_requireNoPassingSubmission` and `finalizeSubmission`** switch from the cluster-mean
  `_scoreVector` test to the Q-of-N count.
- **Re-run funding.** Each re-run needs a fresh `maxTotalFee` prepay; the leftover from the
  previous round is refunded as today (`_refundLeftoverEth`). With item 3 (`refundTo`), the
  per-submission wallet could be dropped.
- **Concurrency.** `AwaitingRerun` submissions should count against `MAX_ACTIVE_EVALUATIONS`
  only while a round is actually in flight, or a blocked bounty fills its slots.
- **Creator-approval windows** (`PendingCreatorApproval`): a re-run should not reopen the
  window; it goes straight to arbitration.
- Update the BountyEscrow tests, the bounty site, the agent skill and the bounty docs.

---

## 13. Option A: configuration for a $100K bounty (50/38/27, Q = 17, R = 12)

**Status:** chosen as the nominal config (2026-11-12). Not started. The cluster size P and the
clustering rule are still open; they will be decided with reputation management (see below).
**Scope:** brings together items 6, 7, 8, 9, 11 and 12, and adds some new work: a config for each
aggregator, a larger shortlist, gas limits at K = 50, and an update to the risk script. Needs a
redeploy of the aggregator and keeper, plus a BountyEscrow release.

### Targets and assumptions
- **The bounty.** V = $100K. Bad work scores 80 on average, the threshold T is 90 and good work
  scores 95. Arbiter noise is SD 3.
- **The attacker.** 15% of 300 eligible arbiters collude, and colluders always win the commit and
  reveal races. A sequencer can be bribed for $1,000 per block.
- **Honest arbiters.** 5% of polled honest arbiters do not show (they miss the commit or the
  reveal).
- **Randomness.** Item 9's two-phase request, plus item 6's hash-chain beacons: 4 polled, the first
  2 to respond are used. The sequencer can grind 256 versions of block B+1; with the beacons that
  leaves it about 40 usable seeds.
- **Re-runs.** Item 12's rules, with at most 5 rounds per submission (item 12's cap is now 6; item
  15's figures use 6).
- **Requirements:**
  - Good work is eventually paid at least 99% of the time, even when a cartel blocks every round.
  - Each round passes good work at least 70% of the time while the cartel blocks.
  - Forcing a pass on bad work costs more than V, whether by repeated submissions or through the
    sequencer.
- **How the cartel blocks.** It can do either of two things:
  - not commit, so fewer than M commits arrive;
  - commit fast and then never reveal, so fewer than N of the first M committers reveal.

  The model lets the cartel use the worse split in each round (see the caveat added to item 12).

### Configuration
| Parameter | Value | Set where |
|---|---|---|
| K / M / N | 50 / 38 / 27 | `setConfig` on a high-value aggregator (see notes) |
| P, B | P = 17, B = 3 nominal (bonus ≈ base); P = 2 until clustering is decided | `setConfig`, `setBonusMultiplier` |
| Q / R / T | 17 / 12 / 90 | per bounty (item 12) |
| Bond | $250 (≈ 0.109 ETH at $2,287) | per bounty (item 12) |
| Fee floor | $0.25 per arbiter (≈ 0.000109 ETH) | per bounty, `minOracleFee` (item 8) |
| Rounds per submission | at most 5 | per bounty or a constant (item 12) |
| Shortlist | `shortlistSize` = 60 (minimum 50 = K; see below) | `setShortlistSize` on the keeper |
| Beacons | 4 polled, first 2 used | item 6 |

- **Why 50/38/27.** This is the smallest K that meets every target; feasible configs run from
  K = 49 to 60.
  - The M − N gap of 11 limits commit-then-silent blocking.
  - The K − M gap of 12 limits blocking by not committing.
- **Why R = 12.** It sits well below Q, so a cartel that blocks rarely pushes good work to a hard
  fail. Bad work almost never reaches 12 scores at or above 90, so the bond is lost on most failed
  attempts.
- **Why a $250 bond.** The forcing target needs only about $16 at a $0.25 fee, or about $28 at
  $0.046. $250 raises the repeated-submission limit to about $860K and costs an honest hunter
  about $1.22 in expected losses while a cartel blocks.

### Expected results (exact model, cross-checked by Monte Carlo)
| Metric | Value |
|---|---|
| Good work, no attack: pass per round | 99.95% (the shortfall is the beacon quorum) |
| Good work while blocked: pass per round | 73.3% |
| Good work while blocked: hard fail per round | 0.36% |
| Good work while blocked: never paid (hard fail 0.49% + out of rounds 0.13%) | 0.61% |
| Bad work: pass per round, best cartel play | 0.024% |
| Bad work: keeps its bond per round (queue-squatting rate) | 22.6% |
| Repeated-submission limit (fee $0.25, bond $250) | $857K |
| Sequencer limit | $162K; the fee and bond do not move it |

Cost to a hunter. "Per round" is the cost of one round. The last two columns are the expected
total over all rounds a submission needs, including expected bond loss. Gas is about $0.39 per
round at 0.006 gwei.

| P, B | Fee | Per round | Escrow prepay | Total, no attack | Total, cartel blocks |
|---|---|---|---|---|---|
| 2, 3 | $0.25 | $14.89 | $15.00 | $14.89 | $21.07 |
| 2, 3 | $0.046 | $3.05 | $2.76 | $3.05 | $5.29 |
| 17, 3 | $0.25 | $26.14 | $26.25 | $26.14 | $35.88 |
| 17, 3 | $0.046 | $5.12 | $4.83 | $5.12 | $8.02 |

- **What the prepay covers.** It is `fee × (K + B×P + 2 + beacons)`: base fees, bonus, item 9's
  trigger reward and 2 paid beacon values. The unspent part is refunded.
- **P affects only costs.** Under the Q-of-N rule P decides only who earns the bonus. It leaves
  the pass, blocking and forcing figures unchanged; the repeated-submission limit rises slightly
  with larger P, to about $890K.
- **Sensitivity.** The smallest feasible K moves with each assumption:
  - Arbiter noise: SD 4 needs K 54. SD 5, and today's measured SD 7.1 (normal-SD equivalent),
    cannot be met at K ≤ 60.
  - Honest no-show: 2% needs K 39. 10% cannot be met.
  - Colluder share: 12% needs K 22. At 16%, option C (58/44/31) already fails the forcing
    target, at $81K. 17% and 20% cannot be met.
  - Eligible pool: 60 arbiters need K 29, 80 need 32, 150 need 38, 200 need 43, 1,000 need 52.
  - Rounds per submission: a cap of 3 needs K ≥ 58.
  - Beacons: with no beacons the smallest feasible K is 45. Colluding beacons give the cartel a
    choice of seeds, which costs more in blocking than the beacons save against the sequencer.
    Revisit whether to keep them. But without them a bribed sequencer chooses among ~256 seeds,
    and option A's sequencer limit falls from $162K to about $25K (item 15).
- **Margin.** For more margin over the sequencer, the alternative is 60/46/33 Q = 20 R = 16. It
  costs $17.46 per round at P = 2, $0.25. Its blocked pass is 77.0%, never-paid while blocked
  is 0.63%, and the sequencer limit is $641K. With Q = 21 the sequencer limit is $3.0M.

### Work needed beyond items 6 to 12
- **A config for each aggregator.**
  - `setConfig` applies to the whole aggregator, so K = 50 would apply to every request it
    serves. Run high-value bounties on a separate aggregator deployment with this config, or
    make K/M/N/P a per-request (per-bounty) setting.
  - BountyEscrow must store which aggregator a bounty uses. At each start it must check the live
    K/M/N against the bounty's Q and R (item 12 already checks Q ≤ N).
- **Shortlist.**
  - **Target: `shortlistSize` = 60. Minimum: 50 (= K).** Today's value is 20.
    - **Below 50 it breaks.** `_weightedSelect` picks every shortlisted arbiter once and fills
      the rest of the jury with duplicates.
    - **At exactly 50 it works, with no margin.** Every shortlisted arbiter is picked, so the jury
      is a uniform sample and reputation has no effect on selection.
    - **At 60 there is margin and reputation counts.** The 50 jurors are picked by selection score
      from 60 uniformly shortlisted arbiters, so the keeper's reputation weights can favour
      better arbiters. The margin also leaves room for a later K up to 60 (option D, 60/46/33)
      without another shortlist change.
  - **Re-run at 60 under item 14's rules (2026-11-17): the uniform-jury assumption holds.**
    Option A's figures assume each colluder is picked as often as an honest arbiter. Item 14
    bounds selection weight to 1×–2×, and a mimicking cartel earns the same scores as honest
    arbiters, so with a 60-arbiter shortlist it holds 16% of jury seats against its 15% share
    (20, 60 and 120 all give 15.7–15.9%; see item 14, "Shortlist size"). The targets stand. Under
    today's rules the concern was real: mimic seats reached 28% on the nominal mix.
  - `shortlistSize` is global to the keeper, so this also needs its own keeper or a per-request
    shortlist size.
  - The draw must revert, or BountyEscrow must refuse the start, when fewer than K arbiters are
    eligible. Today `_weightedSelect` fills the remaining slots with duplicates, and that would
    hand colluders extra slots.
- **Registry size.**
  - The model assumes 300 eligible arbiters in the class; 32 are registered today.
  - With fewer eligible arbiters a smaller K suffices, as long as colluders stay at 15%. K cannot
    exceed the eligible count, though.
  - Re-run the search at the real pool size before launch.
- **Arbiter quality gates.**
  - The targets fail at SD ≥ 5 or a 10% no-show rate. Before launch, re-measure arbiter noise
    and no-show for the class used.
  - Item 7's freeze keeps no-show rates down. Consider admitting only arbiters measured at
    SD ≤ 3 to the high-value class.
- **Gas at K = 50.** Measure each of these on Base Sepolia with 300 registered arbiters.
  - **The draw.** Selection over the eligible pool plus 50 commit dispatches and the beacon
    requests. The model scales the K = 6 request (~3.3M gas) linearly, to about 27M. That may
    exceed a block's or a transaction's gas limit (EIP-7825 caps a transaction at 2^24 gas
    where it applies). It would then need item 2's cheaper selection, or a draw split across
    several calls. Measured since (2026-11-19): 13.5–13.8M, so it fits; see item 15's "Jumbo's
    draw size".
  - **The 38th commit.** That arbiter's `fulfill` runs `_dispatchRevealRequests`, which sends
    38 reveal requests, so the arbiter pays for them. If the job's gas limit is too low the
    fulfill reverts, the commit is lost and the round stalls until timeout.
    - Raise the job's gas limit, or move reveal dispatch into a permissionless call with a
      trigger reward, like item 9's draw.
    - A cartel member can grief this: it commits 38th with too little gas.
  - **The 27th reveal.** That `fulfill` finalizes the round: clustering, the keeper's score
    updates for all 50 slots (item 1) and bonus credits. Measure it the same way. Consider
    finalizing in a separate permissionless call.
  - **The consumer.** BountyEscrow's read of `getOutcomeScores` at N = 27 is about 146k gas
    (item 11's fit).
- **Response timeout.** The round waits for the 38th commit and the 27th reveal. Set
  `responseTimeoutSeconds` from measured arbiter latency at that depth, not from the 6/4/3
  config.
- **Risk script.**
  - Move the item 12 / item 13 search into `scripts/selection_randomness_risk.py`. That covers
    the Q/R outcome bands, re-runs with a cap, both blocking routes, beacon and sequencer seed
    choice, bond sizing and colluder counts drawn hypergeometrically from the eligible pool.
  - Add weighted selection: a uniform 60-arbiter shortlist, then K picks by selection score
    without replacement, with a colluder-to-honest weight ratio as an input.
  - Today `broad_config_eval` models only blocking by not committing.
  - Add a `--config 50,38,27,17,12` check that prints the tables above.
- **Bounty UI and docs.**
  - Present option A as the preset for bounties near $100K: fee floor, bond, Q, R and rounds per
    submission.
  - Show the hunter both the expected cost and the expected number of rounds while blocked (about
    1.36).

### Open: P, clustering and reputation (next discussion)
- **Goal for P.** Total bonus should roughly equal total base pay, so P × B ≈ K. P = 17 with
  B = 3 gives 51 against 50. `setConfig` already accepts it (K ≥ M ≥ N ≥ P ≥ 2), and
  `setBonusMultiplier` allows B up to 20.
- **Who collects the bonus.** Colluders who report identical scores near the expected consensus
  always seed the greedy cluster. Their share of bonus slots depends on P and B:

  | P, B | Colluders' share of bonus slots |
  |---|---|
  | 2, 3 | ~100% |
  | 5, 10 | ~97% |
  | 10, 5 | ~73% |
  | 17, 3 | ~44% |
  | 25, 2 | ~30% |

  Their fair share is 15% of counted reveals. They collect this without changing any outcome,
  and with it the cluster reputation gain.
- **Gas.**
  - Greedy `findBestCluster` at N = 27, P = 17 makes about 11,000 `calculateDistance` calls.
  - Computing the 351 pairwise distances once and updating scores incrementally gives the same
    cluster for about 800 calls.
  - Item 10's exact enumeration is out of reach at this size. Its nearest-neighbour variant is
    the alternative.
- **Questions for the reputation-management discussion:**
  - How reputation is earned (cluster membership versus agreement with the Q-of-N outcome).
  - What happens to committed-but-silent arbiters, which are the commit-then-silent blocking
    route.
  - How reputation weights selection from the 60-arbiter shortlist. In particular, how far a
    colluder's selection weight can rise above an honest arbiter's (this sets the colluder share
    used in the model). **Answered by item 14:** weight is at most 2×, and a mimicking cartel
    gets 16% of seats at a 15% share.
  - Which clustering rule and P to adopt.

### Notes / related
- **Lowering K.** Possible change: send reveal requests to late committers as they arrive (the
  current code stops counting commits after the M-th), and count the first N reveals. A promoted
  colluder that stays silent can then be replaced, which weakens the commit-then-silent route and
  should lower K. Model it before committing to the design.
- **Fee figures.** Dollar figures assume ETH at $2,287 and 0.006 gwei. The fee floor and bond are
  set in wei, so re-price them for long-lived bounties (item 8).
- **Source.** Search and tables come from the 2026-11-12 analysis (exact calculator plus Monte
  Carlo). Fold them into the risk script, as listed above, so they can be reproduced.

---

## 14. Reputation v2: two scores (timeliness, quality) with fixed points, plus the liveness freeze

**Status:** design simulated (rules simplified 2026-11-15; no-commit penalty lowered to −400
2026-11-16; promotion rule M+ / T+ 2026-11-17, adopted as the plan 2026-11-18), not started in the
deployed contracts. Implemented in this folder's v2 contracts (which replaced v1 here on 2026-11-18),
updated and reviewed 2026-11-18 (see "v2 example contracts" below).
**Scope:** `ReputationKeeper.sol` (two scores, points, blocks, ban, selection weight, stake burns,
unbonding) and
`ReputationAggregator.sol` (record late reveals, classify each reveal as close / off / far, report
which live arbiters failed to deliver, the M+ / T+ promotion rule). Builds on item 7 (freeze) and
serves item 13. Simulator: `scripts/reputation_sim.py` (presets `mix-v2`, `mix-v2-rnd`; `--rules
simple` is the default).

### Problem
Today's rules are cumulative quality and timeliness points with mild, severe and worsening thresholds.
The simulator shows three weaknesses:
- They reward speed and cluster seeding, so a cartel that only mimics the consensus collects about
  28% of jury seats in the nominal mix (its fair share is 15%).
- They cannot see a commit-then-silent or abstaining blocker, so blocking leaves only 21–55% of good
  work passing in small rounds.
- They are slow on incompetent arbiters, and they charge honest arbiters for losing the commit or
  reveal race.

The rules also have to be easy to explain. Operators (people and agents) are more likely to join,
and anomalies are easier to understand, when the whole rule set fits in two short tables that don't
change with K, M, N or P.

### Idea
Each arbiter has two integer scores, **timeliness** and **quality**, from 0 to 1000. Fixed points per
event, the same for every configuration. Everything uses only what the contracts see (deliveries and
each reveal's distance from the round's median). The contracts don't know how results are used (for
example a bounty's threshold T), so nothing depends on that.

**Table 1: how scores change.** Only arbiters selected for the round are scored. An arbiter frozen by
the liveness check at round end (the round's deadline, not settlement) is not scored, unless it
committed in that round. A commit proves it was up, so freezing cannot be used to escape the −500
for going silent.

| Event in a round | Timeliness | Quality |
|---|---|---|
| Promoted, and its reveal arrived (even late) | **+20** | scored by distance, below |
| … revealed score is **close** to the median (within 1.5 spreads) | | **+20** |
| … revealed score is **off** (1.5–3 spreads) | | **−50** |
| … revealed score is **far** (more than 3 spreads) | | **−200** |
| Promoted, no reveal, round still finished | **−200** | |
| Promoted, no reveal, **round failed** | **−500** | |
| Live, no commit, and the **round failed for lack of commits** | **−400** | |
| Anything else: committing, speed, not being promoted, not being selected | 0 | 0 |

A **spread** is `max(1.48 × MAD, 3 points)`, where MAD is the median absolute deviation of the
round's counted scores. It adapts to how much honest arbiters disagree on a given task. "Live" means
not frozen at round end.

**Table 2: what the scores do.**

| Score state | Effect |
|---|---|
| New arbiter, or after a block | starts at **500**; the maximum is **1000** |
| Any score | selection weight = `1000 + ((1000 − alpha) × quality + alpha × timeliness) / 1000`, so 1000–2000 |
| Either score reaches **0** | **blocked** for 24 h × 2^(earlier blocks); that score restarts at 500 |
| Third block | **banned** (permanent) |
| Block | burns `burnPerBlock` × 2^(earlier blocks) VDKA from the stake (owner-set, **default 0**) |
| Ban | burns the whole remaining stake if `burnOnBan` is on (owner switch, **default off**) |
| 90 days with no block, counted from the end of the last block | one earlier block is **forgiven** (repeats every 90 clean days) |
| A liveness (hash-chain) call unanswered past the deadline | **frozen** until it answers; no points either way (item 7) |

`alpha` (per mille, owner-settable, default 500) weighs timeliness against quality, as in today's
keeper. Scores are clamped to 0–1000.

**Why these rules.**
- **Commits never earn points.** A commit can't be checked unless the arbiter is promoted and reveals
  it, and a fake commit is easy, so credit for committing (or for committing fast) would reward fake
  ones. A missing commit costs points only when the round then failed for lack of commits, which is
  the attack where a cartel blocks by never committing. A fake commit doesn't avoid that: if it is
  promoted it must be revealed and scored.
- **Fake commits don't pay.** For a live arbiter that can't do the work in time in a K=6 / M=5
  round, not committing costs about −23 expected (the round fails for lack of commits about 6% of
  the time). A commit it can't reveal is promoted about 83% of the time and costs −200 in a round
  that still finishes, about −165 expected. Faking would only pay at a no-commit penalty of about
  −2,800.
- **No round-size terms.** No rule mentions K, M, N, P, the slack, or a probability. An honest
  arbiter nets on average about +18 timeliness and +10 quality per round it serves in, whatever the
  configuration. In any finished round, at least half the counted reveals are close and gain points,
  because at least half of them lie within one MAD of the median.
- **Rare bad luck can't block a good arbiter.** An arbiter in good standing survives any single event,
  including one honest coincidence that fails a small round (two transients in a K=6 round). Two
  failed rounds in quick succession block it.
- **Banked credit is limited.** The cap means a cartel member at 1000 must deliver 25 reveals to earn
  back each failed round it causes by staying silent (20 if it caused it by not committing).
- **Offenses decay.** Without decay, three honest blocks spread over years would mean a ban. The
  keeper can apply it lazily at the next block: forgiven = (now − lastBlockEnd) / 90 days. The cost
  is that a cartel member that is blocked at most about once every 90 days is never banned (each
  block still takes it out for 24–96 h). In a one-year run with a silent cartel attacking only when
  it can win, 69% of its members were banned with decay and 84% without. Honest arbiters were not
  banned either way (honest blocks ~0.01 per arbiter-year over two years).
- **Weight can at most double**, so a fast or always-agreeing cartel gains little seat share. Race
  rank is never penalised.
- **The −500 for a failed round is the balance point.** −1000 (block on the first failed round)
  blocks every silent and abstaining cartel, but honest blocks rise to 0.7–1.6 per arbiter-year,
  because one coincidence in a K=6 round is enough. −200 (the same as an ordinary miss) leaves
  abstaining cartels, and silent cartels that attack only when they can win, mostly unblocked
  (4–31%).
- **−400 for a missing commit is the smallest penalty that still works.** It is kept as small as
  possible so that missing a commit costs less than staying silent after one. Sweep of the
  no-commit penalty alone (the silent-reveal penalty stays −500), abstaining cartel, 60 days ×
  4 seeds, first-M and random promotion:

  | No-commit penalty | Abstaining cartel ever blocked | Blocked/banned at day 60 | Good work passes, K=6 |
  |---|---|---|---|
  | −500 | 88–93% | 37–48% | 80–81% |
  | **−400** | **72–82%** | **18–32%** | **77–79%** |
  | −300 | 39–67% | 2–12% | 74–77% |
  | −200 | 12–20% | ~1% | 72–74% |
  | 0 | 0% | 0% | 68–73% |

  The penalty changes nothing measurable for honest arbiters (1–6 honest blocks per ~160
  arbiter-years at every value, no trend), and the silent cartel is blocked 78–94% at every value.
  Below −400 a cartel would switch to never committing, which then costs it little. With no
  penalty, never committing is a free, undetectable way to block.

**Stake and burns.** Every arbiter stakes `STAKE_REQUIREMENT` (100 VDKA) to register. Both burns
start disabled and can be turned on by the owner once real block rates are known.
- **What today's keeper does.** A severe or worsening block lowers `stakeAmount` by
  `slashAmountConfig` (default 0). The tokens stay in the keeper with no way out, so they are lost
  rather than explicitly burned. Selection never checks `stakeAmount`, so an arbiter slashed to 0 is
  still selected. `deregisterOracle` refunds the remaining stake whenever the arbiter isn't locked,
  so an operator watching its score fall can leave before the block.
- **Burns are explicit.** Use the token's burn function, or send to a dead address. Slashed stake
  never goes to the requester, a reporter or a treasury the arbiters can influence: paying anyone
  from slashing creates an incentive to make other arbiters fail.
- **Nothing is burned for freezing.** Being down is not misbehaviour.
- **Full stake to be selected.** An arbiter whose stake is below `STAKE_REQUIREMENT` after a burn is
  not eligible until it tops up. Otherwise a burn that reaches 0 means nothing.
- **Unbonding on exit.** Deregistering starts a delay (e.g. 7 days, owner-set) during which the
  arbiter is not selected but blocks and bans still apply. The stake is refunded only after the
  delay. Deregistering while blocked stays forbidden. This closes the leave-before-punishment route.
- **What burns can and can't do.** They hit only what reputation sees: cartels that fail rounds,
  wrong or lazy models, and honest bad luck (about 0.01–0.3 blocks per arbiter-year in the
  simulator). They never touch a cartel voting plausibly near the threshold, so the bounty limits in
  items 12 and 13 still come from the configuration.
- **Ban burn.** While `burnOnBan` is off, a banned arbiter can get its stake back through unbonding
  and re-register under a new address, so a ban costs it only time and gas. Honest bans essentially
  never happen in the simulator (none in two years, with decay), so turning it on mainly costs broken
  models and cartels.

**Pool shortage.** When no arbiter is eligible (active, within the fee limit, in the requested
class, and not frozen, blocked or banned), `selectOracles` reverts and the request fails. The most
likely cause is a wide outage (an AI provider, a cloud region, Base), which freezes arbiters rather
than blocking them, since frozen arbiters are not scored. A small class or fee band can also run dry
while the overall pool is healthy. Rules:
- **Blocked and banned arbiters are never admitted to fill a jury.** If a shortage reopened blocked
  seats, a cartel could knock out honest arbiters to bring its own blocked members back.
- **Recovery is self-service.** An arbiter unfreezes only by answering a hash-chain call, and those
  calls go out with requests, so if every request reverts nobody unfreezes. The node calls
  `requestHealthCall` (item 7) automatically whenever it is frozen and healthy again. The owner can
  send health calls to all frozen arbiters at once after a wide outage.
- **The keeper exposes the eligible count per class** (a view, optionally per fee limit), so
  requesters such as BountyEscrow and monitoring can see a shortage before submitting.

**Also part of the design.**
- **Promotion rule M+ / T+ (planned; owner, 2026-11-18).** Instead of promoting the first M commits, wait until
  either there are **M+** commits, or **T+** has passed and there are at least M. Then promote M
  drawn at random from all commits received so far. M+ = M + ⌈(K − M) / 2⌉, and T+ is the mean plus
  two SDs of honest commit latency. Answering early then earns nothing. This is the main protection
  small rounds have against forcing. Details and results under "Promotion rule" below.
- **Bonus.** Every round escrows a pool of B × P × fee. The cluster pays it to exactly P members. The
  alternative band rule splits it evenly among the close reveals.

### Expected results (simulator, nominal mix, 60 days, 15% cartel, no consumer feedback)
Nominal mix: 80% 6/5/4/3/3, 16% 8/6/5/4/4, 4% option A (50/38/27/17/17, R = 12). Each range covers
the cartel strategies and both attack modes (only when it can win, and every chance). Single runs, so
differences of a few points are noise. "Random promotion" here and in the colluding-hunter section is
plain random promotion (M at random from the commits within a 2-unit window), the rule that preceded
M+ / T+. The M+ / T+ rule matched it within noise on every attack measure (see "Promotion rule").

| | First-M promotion | Random promotion |
|---|---|---|
| Down arbiters removed before repair | 89–93%, ~0.8 h | 89–93%, ~0.8 h |
| Biased / noisy / lazy model removed (all), median days | 6–12 / 5–8 / 0.9–2.6 | 6–14 / 3–7 / 0.8–2.0 |
| Honest blocks per arbiter-year | 0.0–0.3 | 0.0–0.3 |
| Mimic cartel: seats, cluster bonus, band bonus | 16%, 22%, 19% | 16%, 22%, 19% |
| Silent cartels blocked | 98–100%, median 5–12 d | 80–96%, median 10–15 d |
| Abstain cartels blocked (4 seeds) | 78%, median 13–14 d | 72–82%, median 13–14 d |
| Under-threshold blocking or forcing cartels removed | 0% | 0% |

Pass rates per round when the cartel attacks only when it can win (K=6 / K=8 / option A):

| | First-M promotion | Random promotion |
|---|---|---|
| Good work passes, under-threshold blocking | 78% / 57% / 88% | 92% / 88% / 100% |
| Good work passes, abstain blocking | 77% / 89% / 100% | 81% / 89% / 100% |
| Bad work forced through | 5.8% / 4.8% / 0% | 0.7% / 0% / 0% |

For comparison, today's rules on the same mix: mimic seats 28%, and forcing passes 33% / 17% of bad
work in small rounds.

### Colluding hunter, and the choice of R (2026-11-16)
**Setup.** 300 arbiters, 45 colluding (15%), simple rules, nominal background workload. One hunter
submits bad work (true 80, T = 90) once an hour for 2 days (about 48 submissions) to one bounty class.
The cartel votes exactly 90 on the hunter's submissions only, and behaves honestly everywhere else. It
either forces every time ("always") or only when it has enough seats to win ("win"). 40 seeds per case.
Break-even bounty: the bounty at which wins just pay for the round fees ($5.15 / $6.67 / $31.29 per
submission for K=6 / K=8 / option A) and the bonds lost on hard fails.

**Results with R = 1, random promotion (per 2-day run):**

| Class | Cartel | Passes | Soft fails (bond kept) | Hard fails | Break-even bounty, $25 / $250 bond | Cartel blocked after 2 days |
|---|---|---|---|---|---|---|
| K=6 | always | 0.45 | 24 | 24 | $1.9K / $13.7K | 0.3% |
| K=6 | win | 0.15 | 1 | 47 | $9.5K / $80K | 0.2% |
| K=8 | always | 0.25 | 29 | 18 | $3.1K / $19K | 0.1% |
| K=8 | win | 0 | 2 | 45 | never wins | 0.1% |
| Option A | always | 0 | 0 | 47 | never wins (0 in ~1,900 tries) | 24% |
| Option A | win | 0 | 0 | 49 | never wins | 0.1% |

- **The attack loses money.** Break-even is well above the class limits in item 15. At Small's
  settings ($0.78 per round, $5 bond) the "always" and "win" rows break even at about $350 and
  $1.8K, against Small's ~$100. At Medium's ($5.10 per round, $50 bond) "always" breaks even at
  about $4.6K, against Medium's ~$1K. (Passes, hard fails and 48 submissions from the table.)
- **First-M promotion makes it much cheaper.** Under first-M the hunter wins 2.4 (K=6) and 1.2–1.6
  (K=8) times per run, and break-even falls to about $0.3K / $2.0K (K=6) and $0.5K / $2.8K (K=8).
  This is the main reason to adopt random promotion.
- **Reputation reacts quickly only in option A.** Every forced 90 lands far from an honest median of
  about 80 (−200 quality). The cartel's mean quality fell from 500 to 344 while honest arbiters rose
  to 628, and 13–24% of colluders were blocked by the end of day 2. In small rounds each colluder
  sits in about one hunter round in 2 days, and with 4 counted votes its own 90 moves the median, so
  almost none are blocked.
- **Damage to honest arbiters is negligible.** 1–8 honest reveals per run were scored far in the
  hunter's rounds, and 0.02–0.12% of honest arbiters were blocked.

**Raising R in the small classes was tested and rejected; R = 1 stays.** With R = 1, one colluder
voting 90 turns the hunter's hard fail into a soft fail, so the bond is kept. That is why "always"
shows about 24 soft fails.

| Random promotion | R = 1 | R = 2 | R = 3 |
|---|---|---|---|
| K=6, colluding hunter (always): break-even, $25 / $250 bond | $1.9K / $13.7K | $2.9K / $24K | $3.2K / $27K |
| K=8, colluding hunter (always): break-even, $25 / $250 bond | $3.1K / $19K | $5.0K / $39K | $5.8K / $47K |
| K=6, honest good work, bond lost: no cartel | 0.00% | 0.22% | 1.4% |
| K=6, honest good work, bond lost: low-vote blockers (win / always) | 0.5% / 0.7% | 4.5% / 5.3% | 7.0% / 26% |
| K=8, honest good work, bond lost: no cartel | 0.00% | 0.00% | 0.00% |
| K=8, honest good work, bond lost: low-vote blockers (win / always) | 0.0% / 0.4% | 1.1% / 2.6% | 7.3% / 10% |

The honest rows come from 30-day runs × 4 seeds. For K=8, R = 4 gives the same break-even as R = 3.

- **R never changes the number of wins.** It only removes the bond protection the cartel gives when
  it forces every time. When the cartel forces only when it can win, R barely matters: its votes are
  honest in the other rounds, so those are hard fails anyway.
- **A higher R gives the blocking cartel a new weapon.** Colluders voting just under T already block
  good work. With a higher R they also make honest hunters forfeit their bonds: about 1 in 20 good
  submissions at K=6, R = 2. That moves the cost from the cheating hunter onto honest ones.
- **The gain isn't needed.** Under random promotion the R = 1 break-even is already more than 10× the
  sized maximum bounty. Under first-M, R = 2 only roughly doubles break-even, with honest bond losses
  of 6.3% at K=6.

### Promotion rule: M+ or T+ (2026-11-17)
**Rule.** Promotion happens at the first moment either holds:
1. there are **M+** commits; or
2. **T+** has passed since the commit requests went out, and there are at least **M** commits.

Then M commits are drawn at random from all commits received so far, and reveal requests go to those
M. Commits after promotion are only logged, as today.
- **M+ = M + ⌈(K − M) / 2⌉**, halfway from M to K: 6 for K=6 (all must commit; with M = 5 it can't be
  anything else), 7 for K=8, 44 for option A. Requiring all K is too strict in large rounds, because
  one of 50 jurors is almost always slow or absent, so every round would wait for T+. A smaller M+
  brings back some of the race: a fast cartel is always among the first M+ commits, so it is
  promoted with probability M / M+ instead of M / K.
- **T+ = mean + 2 SDs of honest commit latency.** On mainnet in October–November 2026 that is about
  **155 s** (mean 76 s, SD 39 s; 97% of commits arrive by then), against the 300 s
  `responseTimeoutSeconds`; over all rounds since June it is 201 s (see "Real latency" below). In the
  simulator's model it is about 3.5 median latencies (mean 1.36, SD 1.06), admitting about 96% of
  honest commits where a 2-unit window admits 85%. Real latency is tighter: mean + 2 SDs is 2.3–2.5
  median latencies, because the simulator adds 10% arbiters three times slower.
- **Why it beats a fixed window.** Plain random promotion always waits the whole window. With M+ / T+ a
  round that is complete early promotes early, so T+ can be generous, which is fairer to slower
  honest arbiters, without most rounds waiting for it.

**Results** (nominal mix, 15% cartel attacking only when it can win, 60 days × 4 seeds; times in median
latencies; K=6 / K=8 / option A where split):

| | First-M | Plain random, 2-unit window | M+ / T+, T+ = 3.5 |
|---|---|---|---|
| Promoted at, mean | 1.62 | 2.12 | 2.33 |
| Round finished, median / p90 | 2.73 / 3.96 | 3.30 / 4.12 | 3.60 / 5.12 |
| Honest commits that arrive in time to be drawn | (race) | 85% | 96% |
| Bad work forced through | 4.8% / 2.0% / 0% | 0.4% / 0% / 0% | 0.3% / 0.2% / 0% |
| Good work passes, under-threshold blocking | 77% / 62% / 86% | 94% / 87% / 99% | 94% / 88% / 97% |
| Good work passes, silent blocking | 84% / 71% / 96% | 83% / 76% / 100% | 84% / 78% / 99% |
| Silent cartel blocked, median days | 94%, 11 d | 85%, 17 d | 83%, 13 d |
| Abstain cartel blocked, median days | 78%, 14 d | 72%, 14 d | 73%, 13 d |
| Mimic cartel: seats, cluster bonus, band bonus | 16%, 22%, 19% | 16%, 22%, 19% | 16%, 22%, 19% |
| Honest blocks per arbiter-year | 0.04 | 0.04 | 0.02 |

With the same 3.5-unit window, plain random promotion finishes at a median of 4.86; M+ / T+ with
M+ = K finishes at 3.93, and with the halfway M+ at 3.60.

**Choosing M+ in option A** (T+ = 3.5, option A only, 20 days × 2 seeds):

| M+ | 50 (= K) | 47 | **44** | 41 | 39 (= M + 1) | First-M |
|---|---|---|---|---|---|---|
| Round finished, median | 4.84 | 4.19 | **3.37** | 2.98 | 2.79 | 2.72 |
| Good work passes, under-threshold blocking | 100% | 99.6% | **98.4%** | 94.5% | 92.8% | 87.5% |

Halfway (44) costs about 1.6 points of good-work passes over M+ = K and finishes 1.5 units sooner.
Below it the race comes back quickly.

**What the contracts need.**
- **Condition 1** fires inside the M+-th commit's `fulfill`, as the M-th commit triggers promotion
  today. No extra transaction.
- **Condition 2 needs a trigger.** If at least M commits are in when T+ passes and no more arrive,
  nothing calls the contract. Add a public `promote(aggId)` that anyone (the keeper, the requester, a
  committed arbiter's node) may call once T+ has passed with at least M commits; a commit arriving
  after T+ also triggers it. With fewer than M commits at T+, the M-th commit promotes all M.
- **The draw needs entropy the trigger can't steer.** Whoever sends the M+-th commit or calls
  `promote` chooses the block, so the draw must not come from that block alone. It must never come
  from the commit hashes either: the last committer chooses its salt and could grind it. Use item 6
  (arbiter hash chains) or item 9 (a later block hash).
- **Reputation is unchanged.** Not being promoted earns 0, as in Table 1.
- **Gas (estimates from the code, not measured).** The M reveal dispatches are the same as today
  and dominate. Commits between M and M+ are now stored and counted (about 25k each, paid by the
  committing arbiter): one more for K=6 and K=8, six for option A. The draw of M from at most K
  commits in memory is under ~50k at K=50. `promote` moves the dispatch that today runs in the M-th
  commit's `fulfill` into its own transaction (+~21k). The entropy source (item 6 or 9) is the
  open cost.
- **It limits a grief.** Today a cartel member can send the M-th commit with too little gas: the
  `fulfill` reverts, the commit is lost and the round stalls until timeout (item 13). Under M+ / T+
  a failed M+-th commit only delays promotion to T+, when anyone can call `promote`.
- **Clustering is unchanged.** Promotion picks which M arbiters reveal; the first N reveals are
  still counted, and clustering picks P of them. The reveal race remains: a promoted colluder
  reveals at once and is always counted, and the slowest promoted reveals are dropped (1 of 5 at
  K=6, 11 of 38 in option A). Counting N at random among the reveals received by a deadline would
  remove it; not yet simulated. The mimic cartel's cluster bonus share (21–22%, fair 15%) is the
  same under every promotion rule; it comes from cluster seeding (items 10 and 13).

### Real latency (Base mainnet, 2026-11-17)
**Data.** Every round of the mainnet aggregator `0xd8F38bCB…` from its deployment to the scan:
862 rounds, 2026-06-09 to 2026-11-15, all on the deployed 6/4/3 configuration with a 300 s timeout, all
in general classes 128/131 (none in the code classes 133/134). Five operator nodes served them, but two
nodes (`0x860e…`, `0xeC9b…`, each running many jobs) held 97% of the selected slots, so this is
mostly two machines. The aggregator rejects commits and reveals once a round is complete, so a slot
that hadn't answered by then is censored at the round's end. The latencies below are Kaplan–Meier
estimates and a lognormal fitted with censoring, over completed rounds only.

**Commit latency** (request to commit):

| | Median | p90 | p95 | Mean / SD (lognormal) | Mean + 2 SD | Arrived by then |
|---|---|---|---|---|---|---|
| All completed rounds (776) | 76 s | 172 s | 196 s | 93 s / 54 s (σ 0.54) | 201 s | 96% |
| October–November (375) | 66 s | 116 s | 138 s | 76 s / 39 s (σ 0.49) | 155 s | 97% |

- **The two main nodes are alike** (October–November medians 66 s and 66 s, means 74 s and 78 s). The
  three small nodes had medians of 58 s, 136 s and 154 s, on 69, 13 and 24 slots.
- **Latency has improved over time.** Monthly medians: June 120 s, July 78 s, August 148 s, September
  92 s, October 66 s, November 86 s.
- **Reveal latency** (promotion to reveal): median 22 s, p90 54 s over all rounds; 14 s and 30 s in
  October–November.
- **Today's rounds** (first-M, all completed): promoted at a median of 78 s (p90 160 s), finished at
  a median of 104 s (p90 204 s). October–November: 68 s and 86 s (p90 110 s and 130 s).
- **The race favours whichever node is faster.** Over October–November, `0x860e…` held 49% of the
  selected slots but 55% of the promoted ones; by week the gap was 4–9 points, and in one week it
  ran the other way. This is honest nodes only. Random draws among the commits remove it.

**Outages, not latency, cause failed rounds.** 79 of 862 rounds (9.2%) timed out in the commit
phase and 7 in the reveal phase. 24 commit timeouts had no commit at all, which looks like requests
no node could process rather than slow nodes. The other 55 cluster in a few episodes (late June,
July 29 to August 1), when one node stopped committing (`0x860e…` missed 146 of its 184 slots in
those rounds). Item 7's freeze is aimed at exactly this. October–November had 6 commit timeouts
(1.6%), all with no commits.

**Replay of M+ / T+ on these rounds.** Promotion under the rule is min(t(M+), max(T+, t(M))) over
each round's commit times. Commits after promotion are logged until the round ends, and a commit
that never came before the end is imputed from its node's fitted distribution (50 draws per round).
The reveal phase is the round's own. Finish times, October–November:

| | First-M: median / p90 | M+ / T+, T+ = 120 s | T+ = 155 s (mean + 2 SD) | T+ = 180 s |
|---|---|---|---|---|
| Deployed 6/4 (M+ = 5) | 86 s / 130 s | 91 s / 136 s | 92 s / 140 s | 91 s / 140 s |
| 6/5 (M+ = 6) | 88 s / 136 s | 98 s / 140 s | 98 s / 164 s | 98 s / 165 s |

Over all rounds since June, at T+ = 201 s: 6/4 goes from 104 s / 204 s to 112 s / 212 s; 6/5 from
106 s / 208 s to 124 s / 220 s.
- **The rule costs about 5–10 s at the median** in October–November (up to 18 s over all rounds).
  Real nodes answer close together, so the M+-th commit usually arrives soon after the M-th. The slow
  tail costs more at 6/5, where M+ = K needs every juror: up to about 30 s at p90.
- **T+ hardly matters between 120 s and 180 s.** Most rounds promote on M+ commits before T+.
- The simulator's estimate (about +1 median latency at T+ = 3.5) overstated the cost because its
  latency model has a heavier slow tail than the real nodes.

**Limits of this data.** Two nodes, general classes, a 6/4/3 configuration. Code-class requests (long
code-runner jobs) and a larger, more varied pool will have other latencies, and the K = 8 and option A
classes can't be replayed from 6-slot rounds. Re-measure before setting T+ for those, and make T+
owner-settable per class.

**The risk script now uses these values.** `selection_randomness_risk.py` defaults to the
October–November medians (commit 68 s, reveal 15 s, σ 0.5; provenance in its section N7), replacing
the assumed 30 s and 6 s. Its results don't change beyond Monte Carlo noise: on two seeds the L1
re-submit pass rate moved 1.56% → 1.39% and 1.40% → 1.55%. Colluders are modelled answering in
about 3 s, so they win the race against honest arbiters at either latency. The exact config search
behind items 12 and 13 doesn't use latency.

### Shortlist size (2026-11-17)
The keeper draws a uniform shortlist from the eligible arbiters, then K weighted picks without
replacement (`ReputationKeeper.sol` ~500–585); the simulator does the same with Table 2's weights.
M+ / T+ promotion, 15% cartel attacking only when it can win, 60 days × 3 seeds:

| Shortlist | Mimic cartel seats | Bad models' seats | Biased model: selections before block | Bad work forced through | Good work passes, silent cartel |
|---|---|---|---|---|---|
| 20 (K=6 and K=8 classes only) | 15.7% | 2.1% | 34 | 0.65% | 84.6% |
| 60 (K=6 and K=8 classes only) | 15.9% | 2.2% | 40 | 0.30% | 84.8% |
| 120 (K=6 and K=8 classes only) | 15.9% | 2.1% | 32 | 0.40% | 84.0% |
| 60, nominal mix | 15.9% | 1.5% | 30 | 0.23% | 83.5% |
| 120, nominal mix | 15.9% | 1.4% | 27 | 0.23% | 84.4% |

(20 can't run option A: K = 50 must fit the shortlist.)

- **Shortlist size makes no material difference.** Weight spans only 1×–2×, and a mimicking cartel
  scores like honest arbiters, so a larger shortlist gives reputation more room to act on almost no
  difference. Bad arbiters are removed by blocking, not by selection weight.
- **Keep 60.** Option A needs at least 50 plus margin (item 13). Larger only costs gas: one
  selection-score read per shortlisted arbiter, very roughly 5–10k each (about +0.3M per request
  from 20 to 60; not measured), still below the full registry scan (item 2). `shortlistSize` is
  global to the keeper, so the small classes pay for 60 too unless it becomes per-class.

### Limits
- **Score-manipulating cartels are invisible.** A cartel voting plausible scores just on the wrong
  side of T can't be told apart from honest variation without knowing T. The configuration has to
  contain it (jury size, Q-of-N, M+ / T+ promotion). The bounty limits in items 12 and 13 already
  assume the cartel is never removed, so they stand.
- **A consumer-feedback (flip) score was tested and dropped.** It scored votes against the eventual
  outcome and did remove these cartels (89–98%), but it needs T and the outcome. If wanted later, add
  a neutral hook: the requester passes an exclusion list with its request, so an application like
  BountyEscrow can track flips itself and exclude arbiters from its own juries only. The keeper stays
  application-agnostic.

### Alternatives considered
- **Averages plus alarms (`--rules v2`).** Each score was an average (0–1000, for weight) plus a
  CUSUM alarm (for blocking). The quality alarm added `(min(z², 9) − 2) / 5 + (2.3 if z > 3 else
  −0.095)` and blocked at 8. The silence alarm added +10 per promoted miss and −1 per delivered
  reveal, and blocked at 30. A round-failure rule added up to 30, scaled by `5 × log10(1 / P(≥ k
  misses of n))`, so that small rounds wouldn't block honest arbiters. It caught cartels that fail
  rounds somewhat more often (96–100%) at a similar honest cost (0.1–0.5 blocks per arbiter-year).
  But it needs four numbers per arbiter, fractional increments, a log10, and a slack (M − N, K − M)
  that changes with the configuration. The simple rules keep the bounded score itself as the
  detector. One state per dimension does both weighting and blocking, and the 0–1000 range makes the
  surprise scaling unnecessary.
- **Commit-based timeliness** (credit per commit, an on-time-commit average): dropped, because it
  rewards fake commits. Rerunning without it changed nothing material.

### v2 example contracts (2026-11-18)
The v2 contracts (in `v2/` until they replaced v1 in this folder on 2026-11-18) implement Tables 1 and
2, the freeze, M+ / T+ promotion and item 9's two-phase request, including its beacon flag (item 9).
The README lists the behaviour; the points below changed or sharpened the design.
- **Scores are on the arbiters' 0..1,000,000 scale.** Mainnet reveals look like `[970000, 30000]`.
  The spread floor is 30,000 (3 points). The first draft used 3, which would have scored almost every
  honest reveal far (−200).
- **Frozen arbiters that committed are scored.** Being frozen is judged at round end. Only an answer
  to an outstanding call counts, so an arbiter that recovers before settlement isn't charged for an
  outage.
- **−400 only when commits fell short.** A round with M commits that timed out because nobody closed
  the commit phase charges nobody.
- **A score that reaches 0 while the arbiter is already blocked** restarts at 500 but adds no offense.
  Several in-flight rounds failing together count as one incident, not as a quick path to a ban. The
  simulator runs rounds one at a time, so this case doesn't occur there.
- **A returning key keeps its scores, offenses and classes.** Exiting and re-registering no longer
  resets a low score to 500. A new jobId still gives a fresh key, as noted under "Ban burn".
- **Health calls use a pending flag, not a time comparison.** Base timestamps are whole seconds, so a
  call sent in the same second as the last answer would otherwise look answered.
- **Hash chains can be rotated** (`rotateChain`): the answer comes from the old chain, and the new
  head applies to later calls only.
- **Measured gas, 300-arbiter pool, one full round, all transactions, at 0.006 gwei** (re-measured
  2026-11-18 with the operators' keeper gate and checkpointed chain heads):
  - Small $0.087, Medium $0.100, Large $0.248, Jumbo $0.558 without beacons and $0.570 with them
    (2026-11-19, beacon values from health answers and the random-order walk).
  - Jumbo's draw is 13.4–13.8M of the 16.8M per-transaction cap, depending on the jury, and
    `promote` is 5.9M.
  - Selection is 2.9M at K = 50, and the same with 300 or 3,000 arbiters.
  - A health answer is 123k, up from 77k, for the head checkpoint.
  - These are a little above `bounty_sizing.py`'s gas term (0.05 + 0.34 × K / 50: $0.09 at K = 6,
    $0.39 at K = 50). The Jumbo gap (about $0.17 a round) is too small to move item 15's limits.

### Open
- **The abstain dodge (found 2026-11-18, not fixed).** A cartel that blocks by never committing can
  also ignore its health call. It is then frozen at round end and escapes the −400, at the cost of
  being unselectable until it answers, a few minutes. The simulator always lets colluders answer
  calls, so the abstain-cartel results above (72–82% blocked) assume this doesn't happen. Options, to
  be simulated:
  - a cooldown after a late answer (not selectable for some hours, growing with repeats);
  - counting a freeze in a round that failed for lack of commits as an offense after a few repeats.
- **Point values and cutoffs.** +20 / −50 / −200 / −400 / −500 and the 1.5 / 3 spread cutoffs were
  tuned on simulated normal noise (SD 3). Check them against real arbiter score distributions,
  especially heavy-tailed or bimodal tasks.
- **Biased models in small rounds** take 1–2 weeks to remove. A small-K median is a weak reference.
- **Reconcile with item 7's details:** deadline D (~60 s), calls that exercise the AI pipeline, and
  self-service `requestHealthCall`. The simulator models a geometric unfreeze delay.
- **Late reveals.** "Promoted, no reveal, round still finished" and scoring late reveals need the
  aggregator to accept reveals after finalization until the reveal timeout, and a settlement step
  (or lazy settlement at the arbiter's next selection) to charge promoted arbiters that never
  revealed.
- **Gas.** Median and MAD per round (sort N values) and one score update per scored reveal. Check at
  N = 27.
- **T+ for other classes.** Measured for the general classes on two nodes (about 155 s, "Real
  latency"). Code classes and a larger pool still need measuring, and T+ should be owner-settable per
  class.

### Why it's deferred
Depends on item 7 (freeze) and the late-reveal recording change. Keeper and aggregator redeploy.

### Notes / related
- Reproduce: `python3 scripts/reputation_sim.py --compare --presets mix-v2,mix-v2-rnd --days 60
  --attack-when win` (and `--attack-when always`, `--colluders 0` for the honest control). Point
  values: `--pt-gain`, `--pt-minor`, `--pt-major`, `--pt-fail`, `--pt-nocommit`, `--pt-start`,
  `--pt-cap`; cutoffs: `--close-z`, `--far-z`; decay: `--decay-days` (0 = never). `--rules v2` runs the
  averages-plus-alarms design.
- Colluding hunter: `python3 scripts/reputation_sim.py --preset mix-v2-rnd --days 2 --hunter-per-day 24
  --hunter-class 6/5/4/3/3/1 --attack-when always` prints the timeline and every hunter submission.
  Change R through `--mix` (e.g. `6/5/4/3/3/2:80,...`).
- Real latency: `HARDHAT_NETWORK=base node scripts/arbiter-stats.js collect --aggregator
  0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a --from-block 47043694 --out arbiter-data.json` (read-only,
  about 15 min), then `python3 scripts/latency_replay.py arbiter-data.json --replay-m 4,5` (add
  `--since 2026-10` for October–November).
- Promotion rule: preset `mix-v2-hyb` (`--commit-select hybrid --commit-window 3.5`; T+ is
  `--commit-window`, M+ defaults to halfway, `--m-plus-slack s` sets M+ = K − s). Compare with
  `--compare --presets mix-v2,mix-v2-rnd,mix-v2-hyb --days 60 --attack-when win`, seeds 1–4.
- Colluders are fast only in attack rounds (`--col-speed attack`). Always-fastest overstated the
  cartel's seat share (A-cur mimic 54% → 18%).

---

## 15. Bounty classes: jury, fee and bond for each bounty size

**Status:** sized in the model (2026-11-17; Medium and Large re-sized for M+ / T+ and 6 rounds
2026-11-18). Not started.
**Scope:** class presets for BountyEscrow (jury config, Q, R, fee floor, bond), the bounty site, the
agent skill and the docs. Depends on items 8 (fee floor), 9 (two-phase request), 11 and 12 (Q-of-N
with re-runs), and item 14's M+ / T+ promotion (a launch requirement, see below); Jumbo also on items 6 and 13 and item 9's
beacon flag.

### Classes
Every class assumes the planned design, which is what gives these figures:
- **Item 9's two-phase request:** the jury is drawn from `blockhash(B+1)`, a block after the
  hunter's commit, so the hunter can't choose its jury.
- **Item 14's M+ / T+ promotion (planned):** promotion waits for M+ commits (or T+ ≈ 155 s with at least M)
  and draws the M promoted at random from the commits, using item 9's seed, so colluders can't win
  promotion by committing first.
- **Item 12's Q-of-N outcome:** pass at Q, hard fail (bond forfeited) below R, soft fail or no
  result re-runs, up to 6 rounds per submission (owner, 2026-11-18; was 5).
- **Jumbo only:** item 9's beacon flag (4 beacons polled, the first 2 used).

| Class | Jury K/M/N | Q / R | Beacons | Fee per arbiter | Bonus | Bond | Cost per round | Offered up to | Max bounty (model) | Binding limit | Good work while a cartel blocks: pass per round / never paid | Bad work keeps bond |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Bondless Small | 6/5/4 | 3 / 1 | off | $0.046 (today's) | B = 3, P = 3 | $0 | $0.83 | **$25** | $29 | repeated submissions | 65% / 0.6% | 57% |
| Small | 6/5/4 | 3 / 1 | off | $0.046 | B = 3, P = 3 | $5 | $0.83 | **~$100** | $101 | repeated submissions | 65% / 0.6% | 57% |
| Medium | 8/5/4 | 3 / 2 | off | $0.25 | B = 3, P = 3 | $50 | $4.60 | **~$1K** | $1,005 | the sequencer | 73% / 0.3% | 23% |
| Large | 21/16/13 | 10 / 8 | off | $0.25 | B = 3, P = 10 | $100 | $13.19 | **$10K** | $18.6K | the sequencer | 60% / 0.6% | 40% |
| Jumbo | 50/38/27 | 17 / 12 | on | $0.25 | B = 3, P = 17 (P = 2 until clustering is decided) | $200 | $26.39 | **$100K** | $165K | the sequencer | 80% / 0.01% | 20% |

- **"Offered up to"** is the bounty a class is sold for.
- **M+ / T+ is a launch requirement.** Medium and Large were sized for it (owner, 2026-11-18): with
  random promotion a seated colluder is often not promoted, which lets M sit well below K. If
  colluders could win promotion (today's first-come promotion, or a steerable draw), good work
  would never be paid in about 17% (Medium) and 20% (Large) of blocked submissions, and Small and
  Bondless Small would reach only $56 and $17. These classes must not launch before M+ / T+ with
  item 9's seed is live.
- **"Bad work keeps bond"** is the share of a forcing attack's rounds that end in neither a pass nor
  a hard fail (a soft fail, or no result because the cartel sank the round), so the hunter keeps the
  bond and may re-run. It measures queue squatting: each such round keeps a bad submission ahead in
  the payout order. Without a cartel, bad work keeps its bond only on honest no-shows (Small 5.8%,
  Medium 2.3%, Large 0.7%, Jumbo under 0.1%). The sizing caps it at 50% (Medium) and 40%
  (Large); Small is not capped (open item).
- **The sequencer is assumed to steer promotion too**, since the promotion draw uses the same seed,
  so the sequencer limits are the same with or without M+ / T+.
- **Good work with no attack** passes 93.9% (Small), 97.1% (Medium), 99.2% (Large) and 100% (Jumbo)
  of rounds.
- **"Binding limit."** A bounty is safe while it is below both the repeated-submission limit (a
  forcing hunter re-submitting until it passes) and the sequencer limit (a $1,000 bribe for a choice
  of seeds). The figures are break-evens with no safety margin.
- **Small and Medium are capped near $1K by the sequencer.** With 6–8 jurors a bribed sequencer
  nearly always finds a seed that seats enough colluders. Beyond about $1K the class must be Large.
- **Beacons: Jumbo only** (owner, 2026-11-18). Item 9's per-request beacon flag is on for Jumbo
  and off for the other classes. Beacons always help against the block builder: a bribed sequencer
  is left about 40 seeds instead of 256, and the draw no longer rests on the sequencer alone. On
  Jumbo's jury that raises the sequencer limit from $25K to $164K. The price is that colluding
  beacons get a choice of seeds, which helps a cartel force and block: on Jumbo good work passes
  80% of rounds while blocked instead of 86%, and bad work keeps its bond in 20% of rounds instead
  of 14%. Its cost per round includes 2 beacon values; the other classes have none. On the smaller
  juries the price is too high (see "Beacons on Medium and Large" below).

### Assumptions
Items 12 and 13's: 300 eligible arbiters of which 15% collude; honest scores integer-rounded normal
with SD 3; bad work 80, threshold T = 90, good work 95; 5% honest no-shows at commit and again at
reveal; up to 6 rounds per submission; a $1,000 sequencer bribe per attempt; item 9's two-phase
request with no beacons (256 seeds for a sequencer) except Jumbo (4 beacons polled, the first 2
used, about 40 seeds); colluders reveal first. Costs per
round are fee × (K + B × P + 1 + beacons) + gas (about $0.05 at K = 6, $0.39 at K = 50), at ETH $2,287.
The 1 is item 9's `promote` reward (adopted 2026-11-18), counted as a cost because a third party may
call `promote` first; the draw reward goes back to the hunter.

### Method
`scripts/bounty_sizing.py` computes everything exactly (no Monte Carlo) and prints the table.
- **Forcing hunter.** Colluders vote T on bad work. In each round the cartel may instead sink the
  round (never commit, or commit and stay silent) so the hunter keeps the bond and re-runs; it forces
  when enough colluders are seated and sinks otherwise, whichever minimises its cost per pass.
  Repeated-submission limit = expected (rounds × cost + bond lost) per submission ÷ P(pass) per
  submission.
- **Sequencer.** It keeps the seed that seats the most colluders, and is assumed to steer the
  promotion draw too, so its limit is the same under both promotion assumptions.
- **Blocking cartel.** Against good work it picks, per round, whichever lever gives the lowest pass
  rate: vote T − 1, commit and stay silent, never commit, or behave honestly.
- **Promotion.** The class table uses random promotion: item 14's M+ / T+ rule with entropy nobody
  can steer. "Colluders always promoted" (items 12 and 13's assumption: they win the race) appears
  in the earlier tables below, which sized the previous configs.
- **Beacons.** A cartel holding some of the 4 beacon seats chooses among 1, 2, 4, 6 or 6 seeds
  (0–4 colluding beacons) by when its beacons reveal, and keeps the seed seating the most colluders,
  for both forcing and blocking. The sequencer is left about 40 seeds.
- **Calibration.** For option A with beacons the script gives a sequencer limit of $164K, good work
  passing 74% of rounds while blocked, 0.5% never paid and bad work keeping its bond in 24% of
  rounds, against item 13's $162K, 73.3%, 0.61% and 22.6%. The Jumbo row quotes item 13.

### How the classes were chosen
- **Medium and Large re-sized for M+ / T+ and 6 rounds** (owner, 2026-11-18). The searches below
  this bullet required the honest-hunter targets with colluders always promoted. Requiring them under
  random promotion instead (Medium: good work passing ≥ 93% without an attack and ≥ 50% while
  blocked, never paid ≤ 1.5%, bad work keeping its bond in ≤ 50%; Large: ≥ 99%, ≥ 50%, ≤ 1%, ≤ 40%)
  allows smaller M relative to K:

  | Config | Cost per round | Max bounty | Good work, no attack | Pass while blocked / never paid | Bad work keeps bond |
  |---|---|---|---|---|---|
  | Medium 8/6/5, Q = 4, R = 2 (previous) | $5.10 | $1,013 | 95.2% | 64% / 1.2% | 34% |
  | Medium **8/5/4, Q = 3, R = 2** (chosen) | $4.35 | $1,004 | 97.1% | 73% / 0.3% | 23% |
  | Medium 7/5/4, Q = 3, R = 2 | $4.10 | $1,004 | 96.8% | 73% / 1.2% | 23% |
  | Large 26/21/16, Q = 11, R = 6 (previous) | $14.98 | $11.0K | 99.8% | 62% / 0.3% | 38% |
  | Large **21/16/13, Q = 10, R = 8** (chosen) | $12.94 | $18.5K | 99.2% | 60% / 0.6% | 40% |
  | Large 23/18/14, Q = 11, R = 7 | $14.21 | $42.5K | 99.7% | 60% / 0.7% | 29% |
  | Large 25/20/15, Q = 11, R = 9 | $14.72 | $17.0K | 99.8% | 66% / 0.4% | 34% |

  - No Large config with K ≤ 20 reaches $10K (K = 19: about $8–9K). K = 22 reaches only
    $11.5–12.4K, so the limit isn't monotonic in K.
  - The previous configs held up if colluders won promotion (never paid 5.0% and 0.4%); the chosen
    ones don't (17% and 20%), hence the launch requirement above. 23/18/14 was the more robust
    Large alternative (6.4%).
  - Medium 8/5/4 has less margin against repeated submissions: bad work passes 2.9% of rounds
    (0.6% for 8/6/5), and the repeated-submission limit is $1,445 against the $1,004 sequencer
    limit.
  - Configs with R = Q (no soft-fail band) scored slightly higher but were left out: item 12 keeps R
    below Q so a block doesn't cost an honest hunter the bond.
- **Small.** Each $1 of bond adds about $8 (colluders always promoted) to $14 (random promotion) to
  the limit; the fee adds much less, because a forcing cartel passes about 3–5% of rounds and the
  bond is lost on about a third of them. At today's fee, $5 reaches ~$100 under random promotion.
  With no bond, $100 would need a fee of about $0.18 per arbiter ($2.80 per round). Bondless Small
  keeps the same jury for bounties up to $25 (owner, 2026-11-18; was $15), against a $28 limit.
- **Small with no bond at all (not chosen).** A slightly larger jury with a strict quota reaches $100
  with no bond at today's fee: 9/7/6 Q = 5 with B = 1, P = 2 costs $0.62 per round and reaches $483
  with random promotion ($126 if colluders always win promotion). The price is good work passing 56%
  of rounds while a cartel blocks, and 1.6% never paid. The owner chose 6/5/4 with a $5 bond plus
  the bondless variant (2026-11-17).
- **Medium at today's fee.** At $0.046 per arbiter ($1.02 per round) and R = 1, Medium reaches
  $699 / $1,009, so it loses little to a lower fee.
- **Medium uses R = 2** (owner, 2026-11-17). With R = 1 bad work kept its bond in 72% / 65% of
  rounds (colluders always promoted / random promotion); with R = 2, 42% / 34%. The limit rises from
  $905 / $1,013 to $1,013 under both, now set by the sequencer. The cost: a cartel voting low can now
  force a hard fail on good work with fewer seats, so good submissions never paid while it blocks
  rise from 2.3% / 0.7% to 5.8% / 1.6%.
- **Large: the smallest jury reaching $10K (5 rounds, colluders always promoted).** Every row meets good work passing at least 99% of
  rounds without an attack, at most 1% of good submissions never paid, and bad work keeping its
  bond in at most 40% of rounds (queue squatting):

  | Good work's pass rate while blocked must be at least | Smallest config | Cost per round | Max bounty | Pass while blocked / never paid | Bad work keeps bond |
  |---|---|---|---|---|---|
  | 50% (item 12) | **26/21/16, Q = 11, R = 6** (chosen 2026-11-17, since replaced) | $14.98 | $11.0K | 62% / 0.95% | 38% |
  | 50%, more margin | 29/23/17, Q = 12, R = 7 | $16.50 | $16.7K | 65% / 0.91% | 32% |
  | 70% (item 13) | 37/29/21, Q = 14, R = 8 | $20.05 | $20.0K | 71% / 0.26% | 29% |

  - The sequencer sets Large's limit, so the bond doesn't: $25 already gives the full limit, and the
    repeated-submission limit is about $200K at $100. A larger bond still makes failed cartel
    attempts dearer; R sets how often bad work keeps its bond.
  - At K = 26 a blocking cartel makes good work need about 1.6 rounds instead of 1.4.
  - The limit isn't monotonic in K (integer effects): under the 70% requirement K = 35 reaches $9.0K
    but K = 36 only $6.6K.
- **Beacons on Medium and Large (not chosen; checked on the previous configs, 5 rounds).** With the flag on, every class's sequencer limit
  rises, but colluding beacons' choice of seeds weakens the honest-hunter guarantees, so the
  smallest jury meeting the same targets grows:

  | Config | Beacons | Cost per round | Max bounty (colluders always promoted / random) | Pass while blocked / never paid | Bad work keeps bond |
  |---|---|---|---|---|---|
  | Medium 8/6/5, Q = 4, R = 2 (previous) | off | $5.10 | $1,013 / $1,013 | 55–64% / 1.6–5.8% | 34–42% |
  | Medium 8/6/5, Q = 4, R = 2 | on | $5.60 | $811 / $1,832 | 43–54% / 3.8–12.8% | 44–53% |
  | Medium 16/13/10, Q = 7, R = 4 | on | $9.91 | $4,742 / $6,299 | 51% / 3.2–4.6% | 48% |
  | Medium 19/15/11, Q = 7, R = 4 | on | $10.68 | $1,557 / $2,436 | 60% / 1.1–2.2% | 39–48% |
  | Large 26/21/16, Q = 11, R = 6 (previous) | off | $14.98 | $11.0K / $11.0K | 62% / 0.8–0.9% | 38% |
  | Large 26/21/16, Q = 11, R = 6 | on | $15.48 | $67.3K / $67.3K | 50% / 3.1–3.3% | 50% |
  | Large 36/28/20, Q = 13, R = 8 | on | $19.54 | $39.5K / $39.5K | 64–67% / 0.4–0.9% | 33–36% |

  - Medium with beacons ($50 bond, ~$1K, good work passing ≥ 93% without an attack, ≥ 50% while
    blocked, bad work keeping its bond in ≤ 50%): nothing up to K = 12. K = 19 is the smallest with
    at most 2.5% never paid; K = 16 if up to ~5% is accepted.
  - Large with beacons ($100 bond, $10K, Large's targets above): nothing from K = 14 to 35 except
    32/25/18 Q = 11 R = 7 at $8.7K; K = 36 is the smallest. The search did not finish K = 39, 40
    and 44–46 (stopped for lack of memory).
  - Without beacons, K = 35–36 reaches $148K–227K (next bullet), so the beacons buy protection
    from the sequencer rather than a higher limit per juror.
- **`promote` reward adopted** (owner, 2026-11-18; item 9). Paying `promote`'s caller one fee adds
  $0.046 per round to Small and $0.25 to the others. The class table above includes it. The limits
  rise slightly, since both limits grow with the cost per round: Small $99 → $101, Medium $1,004 →
  $1,005, Large $18,546 → $18,551, Jumbo $164,481 → $164,520. The other tables in this section were
  computed before it.
- **Jumbo's bond is $200** (owner, 2026-11-18, down from $250). The sequencer sets Jumbo's limit,
  so the bond barely moves it: $166K at $250, $164K at $200, $162K at $100. The repeated-submission
  limit falls from $784K to $646K, still far above. The honest-hunter figures and the share of bad
  rounds keeping the bond (R sets it) don't change.
- **6 rounds per submission instead of 5** (owner, 2026-11-18). Only the never-paid rates change
  (Small 0.95% → 0.65%, previous Medium 1.58% → 1.25%, previous Large 0.84% → 0.33%, Jumbo 0.03% →
  0.01%); every max
  bounty, repeated-submission limit and bond-keeping rate is the same, because the round cap
  cancels out of the per-submission ratio. The cost is time: a submission that keeps soft-failing
  resolves up to one round (~3 minutes) later. The other searches and tables in this section were
  run with 5 rounds.
- **Accepting ~60–65% while blocked raises the limits a lot.** Without beacons, 30/24/18 Q = 13
  reaches $59K and 35/28/21 Q = 15 reaches $227K, against option A's $25K without beacons, because
  item 13's 70% requirement forces a lower Q relative to N. Jumbo keeps option A with beacons for
  the protection from the sequencer; a no-beacon Jumbo would need about K = 35 at this standard.

### Open
- **Jumbo's draw size (measured 2026-11-19).** Jumbo's draw uses 13.4–13.8M of the 16.8M
  per-transaction cap, depending on the jury (with the operators' keeper gate). Each juror whose
  operator burns its whole stipend adds about 92k. 33 such jurors of 50 still fit and 35 do not, with
  or without beacons. The round could then only be cancelled to the treasury after a day.
  - With the random-order walk, a 15% cartel (45 of 300 eligible) gets 34 of the 60 shortlisted
    seats with probability about 3 × 10⁻¹⁹ per round, and 1 × 10⁻⁶ even at 30%. The risk is
    negligible, so the draw stays one transaction (a batched draw was considered and not adopted).
  - Before the random-order walk it was about 3 × 10⁻³ per round for a cartel registered back to
    back (item 9, "Visit the class list in random order").
  - The figures come from the test stand-in operator. Re-measure with a real `ArbiterOperator` on
    testnet (item 16).
- **Noise.** Everything assumes honest SD 3, a target. The measured normal-SD equivalent is 7.1,
  which lowers every limit; re-size once noise is re-measured (item 13's sensitivity).
- **Cartel share and pool.** 15% of 300 eligible; 32 arbiters are registered today.
- **Queue squatting in Small.** With R = 1, bad work keeps its bond in 57% of rounds (Medium is 23%
  with R = 2; Large is at the 40% limit). Small and Bondless Small keep R = 1 (owner, 2026-11-18).
  R = 2 was weighed: bad work would keep its bond in 31% of rounds ($5 bond) or 18% (bondless), and
  Small's limit would rise from $99 to $146 ($98 at a $3 bond); Bondless Small's stays $28. But good
  submissions never paid while a cartel blocks would rise from 0.6% to 4.4%: with N = 4 a hard fail
  needs only 3 counted colluders (or 2 plus one honest score below T), and a hard fail ends the
  submission, so more rounds don't help. Squatting costs the attacker $0.78 a round and lasts at
  most 6 rounds; if it matters in practice, revisit R = 2 or a shorter re-run window for Small.
- **Medium's margin against repeated submissions.** 8/5/4's repeated-submission limit ($1,445) is
  close to its $1,004 sequencer limit, and both rest on assumptions (cartel share, SD 3, the $1,000
  bribe). Keep Medium offered at ~$1K, not above.
- **Configs per class.** K/M/N is per aggregator today (item 13), so five classes need several
  aggregator deployments or a per-request config. Large needs `shortlistSize` ≥ 21 (60 is planned,
  item 14).
- **Beacon flag per class or per bounty.** The class preset sets the flag. Whether a requester may
  also turn it on for Medium or Large is open: at their juries it raises the sequencer limit but
  weakens the honest-hunter figures (table above). Item 9's stricter variant (all 4 beacon values
  required) is not modelled and could change this.
- **Promotion entropy.** Every class's figures need the M+ / T+ draw to use item 9's seed, which no
  hunter or arbiter can steer; Small, Medium and Large depend on it most (launch requirement above).
  Test the draw's distribution before launch.

### Notes / related
- Reproduce: `python3 scripts/bounty_sizing.py` prints the class table;
  `python3 scripts/bounty_sizing.py --config 21,16,13,10,8 --fee 0.25 --bond 100` checks one config
  (add `--B`, `--P`, `--beacons`, `--seeds`). Item 13's calibration:
  `--config 50,38,27,17,12 --bond 250 --P 2 --beacons`.
- The earlier class figures ($159 / $1.1K for K=6, $314 / $1.8K for K=8 at $25 / $250 bonds,
  2026-11-16) had no recorded method; this item replaces them.

---

## 16. Bring the consumers in sync with the v2 contracts, and test them together on testnet

**Status:** not started (added 2026-11-19). The v2 contracts are on the `beacon` branch; `master`
matches the live v1 deployment.

The v2 contracts are a redeploy with a new ABI (`MIGRATION.md` lists every change). Nothing that
calls them has been ported, so they cannot run end to end yet. Each consumer gets a `beacon` branch
in its repository, and they are tested together on Base Sepolia before anything merges.

What each consumer needs (the files are where the v1 calls are today):
- **The arbiters themselves (the node; its own repository).** Needed first: without it every
  arbiter freezes at its first health call and cannot be drawn.
  - Generate and store a hash chain (item 6), and register with `registerArbiter(..., chainHead)`.
  - Answer every keeper `HealthCall` within 60 s with the next chain value (`answerHealthCall`),
    and rotate before the chain runs out (`rotateChain`). Beacon calls are ordinary health calls.
  - The commit / reveal wire format is unchanged. `aggId` is now sequential; check any parsing.
  - Each operator owner calls `addReputationKeeper(<v2 keeper>)` on its `ArbiterOperator`.
- **Example arbiters** (`applications/example-arbiters`).
  - Registration: `arbiterRegistration.js`, `RegisterArbiterModal.jsx`, `arbiterContracts.js`.
  - Exit: `requestExit` and `completeExit` replace deregistration.
  - Reset: `resetRegistry.js` and `ResetArbiterModal.jsx` have no v2 equivalent.
  - Views and stats: `MyArbiters.jsx`, `Analytics.jsx`, `Contracts.jsx`, the server's
    `verdiktaService.js` and `analyticsRoutes.js`. These move to `getArbiter`, the two scores,
    freeze, blocks and bans, and the v2 events.
- **BountyEscrow** (`applications/example-bounty-program`).
  - Contracts: `IVerdiktaAggregator.sol`, `BountyEscrow.sol`, `EvaluationWallet.sol`,
    `BountyEscrowLens.sol`, and the mock.
    - The 8-argument request, with the beacon flag from the class preset.
    - `maxTotalFee(fee, flag)`.
    - A `drawJury` passthrough, called twice with beacons.
    - `settle` replaces the timeout call, and `getRoundInfo` replaces the status call.
    - An undrawn round never times out.
    - Some outcomes refund nothing, and refunds go to credit.
  - Item 12's decision rules use item 11's `getOutcomeScores`.
  - The server and client: `contractService.js`, `verdiktaService.js`, `classPolicy.js`, the job,
    class and analytics routes, `BountyDetails.jsx`, `Blockchain.jsx`. Each class points at its own
    aggregator (item 15).
  - Someone must call `drawJury` (and `promote`) promptly. Rewards exist for that, but the server
    should do it too.
- **Example frontend** (`applications/example-frontend`): `RunQuery.js`, `contractUtils.js`,
  `timeoutUtils.js`, `App.js`, the debug tools. The query flow becomes request, then `drawJury` at
  B+2 (twice with beacons), then `promote`, then the result after finalization; timeouts now run
  from the draw.
- **Shared.** Port this folder's ops scripts (`MIGRATION.md` table), and update the docs site.

Order: deploy the v2 contracts to Base Sepolia, run
a few nodes on the beacon branch against them, then the example arbiters, then BountyEscrow and the
frontend. Done when a Small round and a Jumbo round with beacons complete end to end on testnet
through BountyEscrow, including a failed round and a settlement. Test with at least one real
`ArbiterOperator`, since the tests here use a stand-in.
