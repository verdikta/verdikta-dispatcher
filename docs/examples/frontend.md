# Frontend Integration Guide

How to interact with the Verdikta Dispatcher contracts from a browser-based frontend using ethers.js and MetaMask: send a v2 request with its jury, move the round on, and read the result. The patterns follow the reference applications in the [`verdikta-applications`](https://github.com/verdikta/verdikta-applications) repository.

!!! note "Checked against the code (v2)"
    Rewritten on 2026-11-25 for the v2 contracts on the `beacon` branch ([`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/beacon/reputationBasedAggregator/contracts/ReputationAggregator.sol)). v2 is not deployed yet: use the aggregator address set at the v2 deployment. The transaction-flow functions on this page were run against the v2 contracts on Hardhat's in-process network, with the repository's `TestOperator` standing in for the arbiters and a Hardhat signer standing in for the browser wallet. The ReputationAggregator is paid in ETH sent with the request: the user needs no LINK and approves no token.

## Prerequisites

- **ethers.js** v6+
- A browser wallet (MetaMask)
- ETH on the target network, for the evaluation prepayment and for gas. For a Small jury at the fee ceiling used on this page the prepayment is 0.0027 ETH, most of which is credited back (see [Sizing the ETH Prepayment](#1-sizing-the-eth-prepayment))
- The address of the v2 ReputationAggregator on that network

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

The v2 aggregator's address is set at the v2 deployment. The addresses `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` (Base) and `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` (Base Sepolia) are the **v1** aggregators, which take the v1 request and do not work with the code on this page. See the [Deployment Guide](../deployment/index.md).

## Contract ABIs

Use human-readable ABI fragments: you only need the functions, events and errors your frontend uses. A minimal ABI for the v2 ReputationAggregator, and the one `JuryBeacons` view a frontend needs:

```javascript
const AGGREGATOR_ABI = [
  // Write. The request is payable: the ETH that funds the round travels with it
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury) payable returns (bytes32 aggId)',
  'function drawJury(bytes32 aggId)',
  'function closeCommits(bytes32 aggId)',
  'function promote(bytes32 aggId)',
  'function settle(bytes32 aggId)',
  'function cancelUnsealed(bytes32 aggId)',
  'function withdrawEth()',

  // Read
  'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
  'function maxOracleFee() view returns (uint256)',
  'function ethOwed(address payee) view returns (uint256)',
  'function beacons() view returns (address)',
  'function getRoundInfo(bytes32 aggId) view returns (uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock, uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards, uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime)',
  'function getJury(bytes32 aggId) view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout)',
  'function getEvaluation(bytes32 aggId) view returns (uint256[] likelihoods, string justifications, bool valid)',
  'function getOutcomeScores(bytes32 aggId, uint256 outcome) view returns (uint256[] scores, bool valid)',
  'function isFailed(bytes32 aggId) view returns (bool)',

  // Events
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward)',
  'event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons)',
  'event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock)',
  'event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted)',
  'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
  'event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase)',
  'event RoundSettled(bytes32 indexed aggRequestId, bool failed)',
  'event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool)',   // the amount goes to the arbiter pool
  'event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount)',   // requester 0 = the pool
  'event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount)',

  // Custom errors, so that a revert can be decoded by name
  'error InsufficientPayment()',
  'error BadInput()',
  'error BadJury()',
  'error KeeperNotSet()',
  'error WrongPhase()',
  'error TooEarly()',
  'error NotDue()',
  'error SeedExpired()',
  'error DrawExpired()',
  'error NothingOwed()',
  'error EnforcedPause()'
];

const BEACONS_ABI = [
  'function result(address aggregator, bytes32 aggId) view returns (uint8 state, bytes32 mix, uint256 readyAt, address[] payees)'
];
```

`BadJury()` is declared in the aggregator's library (`AggregatorLib`) and reaches the caller unchanged. The CID and addendum checks revert with the library's own errors; see the [Error Reference](../api/errors.md). No token ABI is needed. The legacy ReputationSingleton is a different case: it is paid in LINK and needs a LINK approval before the request. See [its page](../contracts/reputation-singleton.md).

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

A v2 round takes several transactions: the request (which only escrows), the draw (twice with beacons), and, when nobody else sends them, `closeCommits`, `promote` and, for a dead round, `settle`. Anyone may send each of them. The draw pays a reward to the requester if it comes within 30 seconds, so a frontend should send it itself, as soon as block B+2 exists.

### 1. Sizing the ETH Prepayment

There is nothing to approve. The request must carry `maxTotalFee(maxFee, minFee, withBeacons, K, P)` in ETH for the jury it asks for, less any credit the user already holds in the aggregator, which the contract uses first:

```javascript
const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };   // the bounty program's Small preset

