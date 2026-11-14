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
- **Re-runs are capped** (e.g. 3 to 5 per submission) and must start within a re-run window
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
- **Re-runs.** Item 12's rules, with at most 5 rounds per submission.
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
    Revisit whether to keep them.
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
  - **The model must be re-run at 60.** Option A's figures assume a uniform jury: each colluder is
    picked as often as an honest arbiter. At 60 a cartel that farms reputation (for example by
    collecting the bonus as described below) gets more than its 15% share of jury slots, and
    honest arbiters with high scores get more too. Add the selection weighting to the risk model:
    a 60-arbiter uniform shortlist, then 50 picks by score without replacement. Re-check the
    targets for the colluder weights the reputation design allows. The reputation-management
    discussion has to bound how far a colluder's weight can rise above an honest arbiter's.
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
    several calls.
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
    used in the model).
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

## 14. Reputation v2: two scores (timeliness, quality) plus the liveness freeze

**Status:** design simulated (2026-11-14), not started in the contracts.
**Scope:** `ReputationKeeper.sol` (scores, alarms, block durations, ban, selection weight) and
`ReputationAggregator.sol` (record late commits and reveals, report each reveal's distance from the
median, sink rule, optional random promotion). Builds on item 7 (freeze) and serves item 13.
Simulator: `scripts/reputation_sim.py` (presets `mix-v2`, `mix-v2-rnd`).

### Problem
Today's rules are cumulative quality and timeliness points with mild, severe and worsening thresholds.
The simulator shows three weaknesses:
- They reward speed and cluster seeding, so a cartel that only mimics the consensus collects about
  28% of jury seats in the nominal mix (its fair share is 15%).
- They cannot see a commit-then-silent or abstaining blocker, so blocking leaves only 21–55% of good
  work passing in small rounds.
- They are slow on incompetent arbiters, and they charge honest arbiters for losing the commit or
  reveal race.

### Idea
Everything uses only what the contracts see: commit and reveal times, and each reveal's score against
the round's median. The contracts don't know how results are used (for example a bounty's threshold
T), so nothing depends on that.

- **Liveness (item 7, not a score).** Hash-chain/beacon calls go to every juror, plus suspects (missed
  a commit last round) and some random arbiters. An arbiter that hasn't answered by the deadline is
  frozen. A frozen arbiter is excluded from selection until it answers, and its reputation is
  untouched. Frozen arbiters are not charged for missed work.
- **Timeliness score.**
  - Average: an EMA (rate 0.02) of commits arriving within 4 median-latency units. It feeds the
    selection weight.
  - Alarm: one silence CUSUM. +10 for a promoted arbiter that never revealed, +4 for a live arbiter
    that never committed, −1 per commit. Blocks at 30. A miss counts only when it is unambiguous: a
    timed-out round, or any round once late commits and reveals are recorded.
  - Sink rule: when a round fails because more live arbiters went silent than the slack allows
    (M − N at reveal, K − M at commit), each of them gets
    `min(30, 5 × log10(1 / P(≥ k misses of n | 1% honest miss rate)))`. Scaling by how unlikely the
    misses are stops small rounds (slack 1) from blocking honest arbiters for two coincident
    transients.
- **Quality score.** For each scored reveal, `z = |score − median| / max(1.4826 × MAD, 3)`.
  - Average: an EMA of `z ≤ 1.5` (agreement). It feeds the selection weight.
  - Alarm: one CUSUM with increment `(min(z², 9) − 2) / 5 + (2.3 if z > 3 else −0.095)`. Blocks at 8.
    The first term catches persistent deviation (wrong or lazy model). The second catches rare large
    deviations.
- **Selection weight.** `1 + (ratio − 1) × rep`, where `rep` is the average of the two EMAs and the
  ratio is 2. Weight can at most double, so a fast or always-agreeing cartel gains little seat share.
  Race rank is never penalised.
- **Blocks.** Either alarm blocks for 24 h × 2^offenses, and the alarm resets. Ban after 3 offenses.
  Alarms are floored at 0, so a long good record buys no immunity.
