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
