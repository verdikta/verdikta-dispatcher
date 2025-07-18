# Reputation System

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with detailed reputation system documentation.

How the oracle reputation and selection system works in Verdikta Dispatcher.

## Overview

The reputation system ensures high-quality dispute resolution by tracking oracle performance and selecting the best oracles for each request.

## Reputation Scoring

### Performance Metrics
- **Response Time**: How quickly oracles respond to requests
- **Accuracy**: Quality of decisions compared to consensus
- **Availability**: Uptime and reliability metrics
- **Stake**: Amount of tokens staked by the oracle

### Score Calculation
```
Reputation Score = (Accuracy × 40%) + (Speed × 30%) + (Availability × 20%) + (Stake × 10%)
```

## Oracle Selection

### Weighted Selection
Oracles are selected using weighted random selection based on:
- Reputation score
- Availability status
- Oracle class matching
- Fee competitiveness

### Alpha Parameter
The alpha parameter (0-1000) controls the balance between:
- **High Alpha (700-1000)**: Favor highly reputed oracles
- **Medium Alpha (300-700)**: Balanced selection
- **Low Alpha (0-300)**: More random selection, lower fees

## Implementation Details

For technical implementation details, see:
- [ReputationKeeper Contract](../contracts/reputation-keeper.md)
- [ReputationAggregator Contract](../contracts/reputation-aggregator.md)
- [Integration Examples](../examples/index.md) 