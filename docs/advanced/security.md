# Security Model

The v2 threat model: who can do what, how the jury is kept out of anyone's hands, what commit-reveal binds, what collusion can still do at each jury size, what applications must add on top, and how ETH is kept safe.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch ([`reputationBasedAggregator/contracts`](https://github.com/verdikta/verdikta-dispatcher/tree/beacon/reputationBasedAggregator/contracts)), their contract notes, and the design record [TODO.md](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/TODO.md) (items cited by number). **The v2 contracts are not audited and not deployed.** The last whole-contract review was on 2026-11-19; the random-order walk, slot reuse, exits while frozen, the fee floor, the commit format, and the committers' shares and arbiter pool that replaced the treasury on 2026-11-25 have not been reviewed independently since (TODO, "What's left"). Gas figures below were measured at optimizer runs 200; the contracts build with 20 runs since 2026-11-25, to fit the size limit, so re-measure any figure you rely on. The figures for collusion come from the models in items 12 to 15, which assume 300 eligible arbiters, 15% colluding, and honest score noise of SD 3; the measured noise is higher (SD-equivalent 7.1), and v1's pool had 32 arbiters, so treat them as targets to re-measure, not guarantees.

## Trust and Access Control

### Owner Powers

All v2 contracts use OpenZeppelin's `Ownable`. The owner is trusted not to break rounds; it cannot take anyone's ETH.

**ReputationAggregator:**

- `setLimits(maxJury, maxTimeout, tPlus)`: bounds on a request's jury. No timeout may exceed one day, whatever `maxTimeout` says (`AggregatorLib.MAX_TIMEOUT`), and a round keeps the T+ of its request.
- `setParams(bonusMult, settlePerReq, dispatchGas, spreadFloor, maxOracleFee)`: bonus multiplier (at most 20), settlement budget, dispatch stipend (100k to 2M), spread floor, fee ceiling.
- `setRewards(drawFees, priority, promoteFees, revealWindow)`: draw and promote rewards, the requester's draw priority, the reveal window. Applies to new requests only.
- `setContracts(keeper, beacons)`: rounds in flight call the new contracts, so swap the keeper only when no round awaits settlement and the beacon contract only when no round is in its beacon stage. It does not check that the beacon contract uses the same keeper.
- `pause()` / `unpause()`: stops new requests only.
- `withdrawEthFor(payee)`: the owner can trigger a payee's withdrawal, which always pays the payee. It reverts for `payee` = address(0), the arbiter pool.

There is no treasury, and the owner has no address to which forfeits are paid: they go to the arbiter pool, which only the pool payouts to registered arbiters can empty.

**ReputationKeeper:** `setApproved` (which contracts may select and report outcomes), `setPoints`, `setTiming`, `setPenalties`, `setSelection`, `setStakeRequirement` and `sendHealthCalls`. The keeper owner can also act for any arbiter where its operator's owner can: `registerArbiter`, `setPaused`, `setFee`, `topUpStake`, `requestExit` and `completeExit`. So the keeper owner can pause or exit any arbiter (the stake still goes to the operator's owner).

**JuryBeacons:** `setApproved(aggregator, ok)` and `setParams(polled, quorum, timeout)`.

v2 has no manual block, no reputation reset and no way to move stake except the burns (to the token's `burn` or the dead address) and the exit refund (to the operator's owner).

### The Operator Gate

Each `ArbiterOperator` keeps a list of keepers (`addReputationKeeper`, operator owner only) and emits a request only if one of them answers `isContractApproved(requester)` with true, both before emitting and again at fulfillment. The v2 keeper keeps that v1 function name. Each operator owner must call `addReputationKeeper(<v2 keeper>)`; an operator whose list is empty accepts every requester, so keep at least one keeper on it. Fulfillment is restricted to the operator's authorized senders (the Chainlink node's keys).

### Arbiter Registration

