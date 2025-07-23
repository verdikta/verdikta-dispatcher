# Troubleshooting Guide

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with real troubleshooting information.

This section covers common issues when working with Verdikta Dispatcher smart contracts.

## Common Issues

### Transaction Reverts

#### "Insufficient LINK balance"
- **Cause**: Not enough LINK tokens approved for the contract
- **Solution**: Approve more LINK tokens to cover fees

#### "Invalid oracle class"
- **Cause**: Requesting an oracle class that doesn't exist
- **Solution**: Use class 1 for standard disputes

### Oracle Issues

#### Request Timeout
- **Cause**: Oracle takes too long to respond
- **Solution**: Check oracle availability and consider increasing fees

#### No Response from Oracle
- **Cause**: Oracle may be offline or overloaded
- **Solution**: Try again later or contact support

## Getting Help

- **Discord**: [Join our community](https://discord.gg/verdikta)
- **GitHub**: [Report issues](https://github.com/verdikta/verdikta-dispatcher/issues)
- **Documentation**: Review contract documentation for detailed information

## Contact Support

For urgent issues, contact our support team:
- Email: support@verdikta.org
- Discord: #support channel 