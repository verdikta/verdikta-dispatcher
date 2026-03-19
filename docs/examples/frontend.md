> **Warning**
> Draft — requires author review

# Frontend Integration Guide

How to interact with Verdikta Dispatcher contracts from a browser-based frontend using ethers.js and MetaMask. Patterns shown here are derived from the reference applications in the `verdikta/applications` repository.

## Prerequisites

- **ethers.js** v6+
- A browser wallet (MetaMask)
- LINK tokens on the target network
- The contract address of your Verdikta aggregator (ReputationAggregator or ReputationSingleton)

## Network Configuration

Verdikta contracts are deployed on Base Sepolia (testnet) and Base (mainnet). Configure your app to support both:

```javascript
const NETWORKS = {
  'base-sepolia': {
    name: 'Base Sepolia Testnet',
    chainId: 84532,
    chainIdHex: '0x14A34',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
  },
  'base': {
    name: 'Base Mainnet',
    chainId: 8453,
    chainIdHex: '0x2105',
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
  }
};
```

Store contract addresses per network in your config:

```javascript
const config = {
  network: import.meta.env.VITE_NETWORK || 'base-sepolia',
  aggregatorAddress: import.meta.env.VITE_AGGREGATOR_ADDRESS,
  linkTokenAddress: import.meta.env.VITE_LINK_TOKEN_ADDRESS
};
```

See the [Deployment Guide](../deployment/index.md) for all deployed contract addresses.

## Contract ABIs

Use human-readable ABI fragments — you only need the functions and events your frontend calls. A minimal ABI for the ReputationAggregator:

```javascript
const AGGREGATOR_ABI = [
  // Write
  'function requestAIEvaluationWithApproval(string[] memory cids, string memory addendumText, uint256 _alpha, uint256 _maxFee, uint256 _estimatedBaseCost, uint256 _maxFeeBasedScalingFactor, uint64 _requestedClass) public returns (bytes32)',
  'function finalizeEvaluationTimeout(bytes32 aggId) external',

  // Read
  'function getEvaluation(bytes32 reqId) public view returns (uint256[] memory, string memory, bool)',
  'function isFailed(bytes32 aggId) external view returns (bool)',
  'function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256)',
  'function responseTimeoutSeconds() external view returns (uint256)',
  'function getContractConfig() public view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 fee)',

  // Events
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
  'event EvaluationFailed(bytes32 indexed aggRequestId, string phase)'
];

const LINK_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)'
];
```

For ReputationSingleton, replace `FulfillAIEvaluation` with:
```javascript
'event EvaluationFulfilled(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID)'
```

## Wallet Connection

### Connecting to MetaMask

```javascript
import { ethers } from 'ethers';

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error('MetaMask is not installed');
  }

  const provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();

  return { provider, signer, address: accounts[0] };
}
```

### Silent Reconnection

Avoid prompting the user every page load. Use `eth_accounts` (no prompt) to check if the user is already authorized:

```javascript
async function tryReconnect() {
  if (!window.ethereum) return null;

  const wasConnected = localStorage.getItem('wallet_connected') === 'true';
  if (!wasConnected) return null;

  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  if (accounts.length === 0) {
    localStorage.removeItem('wallet_connected');
    return null;
  }

  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  return { provider, signer, address: accounts[0] };
}
```

### Network Switching

Ensure the user is on the correct network before sending transactions:

```javascript
async function ensureCorrectNetwork(provider, targetNetwork) {
  const network = await provider.getNetwork();

  if (network.chainId.toString() !== targetNetwork.chainId.toString()) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetNetwork.chainIdHex }]
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: targetNetwork.chainIdHex,
            chainName: targetNetwork.name,
            nativeCurrency: targetNetwork.currency,
            rpcUrls: [targetNetwork.rpcUrl],
            blockExplorerUrls: [targetNetwork.explorer]
          }]
        });
      } else {
        throw new Error(`Please switch to ${targetNetwork.name} in MetaMask`);
      }
    }

    return new Promise((resolve) => {
      const handler = () => {
        window.ethereum.removeListener('chainChanged', handler);
        setTimeout(() => resolve(new ethers.BrowserProvider(window.ethereum)), 800);
      };
      window.ethereum.on('chainChanged', handler);
    });
  }

  return provider;
}
```

### Listening for Wallet Events

Handle account and network changes so your UI stays in sync:

```javascript
function setupWalletListeners(onAccountChange, onChainChange) {
  window.ethereum.removeAllListeners?.('accountsChanged');
  window.ethereum.removeAllListeners?.('chainChanged');

  window.ethereum.on('accountsChanged', (accounts) => {
    onAccountChange(accounts.length === 0 ? null : accounts[0]);
  });

  window.ethereum.on('chainChanged', (chainIdHex) => {
    onChainChange(parseInt(chainIdHex, 16));
  });
}
```

## Transaction Flows

### 1. LINK Approval

Before submitting an evaluation request, the user must approve the aggregator contract to spend their LINK. Use `maxTotalFee()` to calculate the required amount:

```javascript
async function approveLinkForRequest(signer, aggregatorAddress, maxOracleFee) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const linkAddress = (await aggregator.getContractConfig()).linkAddr;

  const totalFee = await aggregator.maxTotalFee(maxOracleFee);

  const link = new ethers.Contract(linkAddress, LINK_ABI, signer);
  const tx = await link.approve(aggregatorAddress, totalFee);
  await tx.wait();

  return totalFee;
}
```

### 2. Submitting an Evaluation Request

Use the dry-run pattern: call `staticCall` first to catch errors before spending gas.

