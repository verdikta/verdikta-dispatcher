# Reputation aggregator v2 (TODO items 9, 11, 14 and 15)

The v2 contracts: the two-score reputation design (item 14), the two-phase request with optional
beacons (item 9), the per-arbiter score getter (item 11) and item 15's class configurations. They
replaced the v1 contracts in this folder on 2026-11-18. Not audited and not deployed yet.

The deployed v1 code is tag `aggregator-v0.1.0`. An untracked copy of the v1 folder sits in `v1/`
for comparison (see `v1/SNAPSHOT.md`). `MIGRATION.md` lists what changes for BountyEscrow, the
arbiter node, the operator contract and the scripts.

| Contract | Role |
|---|---|
| `ReputationKeeper` | Arbiter registry, stake, unbonding, burns, two scores (Table 1 via `applyOutcomes`, −400 for a live non-committer when the round failed for lack of commits), blocks / bans / 90-day decay (Table 2), hash-chain health calls (each reveal recorded with its block and time), freeze and chain rotation, reputation-weighted selection with a bounded walk, and the beacon pick. Selection state is checkpointed by block, so a draw reads the state as of the request block (item 9). Answers `isContractApproved`, which every deployed `ArbiterOperator` uses to gate requests |
| `ReputationAggregator` | Two-phase request (escrow at block B; `drawJury` from B+2, seeded by `blockhash(B+1)`, read through EIP-2935 after 256 blocks; 2 x fee draw reward; `sealSeed`, `cancelUnsealed`), the optional beacon stage, M+ / T+ promotion (closes at the M+-th commit or after T+ with at least M; `promote` from C+2 draws M of all commits), late reveals, settlement after the deadline with one batched keeper call, a settlement queue drained by new requests, `getOutcomeScores` (item 11) |
| `JuryBeacons` | Item 9's beacon flag, kept out of the aggregator for bytecode: picks 4 beacons through the keeper (which sends each a health call), reads their answers from the keeper, and reports the mix of the first 2 |
| `ScoringLib` | External library: finalization in one call (cluster, mean, quality classes), the promotion draw, and a faster, result-identical version of v1's greedy clustering |
| `AggregatorLib` | External library: v1's helpers plus the commit payload builder and a one-call CID/salt parser |
| `test/TestOperator` | Gas-faithful stand-in for Chainlink's Operator (the real one pins solc 0.8.19), with `ArbiterOperator`'s keeper gate (on by default in the tests). `setBomb` makes it burn all gas |
| `test/MockHistory` | Stand-in for the EIP-2935 history contract, installed at its address (Hardhat's stub reverts) |

## Run

```
npx hardhat test                       # all 91 tests, ~3 min
npx hardhat test test/gas.test.js      # gas and cost report per class
npx hardhat test test/beacons.test.js  # the beacon stage
AGG_CLASS=jumbo npx hardhat deploy --tags aggregator,keeper,config   # in-process deploy check
```

`hardhat.config.js` loads the deploy secrets like v1's config does. The tests use only the in-process
network. `deploy.sh` runs the same three tags against `NET` (default `base_sepolia`).

Tests:
- `size.test.js`: EIP-170 / 3860 limits.
- `keeper.rules.test.js`: Tables 1 and 2, decay, burns, unbonding, re-registration, freeze,
  same-second calls, chain rotation, selection, the operator gate.
- `aggregator.flow.test.js`:
  - item 9: draw timing; determinism whoever draws and whenever; EIP-2935 reads; reward; no expiry;
    cancel to the treasury; empty pool;
  - M+ / T+ promotion, finalize, late reveals and settlement;
  - the 0..1,000,000 score scale, failed rounds, the freeze dodge, the queue;
  - ETH solvency, item 11 scores, gas griefing, the operator gate and clustering equivalence.
- `beacons.test.js`:
  - escrow;
  - the pick and the values, which depend only on the state as of B (earlier answers and rotations
    change nothing; frozen, paused, exiting and blocked arbiters are excluded);
  - answers verified like any health answer; a live beacon cannot keep its value back;
  - payment (an unreadable owner goes unpaid), index-order mixing, determinism, completed blocks
    only and same-block ties, and the missed quorum;
  - the pool shortage, the requester's priority, cancel, and a full round with solvency.
- `gas.test.js`: full rounds for item 15's Small, Medium, Large and Jumbo (with and without beacons)
  against a 300-arbiter pool, the per-tx cap, and selection cost against pool size.

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
- **A returning key** (after `completeExit`) keeps its scores, offenses and class memberships.
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
- **Every answer is recorded.** Each health answer adds a head entry with its block and time; entries
  are never overwritten. A rotation records the revealed value, then the new head.
- **A sealed round nobody can draw** (for example a draw too large for one transaction, or a beacon
  stage nobody concluded) can be cancelled to the treasury after a day.
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
- **The settlement-queue walk is bounded** at 8 steps per round a request may settle, counting rounds
  already settled with `settle()`, so holes in the queue cannot make requests run out of gas.
- **Only the arbiter's owner can top up its stake** (a top-up re-applies the current requirement).

## Beacons (item 9's flag; Jumbo)

- **Flag and escrow.** The requester sets `withBeacons` in the request. The escrow adds the quorum
  (2) in fees: `maxTotalFee(maxFee, true)`.
- **The pick.** The first `drawJury` seals `blockhash(B+1)` and asks `JuryBeacons` to start. The keeper
  picks 4 arbiters from the request's class, entirely from its state as of B: registered, and not
  paused, banned, exiting, under-staked, blocked or frozen. Each gets a health call. Nothing after B
  changes the pick: not who starts the stage, nor when.
- **The values.** A beacon call is a health call, answered like any other with the arbiter's next
  chain value (`answerHealthCall`). The keeper verifies the answer against the head. The beacon value
  is the arbiter's first value revealed after B (`keeper.revealAfter`): normally its answer to the
  beacon call, or its answer to an earlier call if it answered one after B.
  - The value was fixed at B, so a beacon chooses only when to answer. A rotation after B reveals that
    value first, so it cannot choose the value.
  - Answering is revealing, so a live beacon cannot keep its value back. A beacon that withholds
    leaves its call unanswered and is frozen like any silent arbiter.
  - Only its operator's owner or an authorized sender can answer, so the answer times are the
    beacons' own doing, not a relayer's.
  - The node needs no beacon-specific code.
  - A value becomes public once its arbiter answers any health call after B. Only a sequencer that
    sees such an answer while building B+1 could use that.
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
- **Cost.** The stage costs the requester ~0.39M gas to start. A beacon's answer is an ordinary health
  answer (123k). Jumbo with beacons costs about $0.57 a round in gas (all transactions, 0.006 gwei)
  against $0.56 without.
- **Owner settings.** `JuryBeacons.setParams(polled, quorum, timeout)`. A quorum equal to `polled` is
  item 9's stricter variant (all values required).

## Not implemented

- **Per-class configuration.** K/M/N/P, T+ and the timeout are per aggregator: one deployment per
  class (item 15).
- Items 4 (128-bit salt) and 5 (Keccak instead of SHA-256 for commits): they change the node protocol.
- **The abstain dodge.** A cartel that blocks by never committing and also ignores its health call is
  frozen at round end and so escapes the −400. Being frozen costs it only being unselectable until it
  answers. The simulator lets colluders always answer calls, so it does not model this. Options: a
  cooldown after a late answer, or counting freezes in failed rounds as offenses.
- **Silent beacons are only frozen.** A beacon that stays silent, forcing a no-result round or
  choosing among seeds, is frozen like any arbiter that misses a health call, with no score change.
  Option: −400 timeliness to each beacon that stayed silent when the stage missed its quorum, as
  Table 1 does for a missing commit.
- **Jumbo draw size.** Jumbo's draw uses ~13.6M of the 16.8M per-transaction cap, with the operator
  gate. A gas-burning operator adds at most ~140k (the stipend less an honest dispatch), so about 23
  such jurors of 50 would make the draw too large. The round can then only be cancelled to the treasury
  after a day.
- **`setContracts` does not check that the beacon contract uses the same keeper** (its keeper is
  immutable). `deploy/02_keeper.js` deploys them as a pair.
- **Integrations.** BountyEscrow, the arbiter node and the operations scripts still speak v1 (see
  `MIGRATION.md`).
