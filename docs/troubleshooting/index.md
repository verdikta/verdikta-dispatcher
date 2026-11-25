# Troubleshooting Guide

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch: [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol), [`AggregatorLib.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/AggregatorLib.sol) and [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationKeeper.sol). v2 is not deployed yet. The entries are about the ReputationAggregator, which is paid in ETH: a requester needs no LINK and approves no token. For the v1 aggregator's errors (`NotTimedOut()`, the keeper's "No active oracles…" string) see the `aggregator-v0.1.0` tag.

This section covers common issues when working with the Verdikta Dispatcher contracts. The [Error Reference](../api/errors.md) lists every revert.

## Common Issues

### Request Reverts

#### `InsufficientPayment()`
- **Cause**: The ETH sent with `requestAIEvaluationWithApproval()`, plus the caller's credit in the aggregator, is less than `maxTotalFee(maxFee, minFee, withBeacons, K, P)` for the request's jury
- **Solution**: Quote with the same arguments the request uses, and send the difference:

```javascript
const required = await aggregator.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P);
const credit = await aggregator.ethOwed(await signer.getAddress());
const value = required > credit ? required - credit : 0n;
```

#### `BadJury()`
- **Cause**: The jury breaks a rule: `K ≥ M ≥ N ≥ P ≥ 1`, `N ≤ 40`, `P ≥ 2` unless `N = 1`, `K ≤ maxJury()` (50), `K ≤` the keeper's `shortlistSize()` (60), `tPlus() < timeout ≤ maxTimeout()` (155 s and 3,600 s)
- **Solution**: Fix the jury. The error is declared in `AggregatorLib`; add `error BadJury()` to your ABI to see its name

#### `BadInput()`
- **Cause**: `estimatedBaseCost` is not below the ceiling in effect, `min(maxFee, maxOracleFee())`; or `alpha` is above 1000; or `maxFeeBasedScalingFactor` is 0 or above 65,535; or the quote does not fit in 88 bits
- **Solution**: Pass a lower base cost (the examples use `8e9` wei with a ceiling of 0.00015 ETH), and keep the other values in range

#### `withBeacons` reverts
- **Cause**: The quote (`maxTotalFee`) and the request read `beacons.quorum()`, which reverts when the aggregator has no beacon contract set (`beacons()` returns the zero address)
- **Solution**: Request without beacons, or ask the owner to set one with `setContracts`

#### `KeeperNotSet()` / `EnforcedPause()`
- **Cause**: The aggregator has no keeper yet (deployment unfinished), or its owner has paused new requests
- **Solution**: Wait. While paused, draws, commits, reveals, settlement and withdrawals keep working

### The Round Does Not Move

#### Nothing happens after the request
- **Cause**: The request only escrows. The jury is drawn by `drawJury(aggId)`, which somebody has to send, from block B+2
- **Solution**: Call `drawJury(aggId)`. Within 30 seconds of the request, only the requester earns the draw reward (2 × the ceiling); after that, anyone. A round with `withBeacons` needs a second `drawJury` once the beacon values are in

#### `TooEarly()`
- **Cause**: `drawJury` before block B+2, or a second `drawJury` before the beacon quorum is in (and before the beacon deadline), or `promote` before block C+2
- **Solution**: Wait a block (or, for beacons, until `JuryBeacons.result(aggregator, aggId)` reports state 2 or 3) and retry

#### `SeedExpired()` / `DrawExpired()`
- **Cause**: The draw came too late: `blockhash(B+1)` was not stored within 8,191 blocks (about 27 minutes on Base), or it is more than a day after the request
- **Solution**: None for this round. `cancelUnsealed(aggId)` closes it, and the whole prepayment goes to the treasury (a refund would be a free re-roll). Draw promptly next time; `sealSeed(aggId)` stores the hash without drawing

#### The commit phase stays open
- **Cause**: It closes by itself at the M+-th commit (M + ⌈(K − M)/2⌉), or with a commit after T+ (155 s from the draw) that brings the count to at least M. If no commit comes after T+, it stays open
- **Solution**: After T+, with at least M commits (`getRoundInfo` returns `commits` and `windowEnd`), call `closeCommits(aggId)`. Then, from two blocks later, `promote(aggId)`

#### `WrongPhase()`
- **Cause**: The call is not due in this phase: for example `closeCommits` before T+ or with fewer than M commits, a `promote` that someone already sent, or `settle` on a round that is still in its draw or beacon phase or already settled
- **Solution**: Read `getRoundInfo(aggId)` and send the call that is due (see the [round lifecycle](../examples/index.md#the-round-lifecycle)). Another account may have sent it first

#### `OutOfGas()`
- **Cause**: The transaction's gas limit was too tight for the calls the draw must make (each tolerated call checks its stipend). A Jumbo draw uses about 12 to 13 million gas, and a Jumbo `promote` about 5 million
- **Solution**: Send the call with more gas

### The Round Ends Without a Result

#### The draw failed (phase 8)
- **Cause**: No arbiter was eligible at block B for the class and ceiling, or fewer beacon candidates than the quorum. The keeper's `NoEligibleArbiters()` is caught by the aggregator; the requester is refunded
- **Solution**: Use a class that registered arbiters list, and a ceiling at least the fee they post. The keeper's `eligibleCount(class, maxFee)` counts the arbiters eligible now. A pool with fewer than K eligible does not fail: it repeats arbiters, and one arbiter may then decide the round

#### The round is past its deadline with no result
- **Cause**: Too few commits, no promotion, or too few reveals before `deadline` (`getRoundInfo`). The round is dead, but `isFailed()` stays false and the refund stays in the round until it is settled
- **Solution**: Call `settle(aggId)` (anyone may). New requests also settle due rounds, but only in queue order and within a budget of `settlePerRequest()` × their own K slots, so don't wait for that. Send a new request if you still need the evaluation

#### `NotDue()`
- **Cause**: `settle` before the round's deadline
- **Solution**: Wait until after `deadline`. Promoted arbiters always get 120 seconds after `promote`, and a late close extends the deadline, so re-read it

#### The beacon stage ended the round
- **Cause**: Fewer than 2 beacon values were revealed within 120 seconds of the start. The second `drawJury` ends the round (`EvaluationFailed(aggId, 2)`), pays the beacons that answered, and sends the rest of the prepayment to the treasury
- **Solution**: Send a new request. This is the cost of beacons: a refund would let a requester re-roll the seed

### Refunds and Withdrawals

#### The refund did not arrive in my wallet
- **Cause**: Refunds and rewards are credits inside the aggregator (`ethOwed(yourAddress)`), not transfers. If a contract of yours made the request, the credit belongs to that contract
- **Solution**: Leave the credit, which pays for your next request, or collect it with `withdrawEth()`

#### There was no refund
- **Cause**: Some endings send the unspent prepayment to the treasury: a round that had M commits but was never promoted, a missed beacon quorum, a beacon round whose jury could not be drawn when the keeper's walk did not cover the whole class, and a round cancelled with `cancelUnsealed`. `RequesterRefunded(aggId, to, amount)` names the address credited
- **Solution**: Drive your rounds: draw promptly, and call `closeCommits` and `promote` when they are due. See [Fee Mechanisms](../advanced/fees.md#refunds-and-the-treasury)

#### `NothingOwed()`
- **Cause**: `withdrawEth()` by an address with no credit
- **Solution**: Check `ethOwed(address)`. A dead round credits its refund only once it is settled

### Arbiter Operators

#### My arbiter is never drawn
- **Cause**: Check `getArbiter(key)` (`keyOf(operator, jobId)`): it must be registered (flag 1) and not paused (2), banned (4), exiting (8) or under-staked (32), not blocked (`blockedUntil`), not frozen (a health call outstanding for more than 60 s: flag 16 with an old `callSentAt`), and its fee at most the requests' ceiling. Also check that the operator lists the v2 keeper (`addReputationKeeper`), or every dispatch to it is skipped (`SlotSkipped`, reason 2)
- **Solution**: Fix whichever fails. A frozen arbiter unfreezes by answering a health call; a re-syncing one (flag 64) answers twice

#### `BadPreimage()`
- **Cause**: `rotateChain` to a new head with a value that does not hash to the current head
- **Solution**: Answer from the current chain, or re-sync with `rotateChain(key, v, v)` / `answerHealthCall(key, v)`, which adopts `v` as the head and freezes the arbiter until it answers a later call

#### `StillBonded()` / `Blocked()` at `completeExit`
- **Cause**: The unbonding period (2 days by default, `getArbiter(key).exitAt`) has not passed, or the arbiter is blocked
- **Solution**: Wait until `exitAt` and until `blockedUntil`

## Getting Help

- **Discord**: [Join our community](https://discord.gg/verdikta)
- **GitHub**: [Report issues](https://github.com/verdikta/verdikta-dispatcher/issues)
- **Documentation**: The [Error Reference](../api/errors.md) lists every revert, and the [ReputationAggregator page](../contracts/reputation-aggregator.md) describes the request and payment flow

## Contact Support

For urgent issues, contact our support team:
- Email: support@verdikta.org
- Discord: #support channel
