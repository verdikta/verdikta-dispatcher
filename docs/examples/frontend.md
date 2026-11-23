# Frontend Integration Guide

How to interact with the Verdikta Dispatcher contracts from a browser-based frontend using ethers.js and MetaMask. The patterns follow the reference applications in the [`verdikta-applications`](https://github.com/verdikta/verdikta-applications) repository.

!!! note "Checked against the code"
    Revised on 2026-11-22 against [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationAggregator.sol) and the aggregator deployed on Base mainnet. The ReputationAggregator is paid in ETH sent with the request: the user needs no LINK and approves no token. The functions on this page were run against a local fork of Base mainnet, with a stand-in for the browser wallet.

## Prerequisites

- **ethers.js** v6+
- A browser wallet (MetaMask)
- ETH on the target network, for the evaluation prepayment and for gas. With the fee ceiling used on this page the prepayment is 0.0018 ETH, most of which is credited back (see [Sizing the ETH Prepayment](#1-sizing-the-eth-prepayment))
- The address of the ReputationAggregator on that network

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
  aggregatorAddress: import.meta.env.VITE_AGGREGATOR_ADDRESS
};
```

The ETH-funded ReputationAggregator is at `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` on Base and at `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` on Base Sepolia. See the [Deployment Guide](../deployment/index.md) for all deployed contract addresses.

## Contract ABIs

Use human-readable ABI fragments — you only need the functions, events and errors your frontend uses. A minimal ABI for the ReputationAggregator:

```javascript
const AGGREGATOR_ABI = [
  // Write. The request is payable: the ETH that funds the round travels with it
  'function requestAIEvaluationWithApproval(string[] memory cids, string memory addendumText, uint256 _alpha, uint256 _maxOracleFee, uint256 _estimatedBaseCost, uint256 _maxFeeBasedScalingFactor, uint64 _requestedClass) public payable returns (bytes32)',
  'function finalizeEvaluationTimeout(bytes32 aggId) external',
  'function withdrawEth() external',

  // Read
  'function getEvaluation(bytes32 reqId) public view returns (uint256[] memory, string memory, bool)',
  'function isFailed(bytes32 aggId) external view returns (bool)',
  'function maxTotalFee(uint256 requestedMaxOracleFee) public view returns (uint256)',
  'function ethOwed(address payee) external view returns (uint256)',
  'function responseTimeoutSeconds() external view returns (uint256)',
  'function getAggregationStatus(bytes32 aggId) external view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',

  // Events
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
  'event EvaluationFailed(bytes32 indexed aggRequestId, string phase)',
  'event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount)',

  // Custom errors, so that a revert can be decoded by name
  'error InsufficientPayment()',
  'error EmptyCIDList()',
  'error TooManyCIDs()',
  'error CIDTooLong()',
  'error AddendumTooLong()',
  'error NotTimedOut()',
  'error AggregationComplete()',
  'error UnknownRequest()',
  'error NothingOwed()',
  'error EnforcedPause()'
];
```

No token ABI is needed. The legacy ReputationSingleton is a different case: it is paid in LINK, needs a LINK approval before the request, and emits `EvaluationFulfilled` instead of `FulfillAIEvaluation`. See [its page](../contracts/reputation-singleton.md).

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

### 1. Sizing the ETH Prepayment

There is nothing to approve. The request must carry `maxTotalFee(maxOracleFee)` in ETH, less any credit the user already holds in the aggregator from earlier refunds, which the contract uses first:

```javascript
async function prepaymentForRequest(signer, aggregatorAddress, maxOracleFee) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);

  // Worst case for one round: min(maxOracleFee, the contract's ceiling) x 12
  const required = await aggregator.maxTotalFee(maxOracleFee);
  const credit = await aggregator.ethOwed(await signer.getAddress());
  const value = required > credit ? required - credit : 0n;

  return { required, credit, value };
}
```

`maxTotalFee()` is a worst-case budget, not the price. With a ceiling of 0.00015 ETH it returns 0.0018 ETH. The round then pays each of the 6 polled oracles its registered fee and the 2 clustered oracles a bonus of 3 times that fee, and credits the rest back: at the 0.00002 ETH every oracle on Base mainnet charged on 2026-11-22, a completed round costs 0.00024 ETH. Show the user both numbers. See the [Fees Guide](../advanced/fees.md).

### 2. Submitting an Evaluation Request

Use the dry-run pattern: call `staticCall` first to catch errors before spending gas. Pass the same `value` to the dry run, or it fails with `InsufficientPayment()`.

```javascript
async function requestEvaluation(signer, aggregatorAddress, params) {
  const { cids, addendum, alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, classId } = params;
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const args = [cids, addendum, alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, classId];

  const { value } = await prepaymentForRequest(signer, aggregatorAddress, maxOracleFee);

  // Dry-run: check if the transaction would succeed
  try {
    await aggregator.requestAIEvaluationWithApproval.staticCall(...args, { value });
  } catch (error) {
    const reason = decodeRevertReason(error, [aggregator]);
    throw new Error(`Request would fail: ${reason || error.message}`);
  }

  // Oracle selection is random, so the gas used differs from the estimate.
  // Add headroom, or the transaction can run out of gas
  const estimate = await aggregator.requestAIEvaluationWithApproval.estimateGas(...args, { value });
  const gasLimit = (estimate * 150n) / 100n;

  // Send the actual transaction: the ETH travels with the call
  const tx = await aggregator.requestAIEvaluationWithApproval(...args, { value, gasLimit });
  const receipt = await tx.wait();

  // Extract requestId from the RequestAIEvaluation event
  const requestId = extractEventArg(receipt, aggregator, 'RequestAIEvaluation', 'aggRequestId');

  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, requestId, valueSent: value };
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

