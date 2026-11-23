# Troubleshooting Guide

!!! note "Checked against the code"
    Revised on 2026-11-22 against [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationAggregator.sol), [`ReputationKeeper.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationKeeper.sol) and the aggregator deployed on Base mainnet at `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`. Each revert below was reproduced on a local fork of Base mainnet. The entries are about the ReputationAggregator, which is paid in ETH: a requester needs no LINK and approves no token.

This section covers common issues when working with Verdikta Dispatcher smart contracts.

## Common Issues

### Transaction Reverts

#### `InsufficientPayment()`
- **Cause**: The ETH sent with `requestAIEvaluationWithApproval()`, plus the credit the caller already holds in the aggregator, is less than `maxTotalFee(_maxOracleFee)`
- **Solution**: Read the required amount and your credit, and send the difference as the value of the call:

```javascript
const required = await aggregator.maxTotalFee(maxOracleFee);
const credit = await aggregator.ethOwed(await signer.getAddress());
const value = required > credit ? required - credit : 0n;
```

#### "No active oracles available with fee <= maxFee and requested class"
- **Cause**: No registered oracle is active, lists the requested class and charges at most your fee ceiling. On 2026-11-22 all 40 oracles on Base mainnet listed class 128 and none listed class 1 (the ReputationKeeper's `getOracleClasses(i)`), and all charged 0.00002 ETH (`getOracleInfo(operator, jobId)`)
- **Solution**: Request a class that oracles list, and pass a `_maxOracleFee` that is at least the fee they charge. A value above the contract's `maxOracleFee()` (0.0004 ETH) is lowered to it

#### "Base cost must be less than max fee"
- **Cause**: `_estimatedBaseCost` is not lower than the fee ceiling in effect, `min(_maxOracleFee, maxOracleFee())`
- **Solution**: Pass a lower base cost. The repository's scripts use 8e9 wei with a ceiling of 0.00015 ETH

#### The request transaction runs out of gas
- **Cause**: Oracle selection is random, so the gas a request uses differs from what a wallet estimates beforehand
- **Solution**: Estimate the gas and add headroom. The repository's `scripts/single-query.js` adds 50%

#### `EnforcedPause()`
- **Cause**: The contract owner has paused new requests with `pause()`
- **Solution**: Wait until `paused()` returns false. Rounds in progress, timeout finalization and withdrawals keep working while the contract is paused

### Oracle Issues

#### The evaluation does not finish
- **Cause**: Too few oracles answered within the timeout, `responseTimeoutSeconds()` (300 seconds on Base mainnet and 900 on Base Sepolia on 2026-11-22). The contract does not close the round by itself and does not retry it
- **Solution**: Once the timeout has passed, call `finalizeEvaluationTimeout(aggRequestId)`. Anyone may call it. The round is then marked as failed (`isFailed()` returns true) and the unspent part of your prepayment is credited back to you. Send a new request if you still need the evaluation

#### `NotTimedOut()`
- **Cause**: `finalizeEvaluationTimeout()` was called before the timeout had passed
- **Solution**: Wait until `startTimestamp + responseTimeoutSeconds()`. `getAggregationStatus(aggRequestId)` returns `startTimestamp`

### Refunds and Withdrawals

#### The refund did not arrive in my wallet
- **Cause**: Refunds are credits inside the aggregator (`ethOwed(yourAddress)`), not transfers
- **Solution**: Leave the credit, which pays for your next request before new ETH is asked for, or collect it with `withdrawEth()`. If a contract of yours made the request, the credit belongs to that contract

#### `NothingOwed()`
- **Cause**: `withdrawEth()` was called by an address with no credit
- **Solution**: Check `ethOwed(address)`. A round that timed out credits its refund only after `finalizeEvaluationTimeout()` has been called

## Getting Help

- **Discord**: [Join our community](https://discord.gg/verdikta)
- **GitHub**: [Report issues](https://github.com/verdikta/verdikta-dispatcher/issues)
- **Documentation**: The [Error Reference](../api/errors.md) lists every revert, and the [ReputationAggregator page](../contracts/reputation-aggregator.md) describes the request and payment flow

## Contact Support

For urgent issues, contact our support team:
- Email: support@verdikta.org
- Discord: #support channel