`registerArbiter(oracle, jobId, fee, classes, chainHead)` requires the caller to be the keeper's owner or the operator's `owner()`, the operator to have code, a fee above 0, 1 to 5 classes, and the stake (100 VDKA). Unlike v1 it does not check the operator's ERC-165 interface. Health answers come from the operator's owner or one of its authorized senders, so nobody else can answer, or withhold an answer, for an arbiter.

## The Jury Cannot Be Chosen

### Two-Phase Draw

The request is recorded in block B; the jury is drawn from block B+2 with `keccak256(aggId, blockhash(B+1))` and the keeper's state as of B (TODO item 9). See [Oracle Selection](oracle-selection.md#randomness).

- **Nobody can predict the jury when signing the request**, and nobody can re-roll it: the draw depends only on the sealed hash and the state as of B, so who draws and when does not matter. Everything selection reads is checkpointed by block, so a fee change, a top-up, a pause or a registration after B changes nothing.
- **No refund buys a re-roll.** A requester who dislikes its jury could otherwise abort and try again for the price of the base fees. So no way of abandoning a drawn round returns the unspent prepayment. A round that had M commits but was never promoted (closed or not) shares it equally among the slots that committed (`CommitPayment`): they did the work, and anyone could have promoted. A missed beacon quorum, a beacon round whose jury could not be drawn when the result depended on the seed, and a round never drawn in time (`cancelUnsealed`) send it to the arbiter pool, as does the indivisible remainder of the committers' shares. A refund comes back only where no jury existed to dislike (none eligible, or too few beacon candidates) or the jury itself failed to deliver (fewer than M commits, fewer than N reveals).
- **The promotion is drawn the same way**, from `blockhash(C+1)` after the commit phase closes at block C. The `promote` caller is paid 1 × the ceiling, so third parties call it and a requester cannot withhold it; promoted arbiters always get `revealWindow` (120 s) after `promote`, so a late `promote` (or a colluder sending the M+-th commit late) cannot make honest arbiters miss their reveals.
- **The draw reward** (2 × the ceiling) goes to the requester only within 30 seconds; after that to anyone, so rounds get drawn.
- **The arbiter pool cannot be steered back.** Each draw that draws a jury pays an eighth of the pool, at most its own base fees, to one registered arbiter picked by the keeper's `poolPayeeAt` from that draw's seed and the registry as of the request block. The seed is fixed by a block hash after the request and is the same whoever draws, and a forfeiting round never picks its own winner, so a requester cannot route its own forfeit to an arbiter it controls. Grinding, by making many requests to win more payouts, pays base fees and rewards each time for an eighth of the pool at most, which costs more than it wins. The pick skips paused, banned, exiting and understaked arbiters, tries twice at most, and runs under an 80,000-gas cap with its failure caught, so an operator's `owner()` cannot make the draw fail. A committer share or a pool payout gives an arbiter no say over a result.

What is left is the block builder. Whoever builds B+1 (on Base, the sequencer) sees `blockhash(B+1)` first. A sequencer bribed to seat a cartel chooses among the blocks it could build; item 15 models that as a choice of 256 seeds and a $1,000 bribe per attempt, and that is what caps Small and Medium near $1,000 bounties.

### Beacons

With `withBeacons`, the jury's seed also mixes in hash-chain values revealed by 4 beacon arbiters (the first 2 used). See [Oracle Selection](oracle-selection.md#beacons) for the mechanics. Why they resist steering ([JuryBeacons](../contracts/jury-beacons.md)):

- The beacons are picked from `blockhash(B+1)` and the state as of B, and each beacon's value is the next one after its head at the end of B+1, so the values were fixed before anyone but the builder of B+1 knew the pick. No rotation can change them; a beacon can choose only when to reveal, or not to.
- Anchoring at B+1 rather than B means an honest answer included in B+1 does not hand its value to that block's builder.
- The result reads only completed blocks, so transaction order within a block cannot change it, and a ready result is final. Values are mixed in beacon-index order, so arrival decides only which are used.