A round that has not finished within `responseTimeoutSeconds()` (300 seconds on Base mainnet and 900 on Base Sepolia on 2026-11-22) is not closed automatically, and `isFailed()` stays false until someone closes it. Until then the unspent part of the user's prepayment stays reserved in the round. Anyone can close it, so the frontend should offer to:

```javascript
async function hasTimedOut(provider, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);

  const status = await aggregator.getAggregationStatus(requestId);
  if (status.isComplete) return false;

  const timeout = await aggregator.responseTimeoutSeconds();
  const latest = await provider.getBlock('latest');
  return BigInt(latest.timestamp) >= status.startTimestamp + timeout;
}

async function finalizeTimeout(signer, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const tx = await aggregator.finalizeEvaluationTimeout(requestId);
  const receipt = await tx.wait();

  // The unspent prepayment is now the requester's credit in the aggregator
  const refunded = extractEventArg(receipt, aggregator, 'RequesterRefunded', 'amount');
  return { txHash: receipt.hash, refunded };
}
```

Calling `finalizeEvaluationTimeout()` before the timeout reverts with `NotTimedOut()`.

### 5. Collecting Refunds

Refunds are credits inside the aggregator. A credit pays for the user's next request before new ETH is asked for (`prepaymentForRequest()` above takes it into account), or the user takes it out:

```javascript
async function withdrawCredit(signer, aggregatorAddress) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);

  const credit = await aggregator.ethOwed(await signer.getAddress());
  if (credit === 0n) return { withdrawn: 0n };   // withdrawEth() would revert with NothingOwed()

  const tx = await aggregator.withdrawEth();
  const receipt = await tx.wait();
  return { txHash: receipt.hash, withdrawn: credit };
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

    // Closed as failed: someone has called finalizeEvaluationTimeout()
    const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);
    const failed = await aggregator.isFailed(requestId);
    if (failed) {
      throw new Error('Evaluation failed');
    }

    // Past the timeout and still open: stop polling and let the user close the round
    if (await hasTimedOut(provider, aggregatorAddress, requestId)) {
      const error = new Error('Evaluation timed out and has to be finalized');
      error.code = 'TIMED_OUT';
      throw error;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Evaluation did not complete within the expected time');
}
```

The defaults above stop after 5 minutes, which is the timeout on Base mainnet. On Base Sepolia the timeout is 900 seconds, so read `responseTimeoutSeconds()` and set `maxAttempts` to match if you support both networks.

### Event-Based Notification

For production applications, consider using contract events instead of polling. Listen for `FulfillAIEvaluation` to be notified immediately when the result is available:

```javascript
function listenForFulfillment(provider, aggregatorAddress, requestId, callback) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);

  // With a filter object, ethers v6 passes the listener one argument:
  // the event, whose `args` hold the event's values
  const filter = aggregator.filters.FulfillAIEvaluation(requestId);
  aggregator.once(filter, (event) => {
    const [aggRequestId, likelihoods, justificationCid] = event.args;
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

Putting it all together — submit a request with its ETH prepayment, wait for the result, and close the round if it times out:

```javascript
async function evaluateContent(signer, aggregatorAddress, cids, classId = 128) {
  const provider = signer.provider;
  const maxOracleFee = ethers.parseEther('0.00015');   // fee ceiling per oracle

  // 1. Submit request. The prepayment is sized and sent inside requestEvaluation()
  const { requestId, valueSent } = await requestEvaluation(signer, aggregatorAddress, {
    cids,
    addendum: '',
    alpha: 500,
    maxOracleFee,
    estimatedBaseCost: 8_000_000_000n,                 // 8e9 wei, below the fee ceiling
    maxFeeScaling: 5,
    classId
  });

  console.log('Request submitted:', requestId, 'with', ethers.formatEther(valueSent), 'ETH');

  // 2. Wait for result
  try {
    const result = await pollForResult(provider, aggregatorAddress, requestId, {
      onPoll: (attempt) => console.log(`Polling attempt ${attempt + 1}...`)
    });

    console.log('Evaluation complete:', result.scores);
    return result;

  } catch (error) {
    if (error.code !== 'TIMED_OUT') throw error;

    // 3. Timed out: close the round so the unspent prepayment is credited back
    const { refunded } = await finalizeTimeout(signer, aggregatorAddress, requestId);
    console.log('Round closed, credited back:', ethers.formatEther(refunded), 'ETH');
    return { ready: false, timedOut: true, refunded };
  }
}
```

The `cids` must point to query packages the oracles can read, and `classId` must be a class that oracles list: on 2026-11-22 all 40 oracles on Base mainnet listed class 128.

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
- Check the [Fees Guide](../advanced/fees.md) to understand what a request costs in ETH
