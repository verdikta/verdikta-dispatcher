# Frequently Asked Questions

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with real FAQ content.

## General Questions

### What is Verdikta Dispatcher?
Verdikta Dispatcher is a smart contract system that provides AI-powered dispute resolution services on blockchain networks.

### Which networks are supported?
Currently deployed on:
- Base Sepolia (Testnet)
- Ethereum Sepolia (Testnet)

### How much does it cost to use?
Costs vary based on dispute complexity. Typical fees range from $1-10 per evaluation.

## Technical Questions

### Which contract should I use?
- **ReputationSingleton**: For simple, fast disputes
- **ReputationAggregator**: For high-value, complex disputes requiring multiple oracles
- **SimpleContract**: For development and testing

### How long do evaluations take?
Most evaluations complete within 5-15 minutes, depending on oracle availability and dispute complexity.

### What happens if an oracle doesn't respond?
The system has built-in timeouts. If an oracle fails to respond, the request can be retried or marked as failed.

## Integration Questions

### Do I need to handle LINK tokens?
Yes, you need LINK tokens to pay oracle fees. The contract will handle approval and payment automatically.

### Can I customize the evaluation parameters?
Yes, you can adjust reputation weighting, fee limits, and oracle selection when submitting requests.

### How do I monitor evaluation progress?
Use the `getEvaluation()` function to check status, or listen for `EvaluationFulfilled` events.

## Support

If you have questions not covered here:
- Join our [Discord community](https://discord.gg/verdikta)
- Check our [documentation](../index.md)
- Report issues on [GitHub](https://github.com/verdikta/verdikta-dispatcher/issues) 