The cost: colluding beacons choose among a few seeds by timing their reveals (1, 2, 4 or 6 seeds with 0 to 4 cartel beacons), and can force a no-result round by withholding. Withholding costs score: after the 120 s deadline anyone may call `JuryBeacons.chargeSilent`, and each beacon whose value was not in by then loses 400 timeliness (a repeat blocks the key). Beacons must also be fee-eligible for the round, like jurors, so a swarm of keys priced above every ceiling (no juror risk) holds no beacon seats. With 2 of 4 used, forcing no result takes 3 cartel beacons; with all 4 required, it takes 1. Beacons raise Jumbo's sequencer limit from about $25K to $164K but lower the share of good work passing while a cartel blocks from 86% to 80% per round, which is why only Jumbo uses them.

### Hash Chains and the Re-Sync

Beacon values and health answers are hash-chain preimages: the node commits to `H^n(seed)` at registration and reveals one preimage per answer. The keeper records every head entry with its block and time and never overwrites them.

A node whose chain does not match the keeper's head (registered with head 0 from a browser, or its chain files lost) can **re-sync**: an answer whose value does not hash to the head becomes the new head, and the arbiter is frozen until it answers a call sent after the re-sync. Why this is safe:

- **A re-synced value is never a beacon value.** `revealAfter` takes only a value that hashes to the head before it, so a beacon that re-syncs after B+1 counts as having withheld.
- **It gives no choice of value.** The next value was fixed at the re-sync, as at a rotation.
- **It gives no dodge the arbiter does not already have.** The freeze is one it could get by not answering, and it starts at the re-sync, not before: a round that ended earlier is judged as it was. A rotation to a different head still needs a valid preimage (`BadPreimage`).
- The node must re-sync onto a **fresh** chain. Reusing a chain whose values were already revealed would make its beacon values predictable.

## Commit-Reveal Binding

TODO items 4 and 5. The commit is

```
keccak256(abi.encode(aggId, operator, response, salt))      all 32 bytes, salt 128 bits
```

sent as the commit word, and the reveal carries `response` with the CID field `cid:<32 hex salt>`. The aggregator recomputes the hash with `msg.sender` (the operator that fulfils) and the round's `aggId`.

- **An arbiter chooses its own salt, so only the hash stops it opening one commit two ways.** v1's commit was the first 16 bytes of a SHA-256 without the round: a collision found once offline (about 2^64 hashes) could be reused in every round to reveal whichever answer suited after seeing the others. Including `aggId` makes a collision useful for one round only, and the full 32 bytes put one out of reach (about 2^128).
- **The operator address** in the hash stops an arbiter copying another's commit.
- **Commits are hidden** until promotion, and promoted arbiters are drawn at random from all commits, so committing first wins nothing.
- **A bad reveal is ignored silently**: wrong hash, malformed `cid:salt`, more than 20 values, a CID longer than 133 bytes, or a second reveal. It uses up that juror's single reveal request: there is no retry. Only `RevealReceived` is emitted, for accepted reveals.
- **Scores are capped** at 1e34 per value, and at most 20 values per reveal, so aggregation cannot overflow.

## Collusion and Jury Size

Collusion is limited by the jury's size and shape, not removed. The rules that matter, and what TODO items 10, 12, 13, 14 and 15 found:

