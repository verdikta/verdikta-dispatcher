# Frequently Asked Questions

!!! note "Checked against the code"
    Revised on 2026-11-22 against the contracts in this repository and the aggregator deployed on Base mainnet at [`0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`](https://basescan.org/address/0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a). Numbers that the contracts' owner can change are given with the function that returns the current value.

## General Questions

### What is Verdikta Dispatcher?
Verdikta Dispatcher is a smart contract system that provides AI-powered dispute resolution services on blockchain networks.

### Which networks are supported?
The ReputationAggregator, the production contract, is deployed on:

- Base (Mainnet): `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`
- Base Sepolia (Testnet): `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4`

For Ethereum Sepolia this repository lists token addresses only. See the [Deployment Guide](deployment/index.md).

### How much does it cost to use?
Fees are paid in ETH, and the cost of a request to the ReputationAggregator does not depend on its complexity. It is set by the fees of the oracles that are selected:

- each of the 6 oracles polled is credited its registered fee when the request is made;
- each of the 2 oracles in the best cluster is credited 3 times its fee on top when the round completes.

On 2026-11-22 all 40 oracles registered on Base mainnet charged 0.00002 ETH, so a completed round cost 12 × 0.00002 = 0.00024 ETH in oracle fees and a round that timed out cost 6 × 0.00002 = 0.00012 ETH. The gas for your transactions comes on top.

You send more than that with the request: a worst-case prepayment, `maxTotalFee(yourFeeCeiling)`, which is 12 times your fee ceiling and at most 0.0048 ETH on Base mainnet. What the round does not spend is credited back to you in the contract; you can withdraw it with `withdrawEth()` or let it pay for your next request. See [Fee Mechanisms](advanced/fees.md).

You can read the current values yourself: `commitOraclesToPoll()`, `clusterSize()`, `bonusMultiplier()` and `maxOracleFee()` on the aggregator, and each oracle's fee with `registeredOracles(i)` and `getOracleInfo(operator, jobId)` on the ReputationKeeper.

## Technical Questions

### Which contract should I use?
- **ReputationAggregator**: The production contract. Several oracles answer each request and their answers are aggregated. Paid in ETH
- **ReputationSingleton**: A legacy single-oracle contract, paid in LINK
- **SimpleContract**: A legacy contract for development and testing, paid in LINK

### How long do evaluations take?
Usually a couple of minutes. Over the 862 rounds the Base mainnet aggregator ran between 2026-06-09 and 2026-11-15, completed rounds finished at a median of 104 seconds, and nine in ten within 204 seconds ([measurement in this repository](https://github.com/verdikta/verdikta-dispatcher/blob/343ac6f9f8cef282a52696248202b96beec8e8fe/reputationBasedAggregator/TODO.md), section "Real latency").

A round also has a timeout, counted from the request: 300 seconds on Base mainnet and 900 seconds on Base Sepolia (`responseTimeoutSeconds()`). A round that has not finished by then can be closed as failed (see the next question). In the same measurement 86 of the 862 rounds, one in ten, timed out; in October and November 2026, 6 rounds (1.6%) timed out in the commit phase.

### What happens if an oracle doesn't respond?
One silent oracle does not stop a round: 6 oracles are polled, the first 4 that commit are asked to reveal, and 3 reveals are enough. An oracle that did not answer, or answered too late to be used, loses timeliness score.

If too few oracles answer before the timeout, the round does not fail by itself and is not retried. Anyone can then call `finalizeEvaluationTimeout(aggId)`. That call closes the round as failed and credits the unspent part of the prepayment back to the requester; the base fees already credited to the polled oracles stay with them. Until someone makes that call, `isFailed(aggId)` returns false and `getEvaluation(aggId)` reports no result, so call it yourself once the timeout has passed. To try again, send a new request.

## Integration Questions

### Do I need to handle LINK tokens?
Not for the ReputationAggregator. You pay in ETH, in the same transaction that makes the request, and there is no token approval. The function is still called `requestAIEvaluationWithApproval()` for historical reasons, and requests still reach the oracles over the Chainlink request path, with a LINK amount of zero.

Only the legacy ReputationSingleton and SimpleContract are paid in LINK, with an approval made beforehand.

### Can I customize the evaluation parameters?
Yes, you can adjust reputation weighting, fee limits, and oracle selection when submitting requests.

### How do I monitor evaluation progress?
Use the `getEvaluation()` function to read the result and `getAggregationStatus()` to see how far a round has got, or listen for the `FulfillAIEvaluation` event of the ReputationAggregator. (The legacy ReputationSingleton emits `EvaluationFulfilled` instead.)

## Support

If you have questions not covered here:
- Join our [Discord community](https://discord.gg/verdikta)
- Check our [documentation](index.md)
- Report issues on [GitHub](https://github.com/verdikta/verdikta-dispatcher/issues)
