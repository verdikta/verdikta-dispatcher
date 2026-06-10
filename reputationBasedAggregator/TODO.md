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