- **Random seats.** The keeper walks the class list in random order, so a cartel's share of seats follows its share of the eligible pool (reputation can at most double an arbiter's weight). A 15% cartel gets 34 of Jumbo's 50 seats with probability about 3 × 10⁻¹⁹ per round.
- **Random promotion.** M+ / T+ with a draw from all commits means colluders can't win promotion by committing first. Item 15 calls this a launch requirement for Medium and Large.
- **The cluster.** For one-number answers the cluster is exact; for vectors it is the nearest-neighbour group, which stops identical colluders from seeding the cluster and pulling its mean (4 colluders at Jumbo: about 6 points under v1's greedy rule, about 1 now). But **with 2 colluders among Small's or Medium's 4 counted reveals no cluster rule helps**, and a cartel that copies the expected consensus takes more than its share of the bonus under any rule that rewards the tightest group (23.5% of Jumbo bonus slots against a fair 14.8%; an open decision).
- **Reputation** blocks arbiters that fail rounds or answer far from the median, but it never touches a cartel voting plausibly close to the threshold. So the bounty limits come from the jury configuration.

The bounty program's presets were sized for this (item 15): Small (6/5/4/3) and Bondless Small for bounties up to about $100 and $25, limited by repeated submissions; Medium (8/5/4/3) up to about $1,000, limited by the sequencer; Large (21/16/13/10) up to $10,000; Jumbo (50/38/27/17 with beacons) up to $100,000. Beyond about $1,000 a class must be Large: with 6 to 8 jurors a bribed sequencer nearly always finds a seed that seats enough colluders. These figures are break-evens with no safety margin, and they depend on the application-level rules below.

### Thin Pools and Self-Chosen Juries

If fewer arbiters are eligible than K, the draw repeats them (slot k holds pick k mod m) instead of failing; it refuses only at zero eligible. Repeats also happen in a deep pool if the owner lowers `shortlistSize` below a pending round's K (K is checked against it only at request time), or if the walk's `maxScan` entries (400, freed and ineligible ones included) hold fewer than K eligible arbiters.

A repeated arbiter is paid and scored per slot, and **one arbiter can decide a round alone**. A requester who picks a class, or a fee ceiling, that only its own arbiter fits gets a jury of one operator: P ≥ 2 then does not mean two independent arbiters, and a Q-of-N count on `getOutcomeScores` counts slots, not arbiters. Applications must not let the party who benefits from a result choose the class or the ceiling freely, and should check the keeper's `eligibleCount(class, maxFee)` before trusting a round.

## What Applications Must Add

The aggregator returns a result and every counted juror's score; what a result is worth is the application's business. The bounty program's rules (TODO items 8 and 12) are the model:

- **Bonds.** The protocol has no bonds. The bounty program has the hunter post a bond, forfeited to the creator only on a hard fail (fewer than R of N scores at the threshold) and returned on a pass, a soft fail or no result. A bond roughly sized `V × (bad-work pass rate) ÷ (bad-work hard-fail rate)` makes forcing uneconomic; R below the pass quota Q keeps a blocking cartel from costing an honest hunter the bond.
- **Q-of-N, not the mean.** Read `getOutcomeScores(aggId, outcome)` and pass at Q of N scores at the threshold. With re-runs on a soft fail or no result (up to 6 rounds), a blocking cartel only costs re-runs.
- **A fee floor the requester cannot choose.** `minFee` makes each attempt cost at least K × floor, which deters re-submitting until a favourable jury appears, but only if the party submitting cannot lower it. In the bounty program the creator sets it.
- **Who picks the jury and class.** The same reasoning: the creator, not the hunter.
- **Drive the round.** Nothing guarantees a third party sends `drawJury`, `closeCommits`, `promote` or `settle`. An application should send them; a round never drawn within a day loses its whole prepayment to the arbiter pool, and a round left unpromoted pays its unspent prepayment to the committers.

## Settlement and Exits

Scores are applied at settlement, after the deadline, in one keeper call per round. Anyone may call `settle(aggId)`; each new request also settles due rounds, in queue order, until `settlePerRequest()` × its own K slots are spent. The last round settled may overshoot the budget by at most its own K, so the first due round is always settled and a big round at the head cannot stall the queue. The walk stops at the first round not yet past its deadline: a long-timeout round at the head holds back shorter ones behind it, so settlement can need an outside caller. The result itself is readable from finalization and does not wait.

Exits are bounded so penalties land: `requestExit` makes an arbiter ineligible at once and `completeExit` refunds the stake only after the unbonding period (at least 2 days: a day for the latest draw that can read a B from before the exit, and a day for that round to finish and settle). Blocks and bans still apply during unbonding, and a blocked arbiter cannot complete its exit. But an arbiter that completes its exit before a round it served in is settled escapes that round's points, because `applyOutcomes` skips unregistered keys. Settle rounds promptly.

The −400 for not committing applies only to a dispatched slot, when the round failed for lack of commits and at least half of M committed; a round with fewer commits charges nobody, since that failure is the request's (one every honest arbiter refuses or cannot fetch, perhaps with one colluding commit) or a shared outage's. The freeze is judged at the deadline, and a frozen arbiter that did not commit is not scored. A cartel member that never commits and ignores its health call therefore escapes the −400 (the abstain dodge, TODO item 14; open).

## ETH Escrow and Withdrawals

- **Prepayment.** The requester sends the worst case, `maxTotalFee(maxFee, minFee, withBeacons, K, P)`. Credit covers only what `msg.value` does not and any excess returns to credit, so the escrow is exactly the quote and a forfeit to the committers or the pool never takes more than the round's prepay. A quote that does not fit in 88 bits reverts `BadInput()`.
- **Ledger, not transfers.** Fees, bonuses, rewards, beacon payments, committer shares, pool payouts and refunds are entries in `ethOwed`; the arbiter pool is `ethOwed(address(0))`, which no withdrawal can reach. No round step sends ETH, so a payee cannot block a round.
- **One way out.** ETH leaves only in `_withdrawTo(payee)`, through `withdrawEth()` and `withdrawEthFor(payee)`: balance zeroed before the send, `nonReentrant`, always to the credited address. A payee that cannot receive ETH (`EthTransferFailed()`) only blocks its own withdrawal.
- **Fixed rates per round.** The bonus multiplier, the reward counts and the beacon quorum are stored at request, and each juror's paid fee at the draw, so `received ≥ baseFees + bonuses + rewards` always holds (the tests check solvency on every path).
- **Payee fixed at the draw.** Each slot's payee is the operator's `owner()` read at the draw with a 30k-gas stipend, copying one word. A malformed or gas-burning `owner()` skips that slot (`SlotSkipped`, reason 1) instead of reverting the draw.
- **Pause** stops new requests only. Draws, commits, reveals, settlement and withdrawals keep working.

## Gas Safety

- **Fixed stipends.** Each oracle request is dispatched through a self-call with `dispatchGas` (250k; an honest request needs about 125k, 175k at the largest payload). Every tolerated call first checks that its stipend is really available (`OutOfGas()` otherwise), and settlement reverts rather than skipping the keeper call when starved, so neither a gas-burning operator nor a caller's tight gas limit can drop a slot or the scores.
- **Bounded walks.** Selection visits at most `maxScan` entries; the settlement queue at most `settlePerRequest × 8` entries per request, already-settled ones included.
- **The finalizing reveal pays for clustering.** At Jumbo it costs 1.3M gas with one-number answers, about 2.6M with two outcomes and 6.9M at 20 outcomes (measured at optimizer runs 200; the contracts build with 20 runs since 2026-11-25, which can cost somewhat more). An arbiter node's job gas limit must cover the largest answer its classes allow, or that reveal reverts and is lost, and so is every later one.
- **Jumbo's draw** uses 12.3 to 13.2M of the 16.8M per-transaction cap. Each juror whose operator burns its whole stipend adds about 98k; with beacons 33 such jurors of 50 still fit (measured with the test operator at optimizer runs 200, before the pool payout was added; to be re-measured with a real operator, at the current 20 runs, with the pool payout's call of up to 80k gas). A draw that cannot fit can only be cancelled to the arbiter pool after a day.

## Legacy Contracts

ReputationSingleton and SimpleContract are legacy, LINK-paid and written for the v1 keeper. SimpleContract is for development only: `setResponseTimeout()` and `withdrawLink()` have no access control, it has no reentrancy guard and no commit-reveal, and it uses a single fixed oracle. **Do not use SimpleContract for anything of value.** See their pages under [Contracts](../contracts/reputation-singleton.md).

## Upgrade Considerations

None of the contracts use proxies. v2 is a redeploy of v1, not an upgrade: a new keeper, aggregator and `JuryBeacons`, every arbiter registering again, and every operator owner adding the v2 keeper. ETH credits stay in the aggregator that holds them: payees and requesters withdraw from the old contract with `withdrawEth()`. See [MIGRATION.md](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/MIGRATION.md) and the [Deployment Guide](../deployment/index.md).
