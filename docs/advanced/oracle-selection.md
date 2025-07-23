# Oracle Selection Algorithms

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with detailed oracle selection algorithm documentation.

How oracles are selected for dispute resolution requests.

## Selection Criteria

### Primary Factors
- **Reputation Score**: Past performance and accuracy
- **Availability**: Current online status and capacity
- **Oracle Class**: Matching requested specialization
- **Fee Structure**: Competitive pricing within limits

### Weighted Selection Algorithm
```
Selection Weight = (Reputation^α) × Availability × Class_Match × Fee_Factor
```

Where:
- `α` (alpha): Reputation weighting parameter (0-1000)
- Higher alpha = more weight on reputation
- Lower alpha = more randomized selection

## Selection Types

### Single Oracle (ReputationSingleton)
- Selects one oracle using weighted random selection
- Fastest resolution, lowest cost
- Suitable for simple disputes

### Multi-Oracle (ReputationAggregator)
- Selects multiple oracles for consensus
- Higher security through redundancy
- Suitable for high-value disputes

## Availability Management

### Capacity Tracking
Oracles report their current capacity and maximum concurrent evaluations.

### Load Balancing
System distributes requests to prevent oracle overload.

### Fallback Selection
If preferred oracles are unavailable, system selects alternatives.

## Implementation Details

### Alpha Parameter Effects
- **α = 1000**: Always select highest reputation oracle
- **α = 500**: Balanced selection (recommended)
- **α = 0**: Purely random selection (lowest fees)

For implementation examples:
- [ReputationKeeper Contract](../contracts/reputation-keeper.md)
- [Integration Examples](../examples/index.md)
- [Reputation System Details](reputation.md) 