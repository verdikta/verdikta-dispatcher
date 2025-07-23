# Fee Mechanisms

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with detailed fee mechanism documentation.

Understanding how fees work in the Verdikta Dispatcher system.

## Fee Structure

### Base Components
- **Oracle Fee**: Payment to the oracle for processing
- **Network Fee**: Gas costs for on-chain transactions
- **Platform Fee**: Small percentage for system maintenance

### Fee Calculation
```
Total Fee = Base Cost + (Oracle Fee × Scaling Factor)
```

## Fee Parameters

### Max Fee
Maximum amount willing to pay for an evaluation.

### Base Cost
Estimated minimum cost for the evaluation.

### Scaling Factor
Multiplier applied if oracle demand is high (1-10).

### Oracle Class
Different oracle types have different fee structures:
- **Class 1**: Standard oracles (lowest fees)
- **Class 2**: Premium oracles (higher fees, better quality)

## Fee Optimization

### Tips for Lower Fees
- Use appropriate oracle class for your needs
- Set reasonable max fees
- Consider timing (avoid peak hours)
- Use ReputationSingleton for simple disputes

### Fee Management
For automated fee management patterns, see:
- [Integration Examples](../examples/index.md)
- [Best Practices](../examples/integration.md)

## Payment Process

1. **Approval**: LINK tokens must be approved
2. **Escrow**: Fees are held in escrow during evaluation
3. **Payment**: Oracle receives payment upon completion
4. **Refund**: Unused fees are refunded 