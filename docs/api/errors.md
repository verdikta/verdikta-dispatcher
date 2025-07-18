# Error Codes Reference

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with complete error documentation.

Common error conditions and troubleshooting for Verdikta Dispatcher smart contracts.

## Common Errors

### InsufficientLinkBalance
```
Error: Insufficient LINK balance for request
```
**Solution**: Ensure sufficient LINK tokens are approved and available.

### InvalidOracleClass
```
Error: Invalid oracle class specified
```
**Solution**: Use a valid oracle class (typically 1 for standard disputes).

### RequestNotFound
```
Error: Evaluation request not found
```
**Solution**: Verify the request ID and ensure the request was successfully submitted.

### EvaluationTimeout
```
Error: Evaluation request timed out
```
**Solution**: The oracle took too long to respond. Try resubmitting or contact support.

## Gas Estimation Errors

### OutOfGas
```
Error: Transaction ran out of gas
```
**Solution**: Increase gas limit or optimize transaction parameters.

## For Detailed Troubleshooting

For comprehensive error handling and solutions:
- [Troubleshooting Guide](../troubleshooting/index.md)
- [Integration Examples](../examples/index.md)
- [FAQ](../faq.md) 