async function prepaymentForRequest(signer, aggregatorAddress, { maxFee, minFee = 0n, withBeacons = false, jury = SMALL }) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);

  // max(ceiling, floor) x (K + 3 x P [+ 2 beacons]) + ceiling x (2 + 1) with the default settings
  const required = await aggregator.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P);
  const credit = await aggregator.ethOwed(await signer.getAddress());
  const value = required > credit ? required - credit : 0n;

  return { required, credit, value };
}
```

`maxTotalFee()` is a worst-case budget, not the price. With a Small jury and a ceiling of 0.00015 ETH it returns 0.0027 ETH. If every juror posts 0.00002 ETH, a completed round credits the base fees (6 × 0.00002) and the bonuses (3 clustered × 3 × 0.00002), pays the draw and promote rewards (0.0003 and 0.00015 ETH), and refunds 0.00195 ETH. If the user draws, the draw reward comes back too, so the round cost 0.00045 ETH; if the user also promotes, as the loop below does when nobody is faster, 0.0003 ETH. Show the user both numbers. See [Fee Mechanisms](../advanced/fees.md).

### 2. Submitting an Evaluation Request

Use the dry-run pattern: call `staticCall` first to catch errors (`BadJury()`, `InsufficientPayment()`, `BadInput()`) before spending gas. Pass the same `value` to the dry run.

```javascript
async function requestEvaluation(signer, aggregatorAddress, params) {
  const { cids, addendum, alpha, maxFee, minFee = 0n, estimatedBaseCost, maxFeeScaling, classId,
          withBeacons = false, jury = SMALL } = params;
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const args = [cids, addendum, alpha, maxFee, minFee, estimatedBaseCost, maxFeeScaling, classId, withBeacons, jury];

  const { value } = await prepaymentForRequest(signer, aggregatorAddress, { maxFee, minFee, withBeacons, jury });

  // Dry-run: check if the transaction would succeed
  try {
    await aggregator.requestAIEvaluationWithApproval.staticCall(...args, { value });
  } catch (error) {
    const reason = decodeRevertReason(error, [aggregator]);
    throw new Error(`Request would fail: ${reason || error.message}`);
  }

  // The request also settles due rounds, so its gas varies: add headroom
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

### 3. Moving the Round On

`getRoundInfo()` gives the phase and the timing; the function below names the call that is due now, if any. It treats the next block as the one a transaction sent now lands in.

```javascript
const PHASES = ['', 'draw', 'beacons', 'commit', 'closing', 'reveal', 'final', 'settled', 'failed', 'cancelled'];

async function nextStep(provider, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);
  const [r, jury, latest] = await Promise.all([
    aggregator.getRoundInfo(requestId), aggregator.getJury(requestId), provider.getBlock('latest')
  ]);
  const phase = Number(r.phase);
  const block = BigInt(latest.number) + 1n;
  const now = BigInt(latest.timestamp);

  if (phase === 1 || phase === 2) {
    const sealed = r.sealedHash !== ethers.ZeroHash;
    // undrawable: a day after the request, or blockhash(B+1) gone unsealed (8,191 blocks)
    if (sealed ? now > r.requestTime + 86400n : block > r.requestBlock + 8192n) return { phase, step: 'cancelUnsealed' };
    if (phase === 1) return { phase, step: block >= r.requestBlock + 2n ? 'drawJury' : null };
    const beacons = new ethers.Contract(await aggregator.beacons(), BEACONS_ABI, provider);
    const [state] = await beacons.result(aggregatorAddress, requestId);
    return { phase, step: state === 2n || state === 3n ? 'drawJury' : null };   // ready, or quorum missed
  }
  if (phase >= 3 && phase <= 6 && now > r.deadline) return { phase, step: 'settle' };
  if (phase === 3 && now > r.windowEnd && r.commits >= jury.M) return { phase, step: 'closeCommits' };
  if (phase === 4 && block >= r.closeBlock + 2n) return { phase, step: 'promote' };
  return { phase, step: null };
}

async function sendStep(signer, aggregatorAddress, requestId, step) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const receipt = await (await aggregator[step](requestId)).wait();
  return { step, txHash: receipt.hash };
}
```

Each step can fail because someone else sent it first (`WrongPhase()`), or a block too early (`TooEarly()`): read the phase again and carry on. `cancelUnsealed` sends the whole prepayment to the arbiter pool, so it is worth sending only to tidy up; a frontend that draws promptly never needs it.

### 4. Reading Evaluation Results

The result is readable from finalization (phase 6), before settlement:

```javascript
async function checkEvaluationReady(provider, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);

  const [scores, justifications, valid] = await aggregator.getEvaluation(requestId);
  if (!valid) return { ready: false };

  const jury = await aggregator.getJury(requestId);
  // each counted juror's own score for outcome 0, in reveal order
  const [perJuror] = await aggregator.getOutcomeScores(requestId, 0);

  return {
    ready: true,
    scores: scores.map(s => Number(s)),
    justificationCids: justifications.split(','),
    jury: { K: Number(jury.K), M: Number(jury.M), N: Number(jury.N), P: Number(jury.P), timeout: Number(jury.timeout) },
    perJuror: perJuror.map(s => Number(s))
  };
}
```

Scores are on the arbiters' 0 to 1,000,000 scale. A question that asks for one number gets a one-value result.

### 5. Dead Rounds

A round still in the commit, closing or reveal phase at its `deadline` has failed, but `isFailed()` stays false until someone calls `settle()`. Until then its refund stays in the round. `nextStep()` returns `'settle'` for it. Settling credits the unspent prepayment back to the requester, except when M commits arrived and the round was never promoted: then the slots that committed share it (`CommitPayment`), so that nobody can abort a jury they dislike for a refund. New requests settle due rounds too (in queue order, until `settlePerRequest()` × their own K slots are spent), but a round not yet past its deadline stops that walk, so don't count on it.

```javascript
async function settleDeadRound(signer, aggregatorAddress, requestId) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, signer);
  const receipt = await (await aggregator.settle(requestId)).wait();

  // The unspent prepayment, if it came back, is now the requester's credit
  const refunded = extractEventArg(receipt, aggregator, 'RequesterRefunded', 'amount');
  return { txHash: receipt.hash, refunded };
}
```

Calling `settle()` before the deadline reverts with `NotDue()`. The `RequesterRefunded` event names the address credited: address(0), the arbiter pool, for the indivisible remainder of the committers' shares, if there is one.

### 6. Collecting Refunds and Rewards

Refunds and the draw and promote rewards are credits inside the aggregator. A credit pays for the user's next request before new ETH is asked for (`prepaymentForRequest()` above takes it into account), or the user takes it out:

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


## Driving and Watching the Round

Evaluation requests are asynchronous: arbiters respond off-chain and fulfill on-chain. The loop below sends each step when it is due and returns once there is a result or the round is closed. A round that is not drawn can never finish, so keep the loop running from the request on.

```javascript
async function driveUntilDone(signer, aggregatorAddress, requestId, options = {}) {
  const {
    intervalMs = 3000,     // poll every 3 seconds
    onStep = () => {}      // optional progress callback
  } = options;
  const provider = signer.provider;

  for (;;) {
    const { phase, step } = await nextStep(provider, aggregatorAddress, requestId);

    if (step) {
      try {
        onStep(PHASES[phase], step);
        await sendStep(signer, aggregatorAddress, requestId, step);
      } catch (error) {
        onStep(PHASES[phase], `${step} failed: ${decodeRevertReason(error, []) || error.message}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
      continue;
    }

    if (phase === 6 || phase === 7) return checkEvaluationReady(provider, aggregatorAddress, requestId);
    if (phase === 8 || phase === 9) return { ready: false, status: PHASES[phase] };

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
```

How long a round takes: the draw from two blocks after the request, then the commit phase (closed at the M+-th commit, or after `tPlus()`, 155 seconds), the promotion two blocks later, and at least `revealWindow()` (120 seconds) for the reveals. A round has no result once its `deadline` (the jury's timeout after the draw, extended for a late close or a late promotion) has passed. v2 has not run on a public network yet, so there are no latency measurements for it.

### Event-Based Notification

For production applications, use the aggregator's events instead of polling for the result, and keep the step loop for the calls. `FulfillAIEvaluation` arrives when the result is available:

```javascript
function listenForFulfillment(provider, aggregatorAddress, requestId, callback) {
  const aggregator = new ethers.Contract(aggregatorAddress, AGGREGATOR_ABI, provider);

  // With a filter object, ethers v6 passes the listener one argument:
  // the event, whose `args` hold the event's values
  const filter = aggregator.filters.FulfillAIEvaluation(requestId);
  aggregator.once(filter, (event) => {
    const [aggRequestId, likelihoods, justifications] = event.args;
    callback({
      requestId: aggRequestId,
      scores: likelihoods.map(l => Number(l)),
      justificationCids: justifications.split(',')
    });
  });

  // Return cleanup function
  return () => aggregator.removeAllListeners(filter);
}
```

The other events mark the round's steps: `JuryDrawn` (and `BeaconStageStarted` first, with beacons), `CommitWindowClosed`, `CommitPhaseComplete` (the promotion), `EvaluationFailed(aggId, phase)` and `RoundSettled(aggId, failed)`. See the [Events Reference](../api/events.md).

## Complete Example: Request and Wait

Putting it all together: submit a request with its ETH prepayment, drive the round, and report the result or the failure:

```javascript
async function evaluateContent(signer, aggregatorAddress, cids, classId = 128) {
  const maxFee = ethers.parseEther('0.00015');   // fee ceiling per arbiter

  // 1. Submit request. The prepayment is sized and sent inside requestEvaluation()
  const { requestId, valueSent } = await requestEvaluation(signer, aggregatorAddress, {
    cids,
    addendum: '',
    alpha: 500,
    maxFee,
    estimatedBaseCost: 8_000_000_000n,           // 8e9 wei, below the fee ceiling
    maxFeeScaling: 5,
    classId,
    jury: SMALL
  });
  console.log('Request submitted:', requestId, 'with', ethers.formatEther(valueSent), 'ETH');

  // 2. Draw, close, promote, and settle if the round dies
  const result = await driveUntilDone(signer, aggregatorAddress, requestId, {
    onStep: (phase, step) => console.log(`${phase}: ${step}`)
  });

  if (result.ready) console.log('Evaluation complete:', result.scores);
  else console.log('No result:', result.status);   // 'failed' or 'cancelled'
  return { requestId, ...result };
}
```

The `cids` must point to query packages the arbiters can read, and `classId` must be a class that registered arbiters list.

## Performance Tips

| Technique | Description |
|-----------|-------------|
| **Cache contract instances** | Create `new ethers.Contract(...)` once and reuse it |
| **Debounce RPC calls** | Batch identical view calls within a short time window |
| **Use read-only providers** | Use `JsonRpcProvider` for view calls instead of routing through MetaMask |
| **Status caching** | Cache `getRoundInfo()` and `getEvaluation()` results with a short TTL (a few seconds); a result never changes once valid |
| **Prevent duplicate connections** | Guard against concurrent `connect()` calls with a promise lock |

## Next Steps

- Review the [Smart Contract Integration Walkthrough](integration.md) for on-chain client patterns
- See [Integration Examples](index.md) for a reusable `verdikta.js` module and React and Vue hooks
- Consult the [Events Reference](../api/events.md) for all events you can listen to
- See the [Error Reference](../api/errors.md) for handling revert conditions
- Check [Fee Mechanisms](../advanced/fees.md) to understand what a request costs in ETH
