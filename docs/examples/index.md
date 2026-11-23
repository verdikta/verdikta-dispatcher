# Integration Examples

This section provides examples for integrating with the Verdikta Dispatcher smart contracts. Choose the example that best matches your use case and technical requirements.

!!! note "Checked against the code"
    Revised on 2026-11-22 against [`ReputationAggregator.sol`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/contracts/ReputationAggregator.sol) and the aggregator deployed on Base mainnet at [`0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a`](https://basescan.org/address/0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a). Every example on this page uses the ReputationAggregator, the production contract, which is paid in ETH sent with the request: there is no LINK to hold and no token to approve. The Solidity and JavaScript examples were compiled and run against a local fork of Base mainnet (the React and Vue examples under minimal stand-ins for the two frameworks), and the Hardhat test was run in the repository. Earlier versions of this page built their examples on ReputationSingleton and SimpleContract, the legacy contracts that are paid in LINK; see [Legacy Contracts](#legacy-contracts).

## Before You Start

The examples share a few values. Each can be read from the contract or the chain.

| Value | Used here | Where it comes from |
|-------|-----------|---------------------|
| Fee ceiling per oracle (`_maxOracleFee`) | 0.00015 ETH (`15e13` wei) | The value used by the repository's `DemoClient.sol` and `scripts/single-query.js`. It must be at least the fee the oracles charge: 0.00002 ETH for all 40 oracles on Base mainnet on 2026-11-22 (the ReputationKeeper's `getOracleInfo(operator, jobId)`). A value above the contract's `maxOracleFee()` (0.0004 ETH) is lowered to it |
| Base cost (`_estimatedBaseCost`) | `8e9` wei | Same scripts. It must be lower than the fee ceiling, or the request reverts with "Base cost must be less than max fee" |
| Oracle class (`_requestedClass`) | 128 | All 40 oracles on Base mainnet listed class 128 on 2026-11-22 (the keeper's `getOracleClasses(i)`). None listed class 1 |
| ETH to send | `maxTotalFee(_maxOracleFee)` | With the ceiling above this is 12 × 0.00015 = 0.0018 ETH. It is a worst-case budget: the round spends the fees of the oracles it selected and the rest is credited back to the requester |
| Aggregator | `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` on Base, `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` on Base Sepolia | [Deployment Guide](../deployment/index.md) |

Two more points apply to every example:

- **The evidence CIDs must point to query packages the oracles can read.** A CID of an arbitrary file gets no answer and the round times out. See the comment above `CID` in [`scripts/single-query.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/scripts/single-query.js), which also names a test package.
- **A contract that makes the request is the requester.** The unspent part of each prepayment is credited to the contract, not to the user who called it. The credit pays for the contract's next request before new ETH is asked for, or the contract collects it with `withdrawEth()`.

## The Interface

The Solidity examples below use this interface. Put it in the same file, above the example contract.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IReputationAggregator {
    // Payable: the ETH that funds the round travels with the call
    function requestAIEvaluationWithApproval(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass
    ) external payable returns (bytes32);

    // Worst-case ETH (wei) for one round at this fee ceiling
    function maxTotalFee(uint256 requestedMaxOracleFee) external view returns (uint256);

    // ETH (wei) the aggregator holds for an address: refunds and oracle earnings
    function ethOwed(address payee) external view returns (uint256);

    function getEvaluation(bytes32 aggId)
        external view returns (uint256[] memory likelihoods, string memory justifications, bool hasValidData);

    // True once a round has been closed as failed by finalizeEvaluationTimeout()
    function isFailed(bytes32 aggId) external view returns (bool);

    function getAggregationStatus(bytes32 aggId)
        external view returns (
            bool isComplete,
            bool failed,
            bool commitPhaseComplete,
            uint256 commitExpected,
            uint256 commitReceived,
            uint256 responseCount,
            uint256 requiredN,
            uint256 clusterP,
            address requester,
            uint256 startTimestamp
        );

    function responseTimeoutSeconds() external view returns (uint256);

    // Close a round that has passed its timeout. Anyone may call it
    function finalizeEvaluationTimeout(bytes32 aggId) external;

    // Send the caller's whole ethOwed balance to the caller
    function withdrawEth() external;
}
```

## Quick Start Examples

### 1. Simple Content Moderation

A basic content filter. The caller sends the prepayment with the call and the contract passes it on.

```solidity
contract ContentModerator {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_ORACLE_FEE = 15e13; // 0.00015 ETH per oracle at most
    uint256 public constant BASE_COST = 8e9;        // below MAX_ORACLE_FEE

    mapping(bytes32 => string) public contentOf;    // request => content CID
    mapping(string => bool) public approvedContent;

    event ModerationRequested(bytes32 indexed requestId, string contentCid);
    event ModerationResult(bytes32 indexed requestId, string contentCid, bool approved);

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    // Worst-case ETH to send with moderateContent()
    function quote() external view returns (uint256) {
        return aggregator.maxTotalFee(MAX_ORACLE_FEE);
    }

    function moderateContent(string calldata contentCid) external payable returns (bytes32 requestId) {
        string[] memory evidence = new string[](1);
        evidence[0] = contentCid;

        // Reverts with InsufficientPayment() if msg.value, plus any credit this
        // contract already holds in the aggregator, is less than quote()
        requestId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence,
            "Content moderation check",
            500,            // equal weight on quality and timeliness
            MAX_ORACLE_FEE,
            BASE_COST,
            5,              // max fee scaling
            128             // oracle class
        );

        contentOf[requestId] = contentCid;
        emit ModerationRequested(requestId, contentCid);
    }

    // Call once the aggregator has emitted FulfillAIEvaluation for requestId
    function recordResult(bytes32 requestId) external {
        string memory contentCid = contentOf[requestId];
        require(bytes(contentCid).length > 0, "Unknown request");

        (uint256[] memory likelihoods, , bool hasValidData) = aggregator.getEvaluation(requestId);
        require(hasValidData, "Evaluation not ready");

        // This example assumes a query package with two outcomes, "approve" first.
        // What each position means is defined by your own query package.
        bool approved = likelihoods[0] > likelihoods[1];
        approvedContent[contentCid] = approved;
        delete contentOf[requestId];
        emit ModerationResult(requestId, contentCid, approved);
    }
}
```

### 2. Dispute Resolution System

A dispute with an amount at stake. The ETH the caller sends covers two things, and the contract keeps them apart: the evaluation prepayment goes to the aggregator, the amount in dispute stays in the contract.

```solidity
contract DisputeResolver {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_ORACLE_FEE = 15e13; // 0.00015 ETH per oracle at most
    uint256 public constant BASE_COST = 8e9;

    struct Dispute {
        address plaintiff;
        address defendant;
        uint256 amount;       // ETH in dispute, held by this contract
        bool resolved;
    }

    mapping(bytes32 => Dispute) public disputes;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function createDispute(
        string[] calldata evidence,
        address defendant
    ) external payable returns (bytes32 evalId) {
        uint256 prepayment = aggregator.maxTotalFee(MAX_ORACLE_FEE);
        require(msg.value > prepayment, "Send the prepayment plus the amount in dispute");

        evalId = aggregator.requestAIEvaluationWithApproval{value: prepayment}(
            evidence,
            "Dispute resolution request",
            500,            // equal weight on quality and timeliness
            MAX_ORACLE_FEE, // highest fee accepted from one oracle, in ETH wei
            BASE_COST,      // base cost estimate, in ETH wei
            5,              // fee scaling factor
            128             // oracle class
        );

        disputes[evalId] = Dispute({
            plaintiff: msg.sender,
            defendant: defendant,
            amount: msg.value - prepayment,
            resolved: false
        });

        // Read the result with aggregator.getEvaluation(evalId), as in example 1,
        // and pay out `amount` according to it. If the round fails
        // (aggregator.isFailed(evalId)), return `amount` to the plaintiff.
    }
}
```

### 3. Arbitration That Favors Quality

The request parameters steer which oracles are selected. This example gives quality more weight than timeliness and accepts every oracle up to the contract's own fee ceiling.

```solidity
contract QualityArbitration {
    IReputationAggregator public immutable aggregator;

    // The contract's own ceiling, maxOracleFee(), was 0.0004 ETH on 2026-11-22.
    // A higher value passed here is lowered to it.
    uint256 public constant MAX_ORACLE_FEE = 4e14;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    // 12 x 0.0004 = 0.0048 ETH with the settings of 2026-11-22
    function quote() external view returns (uint256) {
        return aggregator.maxTotalFee(MAX_ORACLE_FEE);
    }

    function createDispute(
        string[] calldata evidence,
        string calldata description
    ) external payable returns (bytes32 aggId) {
        aggId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence,
            description,
            400,            // alpha below 500: more weight on quality than on timeliness
            MAX_ORACLE_FEE, // accept every oracle that charges up to the ceiling
            8e9,            // base cost
            5,              // max scaling
            128             // oracle class
        );

        // Store dispute details...
    }
}
```

A higher ceiling means a larger prepayment, not a higher cost: the round still pays each selected oracle the fee that oracle registered. On 2026-11-22 every oracle on Base mainnet charged the same fee, so the ceiling and the fee scaling had no effect on which oracles were selected. See [Oracle Selection](../advanced/oracle-selection.md).

## Integration Patterns

### Event-Driven Architecture

```solidity
contract EventDrivenIntegration {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_ORACLE_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    mapping(bytes32 => address) public requesterOf;

    event EvaluationRequested(bytes32 indexed requestId, address requester);
    event EvaluationCompleted(bytes32 indexed requestId, uint256[] results);
    event EvaluationFailed(bytes32 indexed requestId);

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function submitForEvaluation(string[] calldata evidence) external payable returns (bytes32 requestId) {
        requestId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence, "", 500, MAX_ORACLE_FEE, BASE_COST, 5, 128
        );

        requesterOf[requestId] = msg.sender;
        emit EvaluationRequested(requestId, msg.sender);
    }

    // Called by an external service that watches the aggregator's
    // FulfillAIEvaluation and EvaluationFailed events
    function processResults(bytes32 requestId) external {
        require(requesterOf[requestId] != address(0), "Unknown or processed request");

        (uint256[] memory likelihoods, , bool hasValidData) =
            aggregator.getEvaluation(requestId);

        if (hasValidData) {
            delete requesterOf[requestId];
            emit EvaluationCompleted(requestId, likelihoods);
            _handleResults(requestId, likelihoods);
        } else if (aggregator.isFailed(requestId)) {
            delete requesterOf[requestId];
            emit EvaluationFailed(requestId);
        } else {
            revert("Evaluation not ready");
        }
    }

    function _handleResults(bytes32 requestId, uint256[] memory likelihoods) internal {
        // Implementation specific to your use case
    }
}
```

### Factory Pattern for Multiple Disputes

```solidity
contract DisputeFactory {
    IReputationAggregator public immutable aggregator;

    struct DisputeConfig {
        uint256 alpha;          // 0-1000, higher values give timeliness more weight
        uint256 maxFee;         // fee ceiling per oracle, in ETH wei
        uint256 baseCost;       // in ETH wei, below maxFee
        uint256 scalingFactor;
        uint64 oracleClass;
    }

    mapping(string => DisputeConfig) public disputeTypes;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);

        // Configure different dispute types
        disputeTypes["simple"] = DisputeConfig(600, 15e13, 8e9, 2, 128);
        disputeTypes["complex"] = DisputeConfig(400, 4e14, 8e9, 5, 128);
        disputeTypes["urgent"] = DisputeConfig(800, 15e13, 8e9, 3, 128);
    }

    // Worst-case ETH to send with createDispute() for this type
    function quote(string calldata disputeType) external view returns (uint256) {
        return aggregator.maxTotalFee(disputeTypes[disputeType].maxFee);
    }

    function createDispute(
        string calldata disputeType,
        string[] calldata evidence,
        string calldata description
    ) external payable returns (bytes32) {
        DisputeConfig memory config = disputeTypes[disputeType];
        require(config.maxFee > 0, "Invalid dispute type");

        return aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence,
            description,
            config.alpha,
            config.maxFee,
            config.baseCost,
            config.scalingFactor,
            config.oracleClass
        );
    }
}
```

## Frontend Integration Examples

Both examples use ethers v6 and this ABI. The `error` lines let ethers name the aggregator's custom errors when a call reverts.

```javascript
import { ethers } from 'ethers';

export const REPUTATION_AGGREGATOR_ABI = [
    'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass) payable returns (bytes32)',
    'function maxTotalFee(uint256 requestedMaxOracleFee) view returns (uint256)',
    'function ethOwed(address payee) view returns (uint256)',
    'function responseTimeoutSeconds() view returns (uint256)',
    'function getEvaluation(bytes32 aggId) view returns (uint256[] likelihoods, string justifications, bool hasValidData)',
    'function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',
    'function isFailed(bytes32 aggId) view returns (bool)',
    'function finalizeEvaluationTimeout(bytes32 aggId)',
    'function withdrawEth()',
    'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
    'event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications)',
    'event EvaluationFailed(bytes32 indexed aggRequestId, string phase)',
    'error InsufficientPayment()',
    'error NotTimedOut()',
    'error AggregationComplete()',
    'error NothingOwed()'
];

// Sends one request and returns its ID. The ETH travels with the call.
export async function sendRequest(contract, signer, cids, description, options = {}) {
    const maxFee = options.maxFee ?? ethers.parseEther('0.00015');   // fee ceiling per oracle
    const args = [
        cids,
        description,
        options.alpha ?? 500,
        maxFee,
        options.baseCost ?? 8_000_000_000n,                           // 8e9 wei, below maxFee
        options.scalingFactor ?? 5,
        options.oracleClass ?? 128
    ];

    // Worst case for the round, less the credit the sender already holds
    const required = await contract.maxTotalFee(maxFee);
    const credit = await contract.ethOwed(await signer.getAddress());
    const value = required > credit ? required - credit : 0n;

    // Oracle selection is random, so the gas used differs from the estimate:
    // add headroom, or the transaction can run out of gas
    const estimate = await contract.requestAIEvaluationWithApproval.estimateGas(...args, { value });
    const tx = await contract.requestAIEvaluationWithApproval(...args, {
        value,
        gasLimit: (estimate * 150n) / 100n
    });
    const receipt = await tx.wait();

    const topic = contract.interface.getEvent('RequestAIEvaluation').topicHash;
    const log = receipt.logs.find(
        l => l.address.toLowerCase() === contract.target.toLowerCase() && l.topics[0] === topic
    );
    if (!log) throw new Error('Request ID not found in transaction receipt');

    return { requestId: log.topics[1], transactionHash: tx.hash, valueSent: value };
}

// 'completed', 'failed', 'timed-out' (nobody has closed the round yet) or 'pending'
export async function readStatus(contract, requestId) {
    const [likelihoods, justifications, hasValidData] = await contract.getEvaluation(requestId);
    if (hasValidData) {
        return {
            status: 'completed',
            likelihoods: likelihoods.map(l => Number(l)),
            justificationCIDs: justifications.split(',')
        };
    }

    if (await contract.isFailed(requestId)) return { status: 'failed' };

    // A round does not fail by itself. After the timeout someone has to
    // call finalizeEvaluationTimeout() before isFailed() turns true
    const round = await contract.getAggregationStatus(requestId);
    const timeout = await contract.responseTimeoutSeconds();
    const latest = await contract.runner.provider.getBlock('latest');
    if (BigInt(latest.timestamp) >= round.startTimestamp + timeout) return { status: 'timed-out' };

    return { status: 'pending' };
}
```

### React Hook for Dispute Management

```javascript
import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContract, useSigner } from './web3-hooks';
import { REPUTATION_AGGREGATOR_ABI, sendRequest, readStatus } from './verdikta';

export function useVerdiktaDispatcher(contractAddress) {
    const signer = useSigner();
    const contract = useContract(contractAddress, REPUTATION_AGGREGATOR_ABI, signer);
    const [disputes, setDisputes] = useState({});
    const [loading, setLoading] = useState(false);

    const update = useCallback((requestId, fields) => {
        setDisputes(prev => ({ ...prev, [requestId]: { ...prev[requestId], ...fields } }));
    }, []);

    const monitorDispute = useCallback((requestId) => {
        const checkResult = async () => {
            try {
                const result = await readStatus(contract, requestId);

                if (result.status === 'pending') {
                    setTimeout(checkResult, 10000); // Check every 10 seconds
                    return;
                }

                // 'completed', 'failed' or 'timed-out'. A timed-out round stays
                // open until finalizeTimeout() below is called
                update(requestId, { ...result, updatedAt: Date.now() });

            } catch (error) {
                console.error('Error monitoring dispute:', error);
                setTimeout(checkResult, 30000); // Retry in 30 seconds
            }
        };

        checkResult();
    }, [contract, update]);

    const submitDispute = useCallback(async (evidence, description, options = {}) => {
        if (!contract) throw new Error('Contract not available');

        setLoading(true);
        try {
            const { requestId, transactionHash, valueSent } =
                await sendRequest(contract, signer, evidence, description, options);

            update(requestId, {
                requestId,
                evidence,
                description,
                status: 'pending',
                submittedAt: Date.now(),
                transactionHash,
                valueSent: ethers.formatEther(valueSent)
            });

            // Start monitoring
            monitorDispute(requestId);

            return requestId;

        } finally {
            setLoading(false);
        }
    }, [contract, signer, update, monitorDispute]);

    // Close a round that has passed its timeout. The unspent part of the
    // prepayment is then credited back to the requester
    const finalizeTimeout = useCallback(async (requestId) => {
        const tx = await contract.finalizeEvaluationTimeout(requestId);
        await tx.wait();
        update(requestId, await readStatus(contract, requestId));
    }, [contract, update]);

    // Take the signer's credit (refunds) out of the aggregator
    const withdrawCredit = useCallback(async () => {
        const tx = await contract.withdrawEth();
        return tx.wait();
    }, [contract]);

    return {
        submitDispute,
        finalizeTimeout,
        withdrawCredit,
        disputes,
        loading,
        contract
    };
}
```

`./web3-hooks` stands for your application's own hooks that return the connected signer and an `ethers.Contract`. `./verdikta` is the file with the ABI and the two functions above.

### Vue.js Composition API Example

```javascript
import { ref, computed, onMounted } from 'vue';
import { ethers } from 'ethers';
import { REPUTATION_AGGREGATOR_ABI, sendRequest, readStatus } from './verdikta';

// uploadToIPFS: your own function that stores a query package and returns its CID
export function useVerdiktaIntegration(contractAddress, uploadToIPFS) {
    const contract = ref(null);
    const signer = ref(null);
    const disputes = ref({});
    const loading = ref(false);
    const error = ref(null);

    const pendingDisputes = computed(() => {
        return Object.values(disputes.value).filter(d => d.status === 'pending');
    });

    const completedDisputes = computed(() => {
        return Object.values(disputes.value).filter(d => d.status === 'completed');
    });

    onMounted(async () => {
        try {
            const { ethereum } = window;
            if (!ethereum) throw new Error('MetaMask not found');

            const provider = new ethers.BrowserProvider(ethereum);
            signer.value = await provider.getSigner();

            contract.value = new ethers.Contract(
                contractAddress,
                REPUTATION_AGGREGATOR_ABI,
                signer.value
            );

        } catch (err) {
            error.value = err.message;
        }
    });

    const submitEvaluation = async (evidenceFiles, description) => {
        if (!contract.value) throw new Error('Contract not initialized');

        loading.value = true;
        error.value = null;

        try {
            // Upload files to IPFS
            const cids = await Promise.all(
                evidenceFiles.map(file => uploadToIPFS(file))
            );

            // Submit evaluation: sizes the ETH to send and adds gas headroom
            const { requestId, transactionHash } =
                await sendRequest(contract.value, signer.value, cids, description);

            disputes.value[requestId] = {
                requestId,
                evidence: cids,
                description,
                status: 'pending',
                submittedAt: new Date(),
                transactionHash
            };

            // Start monitoring
            monitorEvaluation(requestId);

            return requestId;

        } catch (err) {
            error.value = err.message;
            throw err;
        } finally {
            loading.value = false;
        }
    };

    const monitorEvaluation = (requestId) => {
        const poll = async () => {
            try {
                const result = await readStatus(contract.value, requestId);

                if (result.status === 'pending') {
                    setTimeout(poll, 5000);
                    return;
                }

                // 'completed', 'failed' or 'timed-out'
                disputes.value[requestId] = {
                    ...disputes.value[requestId],
                    ...result,
                    updatedAt: new Date()
                };

            } catch (err) {
                console.error('Monitoring error:', err);
                setTimeout(poll, 15000);
            }
        };

        poll();
    };

    // Close a round that has passed its timeout
    const finalizeTimeout = async (requestId) => {
        const tx = await contract.value.finalizeEvaluationTimeout(requestId);
        await tx.wait();
        disputes.value[requestId] = {
            ...disputes.value[requestId],
            ...(await readStatus(contract.value, requestId))
        };
    };

    return {
        disputes,
        pendingDisputes,
        completedDisputes,
        loading,
        error,
        submitEvaluation,
        finalizeTimeout
    };
}
```

## Testing Examples

### Unit Tests with Hardhat

The repository's mocks let you test the ETH flow without a network. Save this file as `reputationBasedAggregator/test/example.test.js` and run `npx hardhat test test/example.test.js` in `reputationBasedAggregator/`.

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ReputationAggregator integration (ETH)", function () {
    const ORACLE_FEE = 2n * 10n ** 13n;       // 0.00002 ETH, what each mock oracle charges
    const MAX_ORACLE_FEE = 15n * 10n ** 13n;  // 0.00015 ETH, the requester's fee ceiling
    const BASE_COST = 8n * 10n ** 9n;
    const K = 6n;                             // oracles polled per request (commitOraclesToPoll)

    let aggregator, user, oracleOwners;

    const request = (value) =>
        aggregator.connect(user).requestAIEvaluationWithApproval(
            ["QmTest123"], "Test evaluation", 500, MAX_ORACLE_FEE, BASE_COST, 5, 128, { value }
        );

    beforeEach(async function () {
        [, user] = await ethers.getSigners();

        const Lib = await ethers.getContractFactory("AggregatorLib");
        const lib = await Lib.deploy();

        // The LINK token is only the path the Chainlink requests travel on.
        // Nobody holds or approves LINK in this test.
        const Link = await ethers.getContractFactory("MockLinkToken");
        const link = await Link.deploy(ethers.parseEther("1000000"));

        const Keeper = await ethers.getContractFactory("MockReputationKeeper");
        const keeper = await Keeper.deploy();

        const Aggregator = await ethers.getContractFactory("ReputationAggregator", {
            libraries: { AggregatorLib: lib.target }
        });
        aggregator = await Aggregator.deploy(link.target, keeper.target);

        // Six mock oracles, each owned by a different address
        const Operator = await ethers.getContractFactory("MockArbiterOperator");
        oracleOwners = [];
        const operators = [];
        for (let i = 0; i < Number(K); i++) {
            const ownerAddress = ethers.Wallet.createRandom().address;
            const operator = await Operator.deploy(ownerAddress);
            oracleOwners.push(ownerAddress);
            operators.push(operator.target);
        }
        await keeper.setOracles(operators, ORACLE_FEE);
    });

    it("takes the prepayment and credits each polled oracle its base fee", async function () {
        const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
        expect(required).to.equal(MAX_ORACLE_FEE * 12n);   // K + B x P = 6 + 3 x 2

        await expect(request(required))
            .to.changeEtherBalances([user, aggregator], [-required, required]);

        for (const ownerAddress of oracleOwners) {
            expect(await aggregator.ethOwed(ownerAddress)).to.equal(ORACLE_FEE);
        }
    });

    it("reverts when too little ETH is sent", async function () {
        const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);

        await expect(request(required - 1n))
            .to.be.revertedWithCustomError(aggregator, "InsufficientPayment");
    });

    it("credits the unspent prepayment back after a timeout", async function () {
        const required = await aggregator.maxTotalFee(MAX_ORACLE_FEE);
        const receipt = await (await request(required)).wait();
        const requestId = receipt.logs
            .map(log => { try { return aggregator.interface.parseLog(log); } catch { return null; } })
            .find(parsed => parsed?.name === "RequestAIEvaluation").args.aggRequestId;

        // Too early: the round is still inside its timeout
        await expect(aggregator.finalizeEvaluationTimeout(requestId))
            .to.be.revertedWithCustomError(aggregator, "NotTimedOut");

        // No oracle answers. Move past the timeout (300 seconds by default)
        await ethers.provider.send("evm_increaseTime", [301]);
        await ethers.provider.send("evm_mine");

        // Nothing closes the round automatically: anyone can, here the user does
        await aggregator.connect(user).finalizeEvaluationTimeout(requestId);
        expect(await aggregator.isFailed(requestId)).to.be.true;

        // The base fees stay with the oracles, the rest is the user's credit
        const refund = required - K * ORACLE_FEE;
        expect(await aggregator.ethOwed(user.address)).to.equal(refund);

        // The credit is paid out on request
        await expect(aggregator.connect(user).withdrawEth())
            .to.changeEtherBalances([user, aggregator], [refund, -refund]);
    });
});
```

The repository's own [`test/aggregatorEth.test.js`](https://github.com/verdikta/verdikta-dispatcher/blob/master/reputationBasedAggregator/test/aggregatorEth.test.js) uses the same mocks to drive a complete round: commit, reveal, bonus and refund.

## Best Practices

### 1. Error Handling

Two points matter when a contract wraps the request in `try`/`catch`. The aggregator reports its own conditions as custom errors (for example `InsufficientPayment()`), which `catch Error(string memory)` does not catch, while the ReputationKeeper reports its conditions as strings. And a round is closed as failed only when someone calls `finalizeEvaluationTimeout()`, so the contract below makes that call itself once the timeout has passed.

```solidity
contract RobustIntegration {
    IReputationAggregator public immutable aggregator;

    uint256 public constant MAX_ORACLE_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    enum EvaluationStatus { None, Pending, Completed, Failed }

    struct SafeEvaluation {
        EvaluationStatus status;
        address requester;
        uint256 submittedAt;
    }

    mapping(bytes32 => SafeEvaluation) public evaluations;

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
    }

    function safeSubmitEvaluation(
        string[] calldata evidence,
        string calldata description
    ) external payable returns (bytes32) {
        try aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            evidence, description, 500, MAX_ORACLE_FEE, BASE_COST, 5, 128
        ) returns (bytes32 requestId) {

            evaluations[requestId] = SafeEvaluation({
                status: EvaluationStatus.Pending,
                requester: msg.sender,
                submittedAt: block.timestamp
            });

            return requestId;

        } catch Error(string memory reason) {
            // Strings come from the ReputationKeeper, for example
            // "No active oracles available with fee <= maxFee and requested class"
            revert(string(abi.encodePacked("Submission failed: ", reason)));
        } catch (bytes memory data) {
            // Custom errors of the aggregator, for example InsufficientPayment():
            // pass them on unchanged so the caller can decode them
            assembly {
                revert(add(data, 32), mload(data))
            }
        }
    }

    function processEvaluation(bytes32 requestId) external {
        SafeEvaluation storage evaluation = evaluations[requestId];
        require(evaluation.status == EvaluationStatus.Pending, "Not pending");

        if (!_isClosed(requestId)) {
            // Still open. If the timeout has passed, close the round here,
            // which credits the unspent prepayment back to this contract.
            // Before the timeout this call reverts with NotTimedOut().
            aggregator.finalizeEvaluationTimeout(requestId);
        }

        (uint256[] memory likelihoods, string memory justifications, bool hasValidData) =
            aggregator.getEvaluation(requestId);

        if (hasValidData) {
            evaluation.status = EvaluationStatus.Completed;
            _handleSuccess(requestId, likelihoods, justifications);
        } else {
            evaluation.status = EvaluationStatus.Failed;
            _handleFailure(requestId);
        }
    }

    function _isClosed(bytes32 requestId) internal view returns (bool isComplete) {
        (isComplete, , , , , , , , , ) = aggregator.getAggregationStatus(requestId);
    }

    function _handleSuccess(
        bytes32 requestId,
        uint256[] memory likelihoods,
        string memory justifications
    ) internal {
        // Implementation specific to your use case
    }

    function _handleFailure(bytes32 requestId) internal {
        // Handle a round that timed out
    }
}
```

### 2. Fee Management

A contract that pays for its requests from its own ETH. It sends only what the round needs beyond the credit it already holds in the aggregator, and it can move its ETH out again.

```solidity
contract FeeManagedIntegration {
    IReputationAggregator public immutable aggregator;
    address public immutable owner;

    uint256 public constant MAX_ORACLE_FEE = 15e13;
    uint256 public constant BASE_COST = 8e9;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _aggregator) {
        aggregator = IReputationAggregator(_aggregator);
        owner = msg.sender;
    }

    // Fund the contract by sending ETH to it. Withdrawals from the
    // aggregator arrive here as well.
    receive() external payable {}

    // ETH this contract would have to add for one more request
    function shortfall() public view returns (uint256) {
        uint256 required = aggregator.maxTotalFee(MAX_ORACLE_FEE);
        uint256 credit = aggregator.ethOwed(address(this));
        return required > credit ? required - credit : 0;
    }

    function submitWithFeeManagement(
        string[] calldata evidence,
        string calldata description
    ) external onlyOwner returns (bytes32) {
        // The aggregator uses this contract's credit first (refunds of
        // earlier rounds), so only the rest has to be sent
        uint256 value = shortfall();
        require(address(this).balance >= value, "Insufficient ETH balance");

        return aggregator.requestAIEvaluationWithApproval{value: value}(
            evidence, description, 500, MAX_ORACLE_FEE, BASE_COST, 5, 128
        );
    }

    // Move the credit out of the aggregator and everything to the owner
    function withdrawAll() external onlyOwner {
        if (aggregator.ethOwed(address(this)) > 0) {
            aggregator.withdrawEth();
        }
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "Transfer failed");
    }
}
```

## Legacy Contracts

[ReputationSingleton](../contracts/reputation-singleton.md) and [SimpleContract](../contracts/simple-contract.md) are legacy contracts that are paid in LINK: the requester approves LINK for the contract before the request, and no ETH is sent with it. Their own pages carry their examples. Use them only if you work with an existing deployment of one of them.

## Next Steps

- **[Frontend Integration](frontend.md)**: Detailed frontend examples
- **[Smart Contract Integration](integration.md)**: A walkthrough of the repository's DemoClient
- **[ReputationAggregator](../contracts/reputation-aggregator.md)**: The contract, its settings and its fee structure
- **[Deployment Guide](../deployment/index.md)**: How to deploy and configure contracts
- **[API Reference](../api/index.md)**: Complete contract interfaces
