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
comes from the L1 origin block. The first stage (the 20-arbiter shortlist, see
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
  deadline that passed with no replies). Set the beacon deadline inside the 256-block
  `blockhash` window (~8.5 min on Base); if it passes, fail and refund the round rather
  than falling back to a later block's hash, which would let the caller choose timing.
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

**Status:** not started (design discussed 2026-11-07)
**Scope:** `ReputationAggregator.sol` + `ReputationKeeper.sol` (selection inputs, checkpoints) +
bounty program (`BountyEscrow.sol`, `EvaluationWallet.sol`, site, agent skill and docs). Breaking
change to the request flow and `maxTotalFee`.

### Problem
Every input to `selectOracles` is known before the request is sent (see item 6). A requester
simulates the draw for each coming block and submits only when it polls two colluding arbiters.
Two colluders that report the same score are always the closest pair, so they decide the round.
Waiting costs nothing, so raising the fee barely helps. `scripts/selection_randomness_risk.py`
at its planning defaults (300 eligible arbiters, 3% colluders, SD 3) with a $0.50 base fee puts
the most value one decision should carry at **$4.57**. A 10× higher fee raises that only 2.8×.

Item 6's first-responder beacon stops the requester from predicting the draw, but adds a
colluding beacon that can. It knows its own next value, and `blockhash(requestBlock)` is public
once the request is mined, so it answers only when its draw is good. In the model that limit is
about $200 to $270.

### Idea
Split each request into two transactions in different blocks. The requester is committed before
the randomness exists.
- **Commit (block B).** The request escrows the prepay and records the query, `aggId`,
  `requestBlock = B` and the requester. No selection or polling happens yet. The requester
  cannot cancel the round.
- **Seed.** `seed = keccak256(aggId, blockhash(B+1))`. Nobody knows it when B's transaction is
  signed. Use B+1, not B: the requester's own transaction is in B, and Flashblocks show most of
  B's contents before it closes. Do not use `prevrandao` or `timestamp`. On Base, the next
  block's `prevrandao` is usually the same L1-origin value, and its timestamp is parent + 2 s.
- **Enforcement.** `blockhash` returns 0 for the current and future blocks, so the draw must
  require `blockhash(B+1) != 0`, which means `block.number >= B+2`. No wrapper contract, bundle
  or batch can do both steps in one block.
- **Seal.** Permissionless `sealSeed(aggId)` stores `blockhash(B+1)` (~30k gas) while it is
  still within the 256-block window. The draw seals first if needed. Once sealed, the window no
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
  - `maxTotalFee = eff * (K + B*P + 2)`, which is 14 × `eff` with the default 6/3/2.
  - For the first **30 s** after the commit (by `block.timestamp`, not a block count; Base
    Sepolia blocks are 0.2 s), only the requester's draw earns the reward, credited back to the
    requester. After that, whoever draws is credited the reward in `ethOwed`. Anyone may draw
    earlier without the reward; the result is the same.
  - For now the hunter draws (bounty site, agent skill). Keepers, Chainlink Automation or
    market bots can take over later with no contract change.
- **No expiry before the draw.** A round cannot time out or refund until it is drawn. A
  requester who abandons a bad draw leaves the prepay locked, and anyone can draw it after 30 s
  for the reward, so abandoning buys no re-roll. An honest requester whose client died loses
  nothing.
- **The one exception.** If nobody sealed the seed within 256 blocks, the round can never be
  drawn. A permissionless cancel then sends the prepay to the treasury. It must not refund the
  requester: a refund would be a free re-roll.

### Expected payoff
At the risk model's defaults (300 eligible arbiters, 3% colluders, SD 3) with a $0.50 base fee:
- Requester prediction is gone. The limit becomes the blind re-submit bound, **~$428** (the
  ideal-RNG row), up from $4.57. At today's $0.05 fee: $1.61 → ~$42.
- A bribed sequencer can still grind `blockhash(B+1)` by reordering or including transactions.
  The builder rows are ~$1,100 to $1,200, above the re-submit bound, so the sequencer does not
  bind at these parameters.

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
- **Item 6.** This replaces item 6 as the near-term fix. Beacons remain a later hardening step
  against the sequencer, but only where withholding is uninformed: every assigned beacon must
  reveal, with values due before the deciding entropy exists. Alternatives are a pinned future
  drand round or threshold BLS signatures from an arbiter committee. First-responder beacons as
  written in item 6 lower the limit in the model.
- **Item 7** gets its liveness calls from item 6's hash-chain requests. If item 6 waits, item 7
  needs a different liveness call.
- **Item 8.** With a fee floor, size the reward on the amount the escrow uses,
  `max(effMaxFee, minFee)`. Change the `maxTotalFee` signature once if both land together.
- **EIP-2935**, if Base has it, makes 8,191 past block hashes readable, which largely removes
  the need for the seal.
- **Risk model.** Add an explicit two-phase scenario to `scripts/selection_randomness_risk.py`
  (sequencer can grind B+1), so the table shows this design directly.

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
- With true clustering, colluders need P of the 2P − 1 counted responses, whatever they report.

### Recommended configs
`setConfig(K, M, N, P, timeout)` with N = 2P − 1 counted, M = 2P reveal requests and K = 2P + 2
commits polled, a buffer of 2. These are owner-settable with no redeploy, for example
`setConfig(8, 6, 5, 3, 300)`. The existing checks (K >= M >= N >= P >= 2) already allow them.
K must fit within the selection shortlist (`shortlist_size` 20), and the class needs at least K
eligible arbiters.

### Expected payoff
Estimated from the risk model's assumptions (300 eligible arbiters, SD 3, the item 9 two-phase
request, a $1,000 sequencer bribe):
- P = 3, K = 8, first 2 of 4 beacons, $5 base fee: about **$90K** per decision at 3% colluders,
  against about $4.3K with greedy clustering. At 5% colluders about $17K; at 10% about $2.1K.
- P = 5, K = 12, today's $0.05 fee, no beacons: about $300K at 3% colluders.
- A larger P also tightens the honest cluster (the mean of P values), so pure spam gets harder.

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
