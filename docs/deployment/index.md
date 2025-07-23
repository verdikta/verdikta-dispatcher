# Deployment Guide

> **⚠️ STUB DOCUMENTATION**: This file contains placeholder content and needs to be expanded with real deployment instructions.

Instructions for deploying and configuring Verdikta Dispatcher smart contracts.

## Prerequisites

- Node.js and npm/yarn
- Hardhat development environment
- Access to Base Sepolia or Ethereum testnet
- LINK tokens for testing

## Quick Deployment

```bash
# Clone the repository
git clone https://github.com/verdikta/verdikta-dispatcher.git
cd verdikta-dispatcher

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Deploy to testnet
npm run deploy:sepolia
```

## Contract Addresses

### Base Sepolia
- **LINK Token**: `0xE4aB69C077896252FAFBD49EFD26B5D171A32410`
- **Verdikta Token**: `0xe46F6b494F111d958CDBB52536AD78c4eEeB0149`

### Ethereum Sepolia
- **LINK Token**: `0x779877A7B0D9E8603169DdbD7836e478b4624789`
- **Verdikta Token**: `0xbb7079F45367ce928789cc40d8C9D4E3A19b0a49`

## Configuration

For detailed configuration and deployment instructions, visit our [GitHub repository](https://github.com/verdikta/verdikta-dispatcher).

## Verification

After deployment, verify your contracts on the block explorer and test basic functionality.

## Support

For deployment assistance:
- Check our [troubleshooting guide](../troubleshooting/index.md)
- Join our [Discord community](https://discord.gg/verdikta)
- Review the [GitHub repository](https://github.com/verdikta/verdikta-dispatcher) 