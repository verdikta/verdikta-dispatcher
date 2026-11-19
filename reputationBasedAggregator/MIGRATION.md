# v1 → v2: what changes outside the contracts

The v2 contracts replaced v1 in this folder on 2026-11-18. v1 is deployed (tag `aggregator-v0.1.0`;
untracked copy in `v1/`). v2 is a redeploy, not an upgrade: new keeper, new aggregator, new
`JuryBeacons`, and every arbiter registers again. This file lists what each consumer must change, from
comparing the two ABIs and the code that calls them.

## Unchanged for arbiters' nodes and operators

- **Commit / reveal wire format.**
  - Requests carry `cid` = `1:<cids>[:addendum]` (commit) or `2:<commit hash>` (reveal), plus `aggId`.
  - The callback is `fulfill(bytes32, uint256[], string)`.
  - The commit is `bytes16(sha256(abi.encode(operator, response, salt)))`, and the reveal CID is
    `cid:20-hex-salt`.
- **`aggId` is now sequential** (`bytes32(roundId)`) rather than a hash. Nodes treat it as an opaque
  string, so this should not matter, but check any node-side parsing.
- **`ArbiterOperator`'s keeper gate** calls `isContractApproved(requester)` on each keeper in its list,
  and `addReputationKeeper` checks that the function exists. The v2 keeper keeps that function
  (`approvedContracts` under the v1 name). Without it, every dispatch to a real operator would revert,
  and the aggregator would skip every slot. `TestOperator` now reproduces the gate, and it is on in
  every test. Each operator owner must call `addReputationKeeper(<v2 keeper>)`.

## Arbiter node (new work)

- **Registration.**
  - `registerArbiter(oracle, jobId, fee, classes, chainHead)` replaces `registerOracle`. The stake is
    pulled from the caller, and the caller must be the keeper owner or the operator's `owner()`.
  - The node generates a hash chain (item 6: seed `s`, `v_{i-1} = keccak256(v_i)`) and registers the
    head.
  - `requestExit` + `completeExit` (after the unbonding period: 2 days by default, never less)
    replace `deregisterOracle`. Either the operator owner or the keeper owner may run both, also for
    a frozen arbiter. `setPaused` replaces `setOracleActive`.
  - A returning arbiter registers its classes again: exiting frees its slots.
- **Health calls** (`HealthCall(key, sentAt)` from the keeper).
  - Answer with `answerHealthCall(key, nextPreimage)` within `callDeadline` (60 s), from an authorized
    sender of the operator or its owner. Otherwise the arbiter is frozen until it answers.
  - Rotate the chain before it runs out with `rotateChain`.
  - Calls go to every drawn juror, to `liveRandom` other shortlisted arbiters, and to beacons.
- **Beacon calls need no extra code.** A beacon call is a keeper `HealthCall`, and the answer to it is
  the beacon value. `JuryBeacons` emits `BeaconCalled(aggregator, aggId, index, key, deadline)` for
  information. A beacon's value is used, and paid one fee, only if it is among the first 2 revealed
  within 120 s of the start. Answering promptly matters: a slow node loses the payment, and one that
  misses the 60 s call deadline is also frozen until it answers.

## BountyEscrow / EvaluationWallet (redeploy; item 9's notes)

`IVerdiktaAggregator` changes:

| v1 | v2 |
|---|---|
| `requestAIEvaluationWithApproval(cids, addendum, alpha, maxFee, baseCost, scaling, class)` | same plus `bool withBeacons` (the class preset: Jumbo on) |
| `maxTotalFee(maxFee)` | `maxTotalFee(maxFee, withBeacons)`: `eff × (K + B×P + 2 + 1 [+ 2])` |
| (none) | `drawJury(aggId)` from block B+2: a passthrough on the wallet, like `startEvaluation`, so the draw reward reaches the hunter. With beacons, call it twice: once to start the stage, then again once 2 beacon values are in |
| `finalizeEvaluationTimeout(aggId)` | `settle(aggId)` after the round's deadline. Anyone may call it, and new requests settle due rounds too |
| `getAggregationStatus(aggId)` → `isComplete, failed, …` | `getRoundInfo(aggId)` → `phase, …`. Settled = phase 7 (settled) or 8 (failed); `isFailed(aggId)` |
| `getEvaluation(aggId)` | same; valid from finalization (phase 6), before settlement |
| `responseTimeoutSeconds()` (uint256) | uint40 (ABI-compatible); runs from the draw, not the request |

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
  - at the draw for a pool shortage (fewer than K eligible, or fewer beacon candidates than the
    quorum).
- **Credit covers only what `msg.value` does not.** Sending exactly `maxTotalFee` leaves the wallet's
  credit untouched, and an overpayment returns to credit.
- **Fees per class.** The fee per class must stay at or below `maxOracleFee()`. K/M/N come from the
  class's aggregator, one deployment per class.

## Scripts in this folder

`deploy/` is ported and tested on the in-process network (`AGG_CLASS=jumbo npx hardhat deploy --tags
aggregator,keeper,config`). The Python analysis scripts do not touch the contracts.

**Run against the live v1 contracts from a checkout of the tag, not from this folder.** Scripts that
use `ethers.getContractAt("ReputationAggregator", …)` now get the v2 ABI.

| Script | v1 calls it depends on | v2 replacement |
|---|---|---|
| `register-oracle(-cl).js` | `registerOracle`, `getOracleInfo` | `registerArbiter` with a chain head, `getArbiter(key)` |
| `unregister-oracle*.js` | `deregisterOracle` | `requestExit`, then `completeExit` after the unbonding period (2 days) |
| `reset-oracle.js`, `reset-reputations-cl.js` | `resetAllReputations` | none (no reset in v2) |
| `oracle-poller(-cl).js`, `arbiter-noise.js`, `arbiter-stats.js` | `registeredOracles`, `getRegisteredOraclesCount`, `getOracleInfo`, `getOracleClasses` | the `ArbiterRegistered` events, `classSize(cls)`, `getArbiter(key)` |
| `monitor-contracts(-cl).js`, `agg-history.js` | `getContractConfig`, `oraclesToPoll`, `getAggregationStatus`, v1 events | `K()`/`M()`/`N()`/`P()`, `getRoundInfo`, v2 events |
| `single-query.js`, `simultaneous-tests.js` | 7-argument request, `maxTotalFee(fee)` | 8-argument request, `maxTotalFee(fee, flag)`, then `drawJury` at B+2 (twice with beacons) and `promote` after the commit phase closes |
| `refund.js` | `finalizeEvaluationTimeout`, `getAggregationStatus` | `settle`, `getRoundInfo` |
| `configure-contracts.js`, `deploy_just_aggregator.js` | `approveContract`, `setConfig(5 args)`, `setMaxOracleFee` | `setApproved`, `setConfig(6 args)`, `setParams`, `setContracts` (or `deploy/`) |
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
