# v1 → v2: what changes outside the contracts

The v2 contracts replaced v1 in this folder on 2026-11-18. v1 is deployed (tag `aggregator-v0.1.0`;
untracked copy in `v1/`). v2 is a redeploy, not an upgrade: new keeper, new aggregator, new
`JuryBeacons`, and every arbiter registers again. This file lists what each consumer must change, from
comparing the two ABIs and the code that calls them.

## Unchanged for arbiters' nodes and operators

- **Request and callback shape.** Requests carry `cid` = `1:<cids>[:addendum]` (commit) or
  `2:<commit hash>` (reveal), plus `aggId`. The callback is `fulfill(bytes32, uint256[], string)`.
  The commit and the reveal's salt change (items 4 and 5, under "Arbiter node" below).
- **`aggId` is now sequential** (`bytes32(roundId)`) rather than a hash. Nodes treat it as an opaque
  string, so this should not matter, but check any node-side parsing.
- **`ArbiterOperator`'s keeper gate** calls `isContractApproved(requester)` on each keeper in its list,
  and `addReputationKeeper` checks that the function exists. The v2 keeper keeps that function
  (`approvedContracts` under the v1 name). Without it, every dispatch to a real operator would revert,
  and the aggregator would skip every slot. `TestOperator` now reproduces the gate, and it is on in
  every test. Each operator owner must call `addReputationKeeper(<v2 keeper>)`.

## Arbiter node (new work)

- **Commit and reveal format (items 4 and 5).** Every node must switch when the v2 aggregator goes
  live; a commit in v1's format is accepted but can never be revealed.
  - **Commit:** `keccak256(abi.encode(aggId, operator, response, salt))`, sent in full as the commit
    word (v1: the first 16 bytes of `sha256(abi.encode(operator, response, salt))`).
    - `aggId` is the request's `aggId` parameter, as `bytes32`.
    - `operator` is the operator contract that fulfills.
    - `response` is the `uint256[]` that will be revealed.
  - **Salt:** 16 random bytes, fresh for every commit. The reveal CID is `cid:<32 hex>` (v1: 20 hex).
  - **Reveal request:** `2:<64 hex>`, the full commit hash in lowercase (v1: 32 hex). Look up the
    stored answer by it.
  - **One answer per request.** A malformed reveal still uses up the request, so there is no retry.

- **Registration.**
  - `registerArbiter(oracle, jobId, fee, classes, chainHead)` replaces `registerOracle`. The stake is
    pulled from the caller, and the caller must be the keeper owner or the operator's `owner()`.
  - The node generates a hash chain (item 6: seed `s`, `v_{i-1} = keccak256(v_i)`) and registers the
    head.
  - **A head of 0 is allowed** (registration from a browser, which cannot hold the chain). The arbiter
    starts frozen in re-sync (flag 64, with a call pending), and its node's health job sets its chain as
    below.
  - `requestExit` + `completeExit` (after the unbonding period: 2 days by default, never less)
    replace `deregisterOracle`. Either the operator owner or the keeper owner may run both, also for
    a frozen arbiter. `setPaused` replaces `setOracleActive`.
  - A returning arbiter registers its classes again: exiting frees its slots.
