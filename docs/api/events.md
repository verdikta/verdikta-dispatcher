# Events Reference

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with complete event documentation.

Documentation for all events emitted by Verdikta Dispatcher smart contracts.

## Core Events

### RequestAIEvaluation
Emitted when a new evaluation request is submitted.

```solidity
event RequestAIEvaluation(
    bytes32 indexed requestId,
    address indexed requester,
    string[] cids,
    string addendum
);
```

### EvaluationFulfilled
Emitted when an evaluation is completed by an oracle.

```solidity
event EvaluationFulfilled(
    bytes32 indexed requestId,
    uint256[] likelihoods,
    string justificationCID
);
```

## Reputation Events

### ReputationUpdated
Emitted when oracle reputation scores are updated.

```solidity
event ReputationUpdated(
    address indexed oracle,
    uint256 newScore,
    uint256 requestCount
);
```

## For Complete Documentation

For detailed event parameters and usage examples, please refer to:
- [Contract Interfaces](index.md)
- [Integration Examples](../examples/index.md)
- [GitHub Repository](https://github.com/verdikta/verdikta-dispatcher) 