```javascript
async function requestEvaluation(signer, aggregatorAddress, params) {
  const { cids, addendum, alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, classId } = params;
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);

  // Dry-run: check if the transaction would succeed
  try {
    await aggregator.requestAIEvaluationWithApproval.staticCall(
      cids, addendum, alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, classId
    );
  } catch (error) {
    const reason = decodeRevertReason(error, [aggregator]);
    throw new Error(`Request would fail: ${reason || error.message}`);
  }

  // Send the actual transaction
  const tx = await aggregator.requestAIEvaluationWithApproval(
    cids, addendum, alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, classId
  );
  const receipt = await tx.wait();

  // Extract requestId from the RequestAIEvaluation event
  const requestId = extractEventArg(receipt, aggregator, 'RequestAIEvaluation', 'aggRequestId');

  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, requestId };
}
```

### 3. Reading Evaluation Results

Poll `getEvaluation()` to check if oracles have fulfilled the request:

```javascript
async function checkEvaluationReady(provider, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);

  const [scores, justificationCid, ok] = await aggregator.getEvaluation(requestId);

  if (!ok || !scores || scores.length < 2) {
    return { ready: false };
  }

  return {
    ready: true,
    scores: scores.map(s => Number(s)),
    justificationCid
  };
}
```

### 4. Handling Timeouts

If oracles do not respond within the timeout window, the user can finalize the request:

```javascript
async function finalizeTimeout(signer, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const tx = await aggregator.finalizeEvaluationTimeout(requestId);
  await tx.wait();
}
```

## Helper Utilities

### Decoding Revert Reasons

Solidity custom errors need to be decoded against the contract ABI:

```javascript
function decodeRevertReason(error, contracts) {
  if (error.data) {
    for (const contract of contracts) {
      try {
        const parsed = contract.interface.parseError(error.data);
        if (parsed) {
          const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
          return parsed.name + args;
        }
      } catch {}
    }
  }
  return error.reason || error.shortMessage || null;
}
```

See the [Error Reference](../api/errors.md) for all custom errors you may encounter.

### Extracting Event Arguments from Receipts

```javascript
function extractEventArg(receipt, contract, eventName, argName) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === eventName) {
        return parsed.args[argName];
      }
    } catch {}
  }
  return null;
}
```

See the [Events Reference](../api/events.md) for all events and their parameters.

## Polling for Results

Evaluation requests are asynchronous — oracles respond off-chain and fulfill on-chain. Use polling with appropriate intervals:

```javascript
async function pollForResult(provider, aggregatorAddress, requestId, options = {}) {
  const {
    intervalMs = 5000,     // poll every 5 seconds
    maxAttempts = 60,      // give up after 5 minutes
    onPoll = () => {}      // optional progress callback
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onPoll(attempt, maxAttempts);

    const result = await checkEvaluationReady(provider, aggregatorAddress, requestId);
    if (result.ready) {
      return result;
    }

    // Check for failure
    const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);
    const failed = await aggregator.isFailed(requestId);
    if (failed) {
      throw new Error('Evaluation failed or timed out');
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Evaluation did not complete within the expected time');
}
```

### Event-Based Notification

For production applications, consider using contract events instead of polling. Listen for `FulfillAIEvaluation` (ReputationAggregator) or `EvaluationFulfilled` (ReputationSingleton) to be notified immediately when the result is available:

```javascript
function listenForFulfillment(provider, aggregatorAddress, requestId, callback) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);

  const filter = aggregator.filters.FulfillAIEvaluation(requestId);
  aggregator.once(filter, (aggRequestId, likelihoods, justificationCid) => {
    callback({
      requestId: aggRequestId,
      scores: likelihoods.map(l => Number(l)),
      justificationCid
    });
  });

  // Return cleanup function
  return () => aggregator.removeAllListeners(filter);
}
```

## Complete Example: Request and Wait

Putting it all together — approve LINK, submit a request, and wait for the result:

```javascript
async function evaluateContent(signer, aggregatorAddress, cids, classId) {
  const provider = signer.provider;
  const maxOracleFee = ethers.parseEther('0.05');

  // 1. Approve LINK
  await approveLinkForRequest(signer, aggregatorAddress, maxOracleFee);

  // 2. Submit request
  const { requestId } = await requestEvaluation(signer, aggregatorAddress, {
    cids,
    addendum: '',
    alpha: 500,
    maxOracleFee,
    estimatedBaseCost: ethers.parseEther('0.0005'),
    maxFeeScaling: 5,
    classId
  });

  console.log('Request submitted:', requestId);

  // 3. Wait for result
  const result = await pollForResult(provider, aggregatorAddress, requestId, {
    onPoll: (attempt) => console.log(`Polling attempt ${attempt + 1}...`)
  });

  console.log('Evaluation complete:', result.scores);
  return result;
}
```

## Performance Tips

| Technique | Description |
|-----------|-------------|
| **Cache contract instances** | Create `new ethers.Contract(...)` once and reuse it |
| **Debounce RPC calls** | Batch identical view calls within a short time window |
| **Use read-only providers** | Use `JsonRpcProvider` for view calls instead of routing through MetaMask |
| **Status caching** | Cache `getEvaluation()` results with a short TTL (5 seconds is typical) |
| **Prevent duplicate connections** | Guard against concurrent `connect()` calls with a promise lock |

## Next Steps

- Review the [Smart Contract Integration Walkthrough](integration.md) for on-chain client patterns
- Consult the [Events Reference](../api/events.md) for all events you can listen to
- See the [Error Reference](../api/errors.md) for handling revert conditions
- Check the [Fees Guide](../advanced/fees.md) to understand LINK costs
