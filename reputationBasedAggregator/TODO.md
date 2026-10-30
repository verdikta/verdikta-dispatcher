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
- `ReputationAggregatorLINK.sol` is a legacy archive and does not need to change.

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