- **Random promotion (optional, recommended).** Promote M commits drawn at random from those arriving
  within a commit window (2 units), instead of the first M. If fewer than M are on time, the earliest
  late commits fill. Answering early then earns nothing. This is the main protection small rounds have
  against forcing.
- **Bonus.** Every round escrows a pool of B × P × fee. The cluster pays it to exactly P members. The
  alternative band rule splits it evenly among counted reveals within z ≤ 1.5 of the median.

### Expected results (simulator, nominal mix, 60 days, 15% cartel, no consumer feedback)
Nominal mix: 80% 6/5/4/3/3, 16% 8/6/5/4/4, 4% option A (50/38/27/17/17, R = 12). Single runs, so
differences of a few points are noise.

| | v2, first-M promotion | v2, random promotion |
|---|---|---|
| Down arbiters removed before repair | 88–92%, ~0.8 h | 88–93%, ~0.8 h |
| Biased / noisy / lazy model removed (all), median days | 6–13 / 3–10 / 0.6–1.9 | 6–17 / 3–8 / 0.7–1.9 |
| Honest blocks per arbiter-year (all from silence, none from quality) | ~0.1 | ~0.1 |
| Mimic cartel: seats, cluster bonus, band bonus | 16%, 22%, 19% | 16%, 22%, 19% |
| Silent / abstain cartels blocked | 91–100% | 89–100% |
| Under-threshold blocking or forcing cartels removed | 0–2% | 0–7% |

Pass rates per round when the cartel attacks only when it can win (K=6 / K=8 / option A):

| | First-M promotion | Random promotion |
|---|---|---|
| Good work passes, under-threshold blocking | 73% / 58% / 78% | 91% / 85% / 100% |
| Bad work forced through | 4.0% / 1.4% / 0% | 0.6% / 0.7% / 0% |

For comparison, today's rules on the same mix: mimic seats 28%, and forcing passes 33% / 17% of bad
work in small rounds.

### Limits
- **Score-manipulating cartels are invisible.** A cartel voting plausible scores just on the wrong
  side of T can't be told apart from honest variation without knowing T. The configuration has to
  contain it (jury size, Q-of-N, random promotion). The bounty limits in items 12 and 13 already
  assume the cartel is never removed, so they stand.
- **A consumer-feedback (flip) score was tested and dropped.** It scored votes against the eventual
  outcome and did remove these cartels (89–98%), but it needs T and the outcome. If wanted later, add
  a neutral hook: the requester passes an exclusion list with its request, so an application like
  BountyEscrow can track flips itself and exclude arbiters from its own juries only. The keeper stays
  application-agnostic.

### Open
- **Offense decay.** Offenses never decay, so three honest silence blocks over years mean a ban. Add a
  decay (e.g. one offense forgiven per 90 clean days).
- **Biased models in small rounds** take 1–2 weeks to remove. A small-K median is a weak reference.
  Consider weighting z by the round's N.
- **Reconcile with item 7's details:** deadline D (~60 s), calls that exercise the AI pipeline, and
  self-service `requestHealthCall`. The simulator models a geometric unfreeze delay.
- **Gas.** The quality CUSUM needs the median and MAD per round (sort N values), plus one SSTORE per
  scored reveal. Check at N = 27. Recording late commits and reveals needs the aggregator to accept
  `fulfill` after finalization for scoring only.

### Why it's deferred
Depends on item 7 (freeze) and the late-reveal recording change. Keeper and aggregator redeploy.

### Notes / related
- Reproduce: `python3 scripts/reputation_sim.py --compare --presets mix-v2,mix-v2-rnd --days 60
  --attack-when win` (and `--attack-when always`, `--colluders 0` for the honest control).
  `--scoring three` runs the earlier separate quality and extreme alarms. Removal was slower (biased
  8–22 d), with the same honest cost.
- Colluders are fast only in attack rounds (`--col-speed attack`). Always-fastest overstated the
  cartel's seat share (A-cur mimic 54% → 18%).
