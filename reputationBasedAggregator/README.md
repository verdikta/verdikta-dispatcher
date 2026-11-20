# Reputation aggregator v2 (TODO items 4, 5, 8, 9, 11, 14 and 15)

The v2 contracts: the two-score reputation design (item 14), the two-phase request with optional
beacons (item 9), the per-arbiter score getter (item 11), the requester-set fee floor (item 8) and
item 15's class configurations. They
replaced the v1 contracts in this folder on 2026-11-18. Not audited and not deployed yet.

The deployed v1 code is tag `aggregator-v0.1.0`. An untracked copy of the v1 folder sits in `v1/`
for comparison (see `v1/SNAPSHOT.md`). `MIGRATION.md` lists what changes for BountyEscrow, the
arbiter node, the operator contract and the scripts.

| Contract | Role |
|---|---|
| `ReputationKeeper` | Arbiter registry, stake, unbonding, burns, two scores (Table 1 via `applyOutcomes`, −400 for a live non-committer when the round failed for lack of commits), blocks / bans / 90-day decay (Table 2), hash-chain health calls (each reveal recorded with its block and time), freeze and chain rotation, reputation-weighted selection (the fee weight scored on what the requester pays, item 8) from a bounded walk of the class list in random order, and the beacon pick. Selection state is checkpointed by block, so a draw reads the state as of the request block (item 9). Answers `isContractApproved`, which every deployed `ArbiterOperator` uses to gate requests |
| `ReputationAggregator` | Two-phase request (escrow at block B; `drawJury` from B+2, seeded by `blockhash(B+1)`, read through EIP-2935 after 256 blocks; 2 x fee draw reward; `sealSeed`, `cancelUnsealed`), the optional beacon stage, M+ / T+ promotion (closes at the M+-th commit or after T+ with at least M; `promote` from C+2 draws M of all commits), late reveals, settlement after the deadline with one batched keeper call, a settlement queue drained by new requests, `getOutcomeScores` (item 11), the requester-set fee floor (item 8) |
| `JuryBeacons` | Item 9's beacon flag, kept out of the aggregator for bytecode: picks 4 beacons through the keeper (which sends each a health call), reads their answers from the keeper, and reports the mix of the first 2 |
| `ScoringLib` | External library: finalization in one call (v1's length normalization, cluster, mean, quality classes), the promotion draw. One-number answers get the exact 1-D cluster; longer vectors item 10's nearest-neighbour rule, which replaces v1's greedy one |
| `AggregatorLib` | External library: v1's helpers plus the commit payload builder, a one-pass CID/salt parser for the 128-bit salt, and word-level hex encoders |
| `test/TestOperator` | Gas-faithful stand-in for Chainlink's Operator (the real one pins solc 0.8.19), with `ArbiterOperator`'s keeper gate (on by default in the tests). `setBomb` makes it burn all gas |
| `test/MockHistory` | Stand-in for the EIP-2935 history contract, installed at its address (Hardhat's stub reverts) |

## Run

```
npx hardhat test                       # all 107 tests, ~3 min
npx hardhat test test/gas.test.js      # gas and cost report per class
npx hardhat test test/beacons.test.js  # the beacon stage
AGG_CLASS=jumbo npx hardhat deploy --tags aggregator,keeper,config   # in-process deploy check
```

`hardhat.config.js` loads the deploy secrets like v1's config does. The tests use only the in-process
network. `deploy.sh` runs the same three tags against `NET` (default `base_sepolia`).

Tests:
- `size.test.js`: EIP-170 / 3860 limits.
- `keeper.rules.test.js`: Tables 1 and 2, decay, burns, unbonding (the 2-day floor), re-registration,
  slot reuse (a draw at B unchanged by later exits and joins; the 1-day age limit), freeze,
  same-second calls, chain rotation, selection (including a back-to-back cartel block against the
  random-sample tails, and a walk that must reach every entry), the operator gate.
- `aggregator.flow.test.js`:
  - item 9: draw timing; determinism whoever draws and whenever; EIP-2935 reads; reward; no expiry;
    cancel to the treasury; empty pool;
  - M+ / T+ promotion, finalize, late reveals and settlement;
  - the 0..1,000,000 score scale, failed rounds, the freeze dodge, the queue;
  - ETH solvency, item 11 scores, gas griefing, the operator gate;
  - clustering, quality classes, normalization and the tie order against JavaScript references
    (and v1's `AggregatorLib` where they must agree): 550 reproducible inputs from a uniform
    generator, built for ties, duplicates and extremes, with coverage counts for each rule and
    brute force over every subset for one-number answers; the overflow bounds and the library's
    input limits; identical extreme reveals don't pull the cluster from an honest majority; ties
    don't follow reveal order; exactly half one-value reveals can't cut a two-outcome round; a full
    one-number round.
- `beacons.test.js`:
  - escrow;
  - the pick and the values, which depend only on the state as of B and B+1 (earlier answers and
    rotations change nothing; frozen, paused, exiting and blocked arbiters are excluded);
  - answers verified like any health answer; the B+1 anchor; the deadline second; concurrent
    rounds; a frozen beacon can exit, after its stage is long over;
  - payment (an unreadable owner goes unpaid), index-order mixing, determinism, completed blocks
    only and same-block ties, the missed quorum and how cheap withholding is;
  - the pool shortage, a jury shortage after the stage, owner changes mid-round, the requester's
    priority, cancel, and a full round with solvency.
- `gas.test.js`: full rounds for item 15's Small, Medium, Large and Jumbo (with and without beacons,
  with one-number answers, and with 20-outcome answers) against a 300-arbiter pool, the per-tx cap, and selection cost against pool size.

## Deploy

`deploy/01_aggregator.js` deploys the two libraries and the aggregator. `02_keeper.js` deploys the
keeper and `JuryBeacons` and wires the three:
- the keeper approves the aggregator and `JuryBeacons`;
- `JuryBeacons` approves the aggregator;
- `setContracts` sets the keeper, beacons and treasury (`TREASURY_ADDRESS`, else the deployer).

`03_config.js` sets the jury for `AGG_CLASS` (small, medium, large, jumbo). The jury is per aggregator,
so each class is a separate deployment. Local networks get a `MockLinkToken` and a `TestToken`.

## Behaviour worth knowing

- **Scores are on the arbiters' 0..1,000,000 scale** (mainnet reveals look like `[970000, 30000]`).
  `spreadFloor` is 30,000, item 14's 3 points.
- **A commit proves the arbiter was up.** An arbiter frozen at round end is not scored, unless it
  committed in that round. Otherwise a silent blocker could ignore its health call, freeze itself and
  escape the −500.
- **Calls to arbiter contracts get a fixed stipend.**
  - `dispatchGas` is 250k: an honest request needs ~125k, or ~175k at the largest payload. `owner()`
    gets 30k.
  - Each tolerated call first checks that the stipend is really available.
  - Settlement reverts rather than skipping the keeper call when it is starved.
  - So neither a gas-burning operator nor a caller's gas limit can drop a slot or the scores.
- **−400 only if commits fell short.** A round that had M commits but timed out because nobody called
  `closeCommits` charges nobody.
- **Hits while blocked** (several in-flight rounds settling at once) restart the score but add no
  offense, so one incident cannot escalate to a ban.
- **A returning key** (after `completeExit`) keeps its scores and offenses. Its classes come from the
  new registration, since its old slots were freed at the exit.
- **Exited slots are reused.** `completeExit` frees the arbiter's slot in each of its classes, and the
  next registration in that class takes it before the list grows, so exits and joins don't lengthen
  the walk. A freed slot costs the walk ~2k gas, not ~8.5k. A draw still reads the state as of B: the
  old occupant has been ineligible (exiting) since `requestExit`, at least the unbonding period
  before its slot was freed, and the new one was not registered at B or was already exiting.
  `freeSlotCount(cls)` and `slotIn(key, cls)` show the state. A node that dies without exiting holds
  its slot until its owner or the keeper owner exits it (below).
- **Unbonding is 2 days by default, owner-set (`setTiming`), never below 2 days.** A day covers the
  latest draw that can read a B from before the exit, and a day covers that round finishing and
  settling, so its penalties land before the stake is refunded. A new period applies to exits
  requested afterwards.
- **No draw more than a day after the request.** `drawJury` reverts with `DrawExpired`, and the round
  can only be cancelled to the treasury (`cancelUnsealed`). Selection also refuses a request block
  more than a day old (`StaleBlock`). Slot reuse and the unbonding floor rely on this bound.
- **Selection visits the class list in random order.** The walk draws random positions without
  repeats (a bitmap of visited positions), so where an arbiter sits in the list does not matter: a
  cartel that registers back to back is drawn no more often than any other set. It stops at the
  shortlist (60) or `maxScan` (400) entries, and after 2 × min(n, `maxScan`) draws it finishes with
  a sweep of the unvisited entries, so it stays bounded and can reach every entry. About 270 gas per
  entry visited, at any pool size. `pickBeacons` uses the same walk.
- **One-number answers.** A reveal may hold a single value. When that is the most common length among
  the counted reveals (the requester's question asks for one number), the cluster is exact: the P
  consecutive values, in sorted order, with the smallest spread (the least trimmed squares location
  estimate). Longer reveals are cut to their first value. Read the scores with
  `getOutcomeScores(aggId, 0)`. Two-number reveals stay two-dimensional, since nothing says the two
  add up. When two lengths are equally common the longer wins (v1 took the shorter), so exactly half
  the reveals can't cut a round's outcomes: shorter reveals are zero-filled instead.
- **Otherwise the cluster is the tightest nearest-neighbour group.** For each counted reveal, its group is it
  and its P − 1 nearest; the cluster is the group with the smallest sum of pairwise distances. v1's greedy rule let identical colluders seed the cluster and pull its
  mean (4 colluders at Jumbo: about 6 points; now about 1). With 2 colluders among Small's or
  Medium's 4 counted reveals no cluster rule helps, an exact one included. A cartel that copies the
  expected consensus still takes more than its share of the bonus under any rule that rewards the
  tightest group. For P = 2 it is v1's closest pair, up to ties.
- **Cluster ties go by a seeded order of the slots, not by who revealed first.** Models often give
  round numbers, so equal scores are common, and under reveal order the bonus would go to the
  fastest. The order is keccak256(sealed hash, slot): fixed at the draw, and random rather than the
  selection order (which favours high-weight arbiters).
- **Commits are bound to the round, in full (items 4 and 5).** The commit is
  `keccak256(abi.encode(aggId, operator, response, salt))`, all 32 bytes, and the reveal carries a
  128-bit salt as `cid:<32 hex>`.
  - An arbiter picks its own salt, so the salt does nothing to stop it opening one commit two ways;
    only the hash does.
  - v1's commit was 128 bits and didn't include the round. A collision found once offline (about 2^64
    hashes) could then be reused in every round, revealing whichever answer suited after seeing the
    earlier reveals.
  - Including `aggId` makes a collision useful for one round only. The full 32 bytes put one out of
    reach (about 2^128).
  - The reveal request carries the full commit hash as `2:<64 hex>`.
- **The finalizing reveal pays for clustering.** The N-th counted reveal's `fulfill` runs it. At
  Jumbo: 1.30M gas with one-number answers, 2.5–2.6M with two-outcome vectors, 6.9M at the maximum
  20 outcomes (all measured); 0.54M at Small. The arbiter node's job gas limit must cover the largest
  answer a class allows, with margin, or that reveal reverts and is lost, and so does every later
  one. `setConfig` caps N at 40 (at 20 outcomes, clustering 40 reveals is about 8M gas) and
  `setParams` caps `spreadFloor` at 1e34 (a larger floor would be cut when stored, or overflow).
- **Fewer than K eligible arbiters at B:** the draw fails the round and refunds (no jury could be
  drawn, so it is no re-roll). Slots never repeat: a repeated arbiter would vote and be charged twice.
- **`promote` pays its caller 1 x eff** (`promoteRewardFees`, in the escrow), so third parties call it
  and a requester cannot withhold it. A round that closed but was never promoted sends its unspent
  prepay to the treasury, not back to the requester, so aborting a promotion draw buys no refund.
- **Promoted arbiters always get `revealWindow`** (120 s) after `promote`, which extends the deadline if
  needed: calling `promote` late cannot make honest arbiters miss their reveals.
- **Rewards are fixed per round at request**, as is the beacon quorum, so an owner change before the
  draw cannot break the escrow arithmetic.
- **Freeze is judged at round end** (the deadline), not at settlement: an arbiter that recovers before
  settlement is not charged for the outage. Only an answer to an outstanding call counts.
- **Stake eligibility is checkpointed** (`F_UNDERSTAKED`), so a top-up between B and the draw cannot
  re-roll it. A new `stakeRequirement` applies to an arbiter at its next stake change.
- **A frozen arbiter can exit.** The operator owner or the keeper owner can run `requestExit` and,
  2 days later, `completeExit` even with a health call unanswered. A freeze exists to get a broken
  arbiter fixed or removed, and the dropped call can't matter: every round or beacon stage that
  could have called the arbiter read a B from before its `requestExit`, so it ended long before. So
  the keeper owner can clear dead arbiters and free their slots. The stake goes to the operator's
  owner.
- **Every answer is recorded.** Each health answer adds a head entry with its block and time; entries
  are never overwritten. A rotation records the revealed value, then the new head.
- **A sealed round nobody drew** (for example a draw too large for one transaction, or a beacon stage
  nobody concluded) can be cancelled to the treasury after a day, and can no longer be drawn.
- **`owner()` is read with a low-level call** that copies only one word. A malformed answer skips the
  slot instead of reverting the draw, and a huge return buffer costs the draw no more than the 30k
  stipend.
- **No refund for an abandoned commit phase.** A round that had M commits but was never promoted
  sends its unspent prepay to the treasury. That covers a phase that was closed but never promoted,
  and one nobody closed after T+. Otherwise a requester that dislikes the jury could skip
  `closeCommits`, with one colluding juror not committing, and get a re-roll for the base fees.
- **A late close leaves time to promote.** A commit that closes the phase near the deadline extends
  it to at least 30 s after the close.
- **Credit covers only what `msg.value` does not.** Any excess value returns to credit, so the escrow
  is exactly `maxTotalFee`.
- **The fee floor (item 8).** The request carries `minFee` next to the ceiling `maxFee`.
  - **Payment.** Each juror is paid `max(posted fee, minFee)`, and its bonus is B times that. So
    every attempt costs at least K × `minFee`, and with a cluster about B × P × `minFee` more.
    `BasePayment` and `getSlot(...).fee` show the amount paid; the posted fee is the keeper's.
  - **Eligibility uses the ceiling only**, as before. The floor may exceed the ceiling and the
    global `maxOracleFee`: the ceiling keeps expensive arbiters out of selection, and doesn't limit
    what a requester chooses to pay.
  - **Beacons get the floor too.** A used beacon is paid `max(eff, minFee)`, like a juror.
  - **Rewards are not on the floor.** The draw and promote rewards stay on the ceiling, so a
    requester that draws its own round gets none of the floor back.
  - **The escrow** is `max(eff, minFee) × (K + B×P [+ quorum]) + eff × (draw + promote rewards)`. It
    must fit in 88 bits, the narrowest credited total; otherwise the request reverts `BadInput`.
  - **Selection scores the fee the requester pays.** Below the floor every arbiter costs the same,
    so a near-zero posted fee wins no extra weight.
  - **The base cost.** A fee at or below `estimatedBaseCost` now gets the full fee boost. v1 gave it
    none, while a fee just above it got nearly the full boost.
  - **Who sets it.** The floor deters only a requester who can't choose it. In the bounty program
    that is the bounty creator, through BountyEscrow; it gives no protection to a submitter calling
    the aggregator directly.
- **The settlement-queue walk is bounded** at 8 steps per round a request may settle, counting rounds
  already settled with `settle()`, so holes in the queue cannot make requests run out of gas.
- **Only the arbiter's owner can top up its stake** (a top-up re-applies the current requirement).

## Beacons (item 9's flag; Jumbo)

- **Flag and escrow.** The requester sets `withBeacons` in the request. The escrow adds the quorum
  (2) in fees: `maxTotalFee(maxFee, minFee, true)`. A used beacon is paid as a juror: the ceiling,
  or the fee floor if that is higher.
- **The pick.** The first `drawJury` seals `blockhash(B+1)` and asks `JuryBeacons` to start. The keeper
  picks 4 arbiters from the request's class, entirely from its state as of B: registered, and not
  paused, banned, exiting, under-staked, blocked or frozen. Each gets a health call. Nothing after B
  changes the pick: not who starts the stage, nor when. The stage picks at least the round's quorum,
  even if the owner has lowered `polled` since the request.
- **The values.** A beacon call is a health call, answered like any other with the arbiter's next
  chain value (`answerHealthCall`). The keeper verifies the answer against the head. The beacon value
  is the arbiter's first value revealed after block B+1 (`keeper.revealAfter`): normally its answer to
  the beacon call, or its answer to an earlier call if it answered one after B+1.
  - The value was fixed by the end of B+1, so a beacon chooses only when to answer. A later rotation
    reveals that value first, so it cannot choose the value.
  - The anchor is B+1, not B, so an honest answer included in block B+1 does not give its value to
    whoever builds that block.
  - Answering in time is the only way to get a value counted. A beacon that withholds stays
    unanswered, and is frozen from the 60 s call deadline until it answers. It can answer just after
    the 120 s deadline, so withholding costs it about a minute (see Not implemented).
  - Only its operator's owner or an authorized sender can answer, so the answer times are the
    beacons' own doing, not a relayer's.
  - The node needs no beacon-specific code.
- **The draw.** Once 2 values are in, a second `drawJury` draws with
  `keccak256(aggId, blockhash(B+1), mix)`. The first 2 reveals by block are used, with ties going to
  the lower beacon index. `mix` chains them in beacon-index order, so arrival decides which values are
  used but not their order. Only completed blocks count, so transaction order within a block cannot
  change the result, and a ready result is final. The 2 used beacons are paid one fee each, to their
  operator owner, which is read with a 30k stipend (an unreadable owner goes unpaid). The requester's
  30 s draw priority runs from the second value, or from the start if both were in already.
- **Missed quorum.** If fewer than 2 values are revealed within 120 s of the start, the next
  `drawJury` ends the round with no result:
  - the beacon that answered in time is paid;
  - the rest of the prepay goes to the treasury, since a refund would be a free re-roll;
  - silent beacons are frozen by their health call, and are not scored.
- **Pool shortage.** If fewer than 2 candidates qualify, the round fails with a refund, as for an empty
  jury pool.
- **Jury shortage after the stage.** If the jury can't be drawn once the values are in, the beacons
  are paid. The rest is refunded only if selection walks the whole class list (`keeper.scansAll`), so
  the failure did not depend on the seed. Otherwise it goes to the treasury: a beacon could choose by
  its timing between a jury and a refund.
- **Cost.** The stage costs the requester ~0.39M gas to start. A beacon's answer is an ordinary health
  answer (123k). Jumbo with beacons costs about $0.53 a round in gas (all transactions, 0.006 gwei)
  against $0.52 without.
- **Owner settings.** `JuryBeacons.setParams(polled, quorum, timeout)`. A quorum equal to `polled` is
  item 9's stricter variant (all values required), under which one silent beacon forces a no-result
  round.
  - Keep the keeper's `callDeadline` below `timeout`, or a withholding beacon is never frozen.
  - `polled`, and the keeper's `maxScan` and `callDeadline`, are read when the stage starts, so an
    owner change between B and the start alters the pick.
  - Don't swap the beacon contract (`setContracts`) while a round is in its beacon stage. That round
    would then read the new contract, never become ready, and could only be cancelled to the
    treasury after a day.

## Not implemented

- **Per-class configuration.** K/M/N/P, T+ and the timeout are per aggregator: one deployment per
  class (item 15).
- **The abstain dodge.** A cartel that blocks by never committing and also ignores its health call is
  frozen at round end and so escapes the −400. Being frozen costs it only being unselectable until it
  answers. The simulator lets colluders always answer calls, so it does not model this. Options: a
  cooldown after a late answer, or counting freezes in failed rounds as offenses.
- **Withholding is cheap for a beacon.** A beacon that stays silent, forcing a no-result round or
  choosing among seeds, can answer just after the deadline. It is then frozen for about a minute, with
  no score change.
  - With 2 of 4, forcing a no-result round takes 3 cartel seats; with all 4 required, it takes 1.
  - Option: −400 timeliness to each beacon whose value was not in when the stage missed its quorum,
    as Table 1 does for a missing commit (deferred, 2026-11-19).
- **Jumbo draw size.** Jumbo's draw uses 12.3–13.2M of the 16.8M per-transaction cap, depending on
  the jury, with the operator gate. Each juror whose operator burns its whole stipend adds about 98k.
  With beacons, 33 such jurors of 50 still fit and 35 do not; without, 35 fit and 38 do not (measured
  with the test operator, 2026-11-20). The round can then only be cancelled to the treasury after a
  day. With selection in random order, a 15% cartel gets 34 seats with probability about 3 × 10⁻¹⁹ per
  round, so the draw stays one transaction.
- **`setContracts` does not check that the beacon contract uses the same keeper** (its keeper is
  immutable). `deploy/02_keeper.js` deploys them as a pair.
- **Integrations.** BountyEscrow, the arbiter node and the operations scripts still speak v1 (see
  `MIGRATION.md`).