- **Health calls** (`HealthCall(key, sentAt)` from the keeper).
  - Answer with `answerHealthCall(key, nextPreimage)` within `callDeadline` (60 s), from an authorized
    sender of the operator or its owner. Otherwise the arbiter is frozen until it answers.
  - `getArbiter` also returns `exitAt` (when `completeExit` is allowed), a second `requestExit`
    reverts with `AlreadyExiting`, and `arbiterClasses(key)` lists an arbiter's classes.
  - The node sends the answer from the Chainlink node's own key (TODO item 16).
    - A cron job per arbiter job reads `healthState(key)` (pending, sent at, current head) with one
      `ethcall`.
    - While a call is pending, it asks the external adapter over the `verdikta-ai` bridge for the
      preimage.
    - It sends `rotateChain(key, preimage, newHead)`. With `newHead == preimage` that is
      `answerHealthCall`.
    - Implemented on the arbiter's `beacon` branch: `external-adapter/src/health/`,
      `chainlink-node/healthJobSpec`.
  - Rotate the chain before it runs out with `rotateChain`.
  - **Chain re-sync (added 2026-11-23).** An answer whose value does not hash to the head no longer
    reverts: `answerHealthCall(key, v)`, or `rotateChain(key, v, v)` (the health job's form). The keeper
    adopts `v` as the head, emits `ChainResynced(key)`, sets flag 64 and freezes the arbiter at once.
    - It stays frozen until it answers a call sent *after* the re-sync. That call comes from selection,
      the owner's `sendHealthCalls`, `requestHealthCall(key)` (new; the operator's owner or an authorized
      sender), or the arbiter's own first valid answer after the re-sync, which sends it. So the health
      job alone recovers: re-sync, answer (sends the call), answer (unfreezes).
    - `healthState` keeps reporting `pending = true` throughout, so the job keeps calling the adapter.
    - A rotation to a different head still needs a valid preimage (`BadPreimage`).
    - A re-synced value is never a beacon value (`revealAfter` takes only a value that hashes to the
      head before it). A re-sync is not retroactive: a round that ended before it is judged as it was.
    - The adapter re-syncs onto a **fresh** chain when the keeper's head is on none of its stored chains
      (registered with head 0, or the chain files lost) or its chain is used up. Reusing a chain whose
      values were already revealed would make the arbiter's beacon values predictable.
- **Beacon calls need no extra code.** A beacon call is a keeper `HealthCall`, and the answer to it is
  the beacon value. `JuryBeacons` emits `BeaconCalled(aggregator, aggId, index, key, deadline)` for
  information. A beacon's value is used, and paid one fee, only if it is among the first 2 revealed
  within 120 s of the start. Answering promptly matters: a slow node loses the payment, and one that
  misses the 60 s call deadline is also frozen until it answers.
- **One-number answers (new).** A reveal may carry a single value (v1 required at least two). For a
  question that asks for one number, return `[score]`, not a per-outcome vector: the aggregator
  clusters a round in one dimension, exactly, when single values are strictly the most common
  length (on a tie the longer length wins), and cuts any longer reveal to its first value. If the node rescales its outcome scores to add up to
  1,000,000, a one-outcome question would always score 1,000,000: one-number questions need a
  score mode that skips that step.
- **Job gas limit.** The N-th counted reveal finalizes the round and pays for it: at Jumbo 1.3M gas
  with one-number answers, 2.6M with two outcomes, 6.9M at 20 outcomes. Set the job's gas limit
  above the largest answer the class allows; a reveal that runs out of gas is lost.
- **Posted fees and the floor (item 8).** A request may set a fee floor, and every juror is then paid
  at least the floor. Selection weighs the fee the requester pays, so a fee posted below a round's
  floor gains no weight there. A fee at or below the request's base cost now gets the full fee boost
  (v1 gave it none).

## BountyEscrow / EvaluationWallet (redeploy; item 9's notes)

`IVerdiktaAggregator` changes:

| v1 | v2 |
|---|---|
| `requestAIEvaluationWithApproval(cids, addendum, alpha, maxFee, baseCost, scaling, class)` | `(cids, addendum, alpha, maxFee, minFee, baseCost, scaling, class, withBeacons, jury)`: item 8's fee floor after `maxFee` (0 = none), the beacon flag (the class preset: Jumbo on), and the jury `(K, M, N, P, timeout)` (added 2026-11-24: one deployment serves every class) |
| `maxTotalFee(maxFee)` | `maxTotalFee(maxFee, minFee, withBeacons, K, P)`: `max(eff, minFee) × (K + B×P [+ 2]) + eff × (2 + 1)`, for the jury the request will ask for |
| `K()`, `M()`, `N()`, `P()`, `setConfig` | none: the jury is the request's. `getJury(aggId)` returns a round's `(K, M, N, P, timeout)`; the owner bounds requests with `setLimits(maxJury, maxTimeout, tPlus)` (`maxJury()`, `maxTimeout()`, `tPlus()`) |
| (none) | `drawJury(aggId)` from block B+2: a passthrough on the wallet, like `startEvaluation`, so the draw reward reaches the hunter. With beacons, call it twice: once to start the stage, then again once 2 beacon values are in |
| `finalizeEvaluationTimeout(aggId)` | `settle(aggId)` after the round's deadline. Anyone may call it. New requests also settle due rounds, but only within a budget of `settlePerRequest` × their own K slots and in queue order, so a big or long round can need an explicit `settle` |
| `getAggregationStatus(aggId)` → `isComplete, failed, …` | `getRoundInfo(aggId)` → `phase, …`. Settled = phase 7 (settled) or 8 (failed); `isFailed(aggId)`. After the escrow fields it also returns `deadline` (0 until the draw; `settle` is due after it), `windowEnd` (T+ after the draw), `commits` and `requestTime` (added 2026-11-23, for consumers' on-chain views) |
| `getEvaluation(aggId)` | same; valid from finalization (phase 6), before settlement |
| `responseTimeoutSeconds()` | none: the jury's `timeout`, run from the draw, not the request |

Behaviour BountyEscrow must allow for:

- **The submission stays `PendingVerdikta` until drawn, and an undrawn round never times out.**
  `failTimedOutSubmission` must not treat it as failed.
- **Draw within a day.** `drawJury` reverts with `DrawExpired` more than a day after the request; the
  round can then only be cancelled (to the treasury, below).
- **No refund when the round ends this way.** A refund would be a free re-roll, so the unspent prepay
  goes to the treasury:
  - a missed beacon quorum (phase 8, `EvaluationFailed(aggId, 2)`);
  - a commit phase that had M commits but was never promoted (closed and not promoted, or nobody
    called `closeCommits` after T+);
  - a cancelled round (phase 9: never sealed within ~27 min, or sealed but undrawn for a day);
  - a beacon round whose jury can't be drawn once the beacon values are in, when the class list is
    longer than the keeper's `maxScan` (`keeper.scansAll(cls)` is false). The beacons are still paid.

  The hunter may re-run (item 12), but its `refundLeftoverEth` gets nothing back for that round.
- **Refunds land in `ethOwed[wallet]`:**
  - at finalization for a successful round;
  - at settlement for a failed round;
  - at the draw for a pool shortage (no eligible arbiter, or fewer beacon candidates than the
    quorum).
- **Credit covers only what `msg.value` does not.** Sending exactly `maxTotalFee` leaves the wallet's
  credit untouched, and an overpayment returns to credit.
- **Fees per class.** The fee per class must stay at or below `maxOracleFee()`. K/M/N/P and the
  timeout are the bounty's (its class preset), passed with every request; one aggregator serves every
  class. The request reverts (`BadJury`, from AggregatorLib) unless K >= M >= N >= P >= 1, N <= 40,
  P >= 2 unless N = 1, K <= `maxJury()` and the keeper's `shortlistSize()`, and T+ < timeout <=
  `maxTimeout()`.
- **A thin pool repeats arbiters.** With fewer than K eligible, the jury fills with repeats (slot k
  holds pick k mod m); the draw fails (refunded) only when none is eligible. Repeats can also happen
  in a deep pool, if `shortlistSize` is lowered after the request or the walk's `maxScan` entries hold
  fewer than K eligible. A repeated arbiter can decide a round alone, and a Q-of-N rule counts slots,
  not arbiters: check `keeper.eligibleCount(cls, maxFee)` before relying on a round.
- **The fee floor (item 8).** It is the bounty creator's setting: add `minOracleFee` to the bounty's
  oracle parameters and pass it into every request for that bounty, never the hunter's choice. It
  may exceed `maxOracleFee()`. The UI should ask for a target cost per attempt and divide by K,
  since an attempt costs at least K × the floor (K + 2 with beacons, which are paid the floor too).
  The draw reward the wallet receives is on the ceiling, not the floor.

## Scripts in this folder

`deploy/` is ported and tested on the in-process network (`npx hardhat deploy --tags
aggregator,keeper,config`). The Python analysis scripts do not touch the contracts.

**Run against the live v1 contracts from a checkout of the tag, not from this folder.** Scripts that
use `ethers.getContractAt("ReputationAggregator", …)` now get the v2 ABI.

| Script | v1 calls it depends on | v2 replacement |
|---|---|---|
| `register-oracle(-cl).js` | `registerOracle`, `getOracleInfo` | `registerArbiter` with a chain head, `getArbiter(key)` |
| `unregister-oracle*.js` | `deregisterOracle` | `requestExit`, then `completeExit` after the unbonding period (2 days) |
| `reset-oracle.js`, `reset-reputations-cl.js` | `resetAllReputations` | none (no reset in v2) |
| `oracle-poller(-cl).js`, `arbiter-noise.js`, `arbiter-stats.js` | `registeredOracles`, `getRegisteredOraclesCount`, `getOracleInfo`, `getOracleClasses` | the `ArbiterRegistered` events, `classSize(cls)`, `getArbiter(key)` |
| `monitor-contracts(-cl).js`, `agg-history.js` | `getContractConfig`, `oraclesToPoll`, `getAggregationStatus`, v1 events | `getJury(aggId)` per round, `maxJury()`/`maxTimeout()`/`tPlus()`, `getRoundInfo`, v2 events |
| `single-query.js`, `simultaneous-tests.js` | 7-argument request, `maxTotalFee(fee)` | 10-argument request (with the jury), `maxTotalFee(fee, floor, flag, K, P)`, then `drawJury` at B+2 (twice with beacons) and `promote` after the commit phase closes |
| `refund.js` | `finalizeEvaluationTimeout`, `getAggregationStatus` | `settle`, `getRoundInfo` |
| `configure-contracts.js`, `deploy_just_aggregator.js` | `approveContract`, `setConfig(5 args)`, `setMaxOracleFee` | `setApproved`, `setLimits`, `setParams`, `setContracts` (or `deploy/`) |
| `reveal-forensics.js` | v1 reveal events (`RevealHashMismatch`, …) | v2 ignores bad reveals silently: only `RevealReceived` is emitted |
| `transfer-ownership.js`, `whoami.js`, `check-*.js`, `approve-link.js`, `withdraw-link-from-oracle.js`, `fork-base-sepolia.js`, `estimate-deploy-cost.js`, `show-gas.js` | none of the changed calls | check before use |

The shell wrappers call these scripts. `deploy.sh` runs `deploy/` and works, but
`deploy_aggregatorOnly.sh` runs `deploy_just_aggregator.js`, which is v1. `size-contracts.sh` and
`verify.sh` read artifacts by name and omit `JuryBeacons` and the libraries.

## Removed from v1 (no v2 equivalent)

- **Aggregator:**
  - `finalizeEvaluationTimeout`: replaced by `settle`.
  - `withdrawLink`: v2 holds no LINK.
  - the score-delta setters: points now live in the keeper (`setPoints`).
  - the reveal diagnostic events.
  - `getContractConfig`, `getCurrentRequestCounter` (now `roundCount`), and the request-id maps
    (now `requestRef`).
- **Keeper:**
  - `manualBlockOracle`, `resetAllReputations`, `recordUsedOracles`, `pushEntropy` and the entropy
    buffer: selection entropy is item 9's seed.
  - the mild/severe thresholds: Table 2 replaces them.
  - `setVerdiktaToken`: the token is immutable.
  - `setSlashAmount`: now `setPenalties`.
  - `getRecentScores`.
