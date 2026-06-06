# Migrating Arbiter Payment from LINK to ETH

**Status:** Implemented (ETH aggregator + unit tests landed).
**Scope:** `reputationBasedAggregator/contracts/ReputationAggregator.sol` only. `ReputationKeeper.sol` and `ArbiterOperator.sol` are **not** changed.

This note captures the complete plan, the reasoning behind each decision, and the
facts that were verified while designing it, so the approach can be reconstructed
from this document alone.

> ## Implementation notes — where the shipped code differs from the original design
>
> Three decisions were changed during implementation; this banner is authoritative
> where it conflicts with the prose below (the prose is left intact for its reasoning).
>
> 1. **Pay base to ALL polled oracles at request time, not just responders.**
>    The original §4.5 "pay only responders" rule was **reversed**. Base (1×) is now
>    credited to every one of the K polled oracles' owners up front, in the request
>    transaction (restoring the §2 "all polled paid 1× up front" semantic). Rationale:
>    if base is conditional on committing, a weak arbiter has an incentive to submit a
>    **fake/junk commit** purely to collect base; paying everyone removes that incentive.
>    Freeloaders are still disciplined by the unchanged reputation penalties
>    (`committed*Score`) applied to non-responders at finalize/timeout. Consequences:
>    `baseCredited` is fixed at request (= Σ of all K fees), there is **no** per-slot
>    "base paid" flag and **no** base logic in `fulfill`, and the requester's refund is
>    correspondingly smaller (non-responders' base now flows to those oracles, not back
>    to the requester). Solvency is unchanged: `baseCredited ≤ K·effMaxFee`,
>    `bonusCredited ≤ B·P·effMaxFee`, so `refund = ethReceived − baseCredited −
>    bonusCredited ≥ 0`.
>
> 2. **The optional `withdrawEth(address to)` self-redirect was NOT added.** Only
>    `withdrawEth()` (pays `msg.sender`) and `withdrawEthFor(payee)` (payee/owner trigger,
>    always pays `payee`) exist — minimal ETH-out surface. A payee whose `owner()` cannot
>    receive ETH leaves funds safely credited until ownership is fixed.
>
> 3. **Naming: the surviving contract keeps the canonical name.** The new ETH-funded
>    contract is `contracts/ReputationAggregator.sol` (`contract ReputationAggregator`);
>    the legacy LINK contract was renamed to `contracts/ReputationAggregatorLINK.sol`
>    (`contract ReputationAggregatorLINK`) and kept in-tree as a compiling archive only —
>    it is no longer wired into the deploy scripts. The end state is ETH-only, so the
>    unqualified name belongs to the contract that survives; the legacy one earns the
>    qualifier. Deploy scripts (`01_aggregator.js`/`02_keeper.js`/`03_config.js`) now
>    deploy/configure the ETH contract under the name `ReputationAggregator` unchanged
>    (constructor still takes `linkAddr`; `03_config.js` sets `maxOracleFee = 0.0004 ETH`).
>
> One implementation detail worth recording: the per-aggregation state struct's
> auto-generated public getter was dropped (it overflowed the ABI-encoder stack once the
> ETH accounting fields were added). State is read via two curated views instead:
> `getAggregationStatus(aggId)` and `getEthAccounting(aggId)`. The latter reports
> `reserved` as `0` for a settled round (the refund has moved into `ethOwed`), matching
> the "sum over OPEN aggIds" form of the solvency invariant.

---

## 1. Goal

Stop paying arbiters real value in LINK. Pay them in **ETH** instead, while
**keeping the Chainlink request/response plumbing** that drives the arbiter
network. This is a stepping stone toward a longer-term goal of removing the
Chainlink plumbing entirely.

The migration must be smooth: existing LINK-based arbiters and a new ETH-based
flow should be able to coexist on the **same `ReputationKeeper`** during the
transition, with no flag-day cutover.

---

## 2. How payment works today (baseline)

In `ReputationAggregator` (commit–reveal aggregator):

1. **Base fee (1×), commit phase.** For each of the K selected oracles,
   `requestAIEvaluationWithApproval`:
   - pulls LINK from the requester:
     `LinkTokenInterface(link).transferFrom(msg.sender, address(this), fee)`;
   - sends the request via `_sendSingleOracleRequest → _sendOperatorRequestTo(operator, req, fee)`,
     which under the hood calls `LINK.transferAndCall(operator, fee, encodedRequest)`.
     That LINK becomes the operator's escrowed payment for the job. **Every polled
     oracle is paid 1× up front, responsive or not.**
2. **Reveal phase.** `_dispatchRevealRequests` sends follow-up requests with
   **`fee = 0`**.
3. **Bonus (B×), at finalize.** `_payBonus` does
   `link.transferFrom(requester, operator, fee * bonusMultiplier)` for clustered
   oracles only.

The requester must pre-approve `fee × (K + B·P)` LINK (`maxTotalFee()`).
`OracleInfo.fee` in `ReputationKeeper` is the per-oracle LINK fee, and it is **also**
used by the selection-weighting math (`getSelectionScore`, and the eligibility
filter `oracles[key].fee <= maxFee` in `selectOracles`).

### How LINK is claimed today
LINK accumulates in the **operator contract** (base fee escrow released on
fulfillment; bonus transferred straight into the operator's balance). The node
operator claims it with a single `onlyOwner` call on **their own operator**:
`Operator.withdraw(recipient, amount)`. It is pull-based and manual/scripted.

---

## 3. Key insight: the Chainlink rail already accepts 0 LINK

The Chainlink Operator request is *carried* by LINK: a request is initiated by
`LINK.transferAndCall(operator, payment, data)`, whose `onTokenTransfer →
operatorRequest` path emits the `OracleRequest` event the off-chain node listens
for. There is no non-LINK way to start a job in this architecture, which is why we
**keep the rail** but make the LINK amount zero.

Verified facts that make a **0-LINK** request work end-to-end:

- **Contract layer (operator).** `operatorRequest → _verifyAndProcessOracleRequest
  → emit OracleRequest(..., payment, ...)` has no `payment > 0` requirement. Escrow
  math uses an internal constant `ONE_FOR_CONSISTENT_GAS_COST = 1` (escrow starts at
  1 juel so the slot never zeroes — a gas trick), **not** a per-request minimum.
- **Token layer.** ERC-677 `transferAndCall(operator, 0, data)` still fires
  `onTokenTransfer`, so a 0-value request is delivered.
- **Node layer (the real gate).** Whether a 0-payment `OracleRequest` is *serviced*
  is decided by the node's `MinContractPayment` / per-job `minContractPaymentLinkJuels`.
  In `verdikta-arbiter` this is **explicitly set to `0`**:
  - `chainlink-node/config_template.toml` → `[[EVM]] ... MinContractPayment="0"`
  - `chainlink-node/basicJobSpec` sets **no** per-job override, so the global `0`
    applies.
- **Empirical confirmation.** The aggregator's reveal phase already sends `fee = 0`
  through the identical code path, emitting an independent `OracleRequest` the node
  must service to return reveal data. Reveals complete in production ⇒ the node
  already accepts 0-payment requests.

**Decision: send 0 juel.** The new ETH aggregator sends
`transferAndCall(operator, 0, data)` and needs **no LINK balance at all** (drop the
`transferFrom`). The node already accepts 0-payment requests (`MinContractPayment="0"`,
confirmed above and proven by the reveal phase). To keep the 0 choice robust against
future node-config drift (e.g. a re-deployed node with a non-zero `MinContractPayment`),
optionally pin `minContractPaymentLinkJuels = 0` directly in `basicJobSpec` so it does
not rely on the global setting. (Sending 1 juel was considered as a hedge but rejected:
it would force the aggregator to hold a tiny LINK reserve for no real benefit given the
node config.)

Sources:
- `verdikta-arbiter` `chainlink-node/config_template.toml` (`MinContractPayment="0"`)
- `verdikta-arbiter` `chainlink-node/basicJobSpec` (no per-job minimum)
- Chainlink direct-request job docs — `minContractPaymentLinkJuels` semantics
  (https://docs.chain.link/chainlink-nodes/oracle-jobs/all-jobs)

---

## 4. Design decisions

### 4.1 Which contracts change — aggregator only

- **`ArbiterOperator` — no change.** It escrows whatever payment arrives (0 is fine)
  and fulfills. No ETH ever flows through it on the request/fulfill payment path, because
  ETH is paid by the *aggregator*, not through the operator. (It extends `OperatorMod`, a
  Verdikta fork of Chainlink's `Operator` — functionally identical on every point used
  here. `OperatorMod` does carry some *unrelated* ETH plumbing, e.g. `distributeFunds`,
  but none of it is on the request/fulfill path, so nothing changes and nothing breaks at
  `payment = 0`; the escrow math is a plain `+= payment` / `-= payment` that works at 0.)
  Crucially, the operator's access gate
  (`_beforeOracleRequest → _approved → isContractApproved`) restricts requests to
  consumers on the ReputationKeeper allow-list, so moving to free (0-LINK) requests
  does **not** open a spam vector — only approved aggregators can trigger jobs.
  **Precondition:** `_approved` is **fail-open when the operator's keeper list (`rkList`)
  is empty** (it returns `true`), so the 0-LINK anti-spam guarantee holds only while at
  least one ReputationKeeper is registered on the operator. This is the case in production,
  but the migration must not deploy/operate an operator with an empty `rkList`.
- **`ReputationKeeper` — no change**, given the two design choices below (reinterpret
  `fee`, pay the oracle's `owner()`). In particular there is **no `setFee` function**:
  changing an arbiter's fee requires deregister + re-register (an arbiter restart), the
  same as today. See §5.4.
- **`DemoClient` and any consumer contract** drop `link.approve(...)` and instead send
  ETH (`{value: ...}`) with the request. Example/client code, not core infra.

### 4.2 Pull (escrow) payment, not push

**Decision: pure pull.** The aggregator **holds the ETH and releases it on demand**
(`withdrawEth()` / `withdrawEthFor(payee)`), rather than `.call{value:}`-ing owners at
runtime.

**The trigger is restricted to {payee, owner}; the destination is always the payee.** A
withdrawal always sends `ethOwed[payee]` to `payee` — the credited arbiter owner or a
requester awaiting refund — and *never* to a caller-chosen or contract-owner address.
Only two callers may *trigger* a payout (`withdrawEthFor(payee)`): the **payee
themselves**, or the **contract owner** — and because the destination is hardcoded to the
credited payee, neither can divert funds. The owner can only *accelerate* a payout to its
rightful owner, which is why owner-trigger is **not** the forbidden owner-sweep of §7
step 8 (that ban is about owner-*destined* withdrawals): trigger and destination stay
separate, so the trigger carries no theft risk. This is deliberately **narrower than a
fully permissionless trigger** — we drop third-party/cleanup-bot triggering so that a
recyclable requester credit (§4.5, fund-from-credit) cannot be forced out of the contract
by a griefer. The owner-trigger is an early-days convenience to clear accounts when
needed; since the contract is `Ownable`, ownership can later be renounced, after which
`owner()` is `address(0)` and **only the payee can trigger** — the maximally robust end
state. Crucially, a standalone withdrawal is **not in any critical path** (unlike the
pushes below), so a reverting payee only fails that one call — it does not reintroduce the
DoS vector.

> **Frequent-withdrawal griefing — largely removed by the restricted trigger.** Because
> only the payee or the owner may trigger a withdrawal, a third-party attacker can no
> longer flush a payee's balance at all — the original griefing vector (anyone forcing
> per-credit flushes) is gone. The only trigger besides the payee is the **owner**, which
> is trusted; a misbehaving owner could repeatedly flush a payee, but it pays the gas, the
> funds still go to the payee, and there is no fund loss, DoS, or reentrancy
> (CEI + `nonReentrant`). A withdrawal still pays the *entire* `ethOwed[payee]` and zeroes
> it, so even that cannot slice a balance into dust. This restriction is also what protects
> the recyclable requester credit of §4.5 (fund-from-credit): no outside party can force a
> requester's working balance out of the contract.

Reason — a push can be *blocked by the recipient*:
- Owner addresses are arbitrary; some are contracts with reverting / gas-hungry /
  non-payable receive paths.
- Pushing base fees in the K-loop ⇒ one reverting recipient reverts the whole
  `requestAIEvaluationWithApproval` (nobody can start evaluations).
- Pushing bonuses at finalize is worse: `_finalizeAggregation` is in the
  **completion/consensus path** (called from `fulfill` on the Nth reveal and from
  `finalizeEvaluationTimeout`). A reverting bonus send would make finalize revert and
  the round could **never complete**. `finalizeEvaluationTimeout` is callable by
  anyone, so this is a griefing/DoS vector.

A pull credits a storage balance (`ethOwed[payee] += amount`) — it cannot fail on
the recipient's behalf. A bad recipient only fails *its own* later withdrawal, in
isolation (the call reverts and the balance is restored — see §7 step 5), without
blocking anyone else. This is also *safer than today's LINK design*, where payment goes
to a well-behaved operator contract; switching the recipient to arbitrary owner
addresses is exactly what introduces revert risk, so push would be a regression.

**Trade-off accepted:** the aggregator custodies unclaimed ETH (a shared honeypot)
and a payout needs one extra transaction (which the payee or, in early days, the owner
may submit — see above). Mitigations: thorough tests, checks-effects-interactions +
`nonReentrant`, and **no owner ETH-sweep function** (the owner may *trigger* a payout but
never *redirect* one). One capability is intentionally given up versus a fully
permissionless trigger: a third-party/cleanup bot can no longer home an **arbiter
owner's** earnings on its behalf, so arbiter owners self-claim with `withdrawEth()` — the
same manual-claim posture as today's LINK flow (§2), so no regression. Genuinely abandoned
funds (dead/lost payee address) stay claimable indefinitely by design; reclaiming those
would require a separate, time-gated escheatment feature — deliberately out of scope here,
as it reopens a bounded version of the owner-sweep trust question.

> A *try-push-then-credit* middle ground (attempt a gas-limited `.call`, fall back to
> crediting `ethOwed` on failure) was considered and **rejected** in favor of pure pull
> — it adds code for a "money just arrives" UX that is not required here.

### 4.3 Payee = the oracle's `owner()`, behind a swappable seam

**This is a deliberate change of recipient, not a continuation of today's flow.**
Today payment lands in the **operator contract**, not in any owner address: the base
fee is escrowed inside the `ArbiterOperator` via `LINK.transferAndCall(operator, fee, …)`
(released to the operator's withdrawable balance on fulfillment), and the bonus is
`link.transferFrom(requester, operator, …)` straight into the operator contract. The
node runner then *claims* that LINK with `Operator.withdraw(recipient, amount)`
(`onlyOwner`). The operator's `owner()` is used today only to (a) administer the operator
and call `withdraw()`, and (b) receive the VDKA **stake** refund from the keeper's
`deregisterOracle` — it is **not** the address that receives payment.

The ETH aggregator instead credits ETH to `IOracleOwner(oracle).owner()` directly
(`ethOwed[_payeeFor(oracle)] += …`), collapsing today's two hops
(requester → operator contract → owner's `withdraw`) into one
(requester → aggregator ledger keyed on `owner()` → owner's `withdrawEth`). So the
operator contract is removed from the money path entirely — which is exactly the §6
goal (operator is transport-only, touches no money) and is why `ethOwed` keys on a plain
address that survives the operator contract's eventual removal. No payout-address storage
is needed. To stay forward-compatible (§5), resolve the payee through a small internal
helper (`_payeeFor(oracle)`) rather than hard-calling `owner()` everywhere — so the future
"oracle = node wallet" world is a one-line change.

Two semantics this pins down:

- **`owner()` must be able to receive ETH.** Withdrawals send ETH *to* `owner()`; if an
  owner is a contract with a non-payable/reverting receive, its withdrawals revert
  (funds stay safely credited, just unclaimable until fixed). Confirm production owners
  are EOAs or payable. The optional `withdrawEth(address to)` (§7 step 5) lets an owner
  redirect *their own* balance to a chosen address — restoring the
  `Operator.withdraw(recipient, …)` flexibility lost by paying `owner()` directly.
- **Payee is snapshotted at credit time.** `ArbiterOperator` is `Ownable`, so `owner()`
  is mutable (`transferOwnership`). The aggregator resolves `_payeeFor(oracle)` when it
  credits, and stores the resolved address in `ethOwed`. Earnings therefore belong to
  **whoever owned the arbiter when the work was credited**, even if ownership later
  transfers (an arbiter sold with pending earnings keeps them with the old owner). This is
  the intended rule; the alternative (resolve owner at withdrawal) would re-insert the
  operator into the money path and is rejected.

> If node operators ever need a payout address distinct from the operator's `owner()`,
> that mapping would live in the keeper (new field + setter) — a keeper change. Not
> needed for the base plan.

### 4.4 Fee denomination — reuse the existing `fee` field as ETH

`OracleInfo.fee` is a single per-oracle value. We do **not** add a separate `ethFee`
field. Instead, ETH-intended arbiters register with a **low `fee` value denominated in
ETH wei**, and the ETH aggregator treats `fee` as ETH. The selection math
(`getSelectionScore`, eligibility filter) is unit-agnostic arithmetic, so it keeps
working as long as a single aggregator's `maxFee` / `estimatedBaseCost` are in the
same unit as the `fee` values it selects against.

This choice is what enables the no-keeper-change migration in §5.

### 4.6 Concrete ETH parameter values

**Verified baseline (live values, not the constructor defaults):**

- `maxOracleFee` is **0.05 LINK** on-chain — `deploy/03_config.js:81-82` calls
  `setMaxOracleFee(0.05 LINK)` immediately after deploy, overwriting the `0.1 LINK`
  set in the constructor (`ReputationAggregator.sol:337`). The 0.05 figure matches the
  website. (Two *manual* scripts — `deploy_just_aggregator.js`, `configure-contracts.js`
  — use 0.08, but the canonical hardhat-deploy path sets 0.05.)
- Prevailing arbiter registration `fee` is **0.002 LINK** (`2e15` wei) on-chain. The
  `0.006` in `scripts/register-oracle.js:18` is only a script default; the keeper
  enforces no floor (`fee > 0` only, `ReputationKeeper.sol:158`), so the on-chain norm
  governs.
- `estimatedBaseCost` and `maxFeeBasedScalingFactor` are per-call requester inputs
  (`scripts/single-query.js:12-13`): `1e-6 LINK` (`1e12` wei) and `5`.

**The curve is scale-invariant.** `getSelectionScore` (`ReputationKeeper.sol:426-440`)
uses only the *ratios* of the monetary triple `(maxFee, oracleFee, estimatedBaseCost)`
— `feeWeighting = min((maxFee − base)/(oracleFee − base), scalingFactor)`. Dividing all
three by one common factor leaves the fee-weighting curve **byte-for-byte** unchanged —
including under the contract's integer division. The ratio's numerator
`(maxFee − base)·1e18` and denominator `(oracleFee − base)` both scale by the *same*
common factor `k`, which cancels *before* truncation: `floor(k·a / k·b) = floor(a/b)` for
positive integers (write `a = qb + r` with `0 ≤ r < b`; then `ac = qbc + rc` and
`floor(rc / bc) = floor(r / b) = 0`). So the truncated quotient is *identical*, not merely
close — there is no off-by-one. `maxFeeBasedScalingFactor` and `bonusMultiplier` are
dimensionless and **do not change**.

**Decision: common factor ÷125** (live ceiling 0.05 LINK → 0.0004 ETH). At
1 ETH ≈ 200 LINK the strict price-peg would be 0.05/200 = 0.00025 ETH; the ceiling is
rounded **up** to 0.0004 ETH to buy margin against ETH/LINK price drift while still
sitting below the 0.002-LINK arbiter band.

| Param | LINK (live) | ÷125 → ETH | wei |
|---|---|---|---|
| `maxOracleFee` (contract ceiling) | 0.05 | 0.0004 | `4e14` |
| `estimatedBaseCost` (per-call) | 1e-6 | 8e-9 | `8e9` |
| request `_maxOracleFee` (per-call) | 0.01 | 8e-5 | `8e13` |
| `maxFeeBasedScalingFactor` | 5 | 5 (unchanged) | — |
| typical arbiter registration `fee` | 0.002 | 1.6e-5 | `1.6e13` |

To preserve the curve exactly, `estimatedBaseCost` **must** scale with the ceiling by
the same ÷125; the per-arbiter registration `fee` is operator-chosen (arbiters vary), so
`1.6e13` is the recommended-norm, not a hard value — it only needs to land between
`estimatedBaseCost` and the ceiling.

**Disjointness (§5.3) check.** ETH ceiling `4e14` < lowest current LINK arbiter `2e15`
(0.002 LINK) ⇒ the keeper's `fee <= maxFee` filter excludes every current LINK arbiter
(≈5× margin). This holds **only while no LINK arbiter registers below 0.0004 LINK**; the
keeper enforces no band, so this is the operational-discipline heuristic of §5.3, with
the clamp (§5.3 layer 1) as the actual on-chain guarantee. The ~5× margin is modest but
**accepted**: the LINK/ETH overlap only exists during the temporary dual-aggregator
window (§5), and the end state is **ETH-only** — once the LINK aggregator is retired
(runbook §8 step 5) there is no LINK band left to stay disjoint from. If LINK arbiters
were to drift toward the ETH band *before* that retirement, lower the ETH ceiling (and
re-scale the triple) rather than relying on non-overlap.

### 4.5 ETH escrow, reserve & refund accounting

This is the part the LINK→ETH switch changes most, because it changes the **funding
model**, not just the token. Today the bonus is *pulled from the requester at finalize*
(`link.transferFrom(requester, operator, fee·B)`), so the contract never escrows it. ETH
has no "pull later": **everything a round might cost must arrive up front in `msg.value`,
and whatever isn't spent must come back.** The design is therefore: *prepay worst case →
credit actual → refund the slack.*

**One pool, one invariant.** Hold a single ETH pool (the contract balance) and keep,
at all times:

```
address(this).balance  ==  Σ_payee ethOwed[payee]  +  Σ_openAggId reserved[aggId]
```

Every wei is either credited to some payee's `ethOwed` (an oracle owner *or* a requester
awaiting refund) or reserved against an open round. `reserved[aggId]` is derived, not
stored: `reserved = ethReceived − baseCredited − bonusCredited`. Withdrawals decrement
`balance` and `ethOwed` in lockstep, so the equality holds forever. This is the property
the tests assert.

**Per-`aggId` state (additions to `AggregatedEvaluation`):**

```solidity
uint256 ethReceived;         // msg.value at request (set once)
uint256 baseCredited;        // Σ base fees credited to responders (== sum of paid pollFees)
uint256 bonusCredited;       // Σ bonus credited at finalize
uint256 bonusMultiplierSnap; // bonusMultiplier captured at request  ← prevents mid-round drift
```

`requiredResponses` (N) and `clusterSize` (P) are already per-agg, so they are safely
snapshotted; `bonusMultiplier` is a live state var today and **must** be snapshotted too
(a mid-round `setBonusMultiplier` raise would otherwise size the bonus above the reserve
and break solvency).

**Pay only responders.** *(SUPERSEDED — see Implementation note 1 at the top: the shipped
code pays base to ALL K polled oracles at request time. The original rationale is kept
below for context.)* Base is **not** credited at request time. It is credited per
oracle **when that oracle's commit is recorded** in `fulfill` (the LINK-equivalent moment —
the base fee rode the commit request, whose fulfillment released the operator's escrow),
guarded by a per-slot "base paid" flag so it cannot double-credit. An oracle that commits
but never reveals keeps its base; one that never commits gets nothing, and its reserved
fee flows back to the requester at settlement. This deviates from the old "all polled paid
1× up front, responsive or not" semantic (§2) and is *closer* to LINK's real economics
(non-responders' escrow was cancellable).

**The paths (single-stage settlement, refund computed once):**

- **Request** (`requestAIEvaluationWithApproval`, now `payable`):
  ```
  effMaxFee = min(_maxOracleFee, maxOracleFee)              // the §5.3 clamp
  require(msg.value >= effMaxFee * (K + bonusMultiplier*P)) // == maxTotalFee(effMaxFee), worst case
  agg.ethReceived = msg.value
  agg.bonusMultiplierSnap = bonusMultiplier
  for each selected oracle: transferAndCall(operator, 0, data)   // 0-juel dispatch, no base credit yet
  ```
  Overpayment is allowed and returned at settlement; no revert on excess.
- **Commit recorded** (in `fulfill`, per responding slot, once):
  ```
  ethOwed[_payeeFor(oracle_slot)] += fee_slot ;  agg.baseCredited += fee_slot
  ```
- **Finalize** (happy path via `fulfill`, or timeout-with-enough-responses):
  ```
  for each clustered slot: bonus = pollFees[slot] * agg.bonusMultiplierSnap
                           ethOwed[_payeeFor(operator)] += bonus ; agg.bonusCredited += bonus
  refund = agg.ethReceived − agg.baseCredited − agg.bonusCredited
  ethOwed[agg.requester] += refund                         // refund as a credit — pull, never push
  agg.isComplete = true
  ```
- **Timeout failure** (commit/reveal-shortfall branches): no cluster ⇒ `bonusCredited == 0`;
  committed responders keep their base; the rest refunds:
  ```
  ethOwed[agg.requester] += (agg.ethReceived − agg.baseCredited)
  agg.failed = true ; agg.isComplete = true
  ```

Across **every** exit path the refund is the same expression
(`ethReceived − baseCredited − bonusCredited`) and base always stays with the responders
it was credited to. That uniformity is what makes the accounting auditable.

**Refund = pure pull, accumulating, recyclable.** The requester is just another payee:
refunds land in `ethOwed[requester]` and **accumulate across queries** into one balance.
The requester claims any number of queries' refunds with a single `withdrawEth()` (or the
owner may trigger `withdrawEthFor(requester)` in early days — always paid to the requester,
never the caller, §4.2). There is no expiry; balances are claimable indefinitely. But the
balance need not be *claimed* to be useful: it can fund subsequent requests in place — see
**"Funding a request from existing credit"** below — so in steady state it is recycled
rather than swept, and a contract requester sees no unwanted ETH pushed into its `receive()`
on every finalize. The only difference from LINK that no refund mechanism can erase is the
**capital lock during a round** — the requester is out the full worst-case `msg.value` (net
of any credit applied) from request until that query settles, inherent to "prepay because
you cannot pull later."

**Finalize does zero external calls.** Because bonus and refund are both *credits*, not
sends, `_finalizeAggregation` and the timeout paths are 100% storage writes — the only
external calls in the whole payment system live in `_withdrawTo` (§7 step 5, `nonReentrant`
+ CEI). The §6 "set `isComplete` before any transfer" concern therefore dissolves: there is
nothing to order against, and `isComplete` serves purely as the re-entry / double-settle
guard.

> **Worst-case bonus bound is loose on purpose.** The reserve uses `B·P·effMaxFee` rather
> than the tight "B × sum of the P largest selected fees." The slack is refunded at
> settlement anyway, so the looser bound (no partial-sort in the hot path) is the right
> trade.

> **Why `B·P` is a valid ceiling (ETH solvency).** Bonus is paid only to slots flagged by
> `AggregatorLib.findBestCluster(ll, selIdx, clusterSize)`, which returns `min(P, count)`
> cluster members (`AggregatorLib.sol`, doc comment line 31). So the number of bonus
> recipients is **≤ P** and `bonusCredited ≤ B·P·effMaxFee` — exactly the reserved amount.
> That is what guarantees `refund = ethReceived − baseCredited − bonusCredited ≥ 0` and so
> finalize never underflows / never gets stuck (under LINK this was masked: an over-budget
> bonus would merely fail the `transferFrom` allowance; under ETH it would be a solvency
> bug, so the cap matters more here). **Edge:** `findBestCluster` seeds the cluster with 2
> members (`clusterSizeNow = 2`), so the bound assumes **`clusterSize ≥ 2`** — setting
> `P = 1` could let a 2-member cluster exceed a `B·1` reserve. Keep `P ≥ 2` (the default),
> and assert `clusteredCount ≤ clusterSize` and `bonusCredited ≤ B·P·effMaxFee` in tests.

**Funding a request from existing credit (recycling refunds).** A requester's accumulated
`ethOwed` need not sit idle until withdrawn — a request may draw on it directly, so only
the *shortfall* needs fresh ETH:

```
required   = effMaxFee * (K + bonusMultiplier*P)        // == maxTotalFee(effMaxFee)
fromCredit = min(ethOwed[msg.sender], required)
require(msg.value + fromCredit >= required)             // msg.value may be 0 if credit covers it
ethOwed[msg.sender] -= fromCredit                       // effect before any external call (CEI)
agg.ethReceived      = fromCredit + msg.value           // total committed to this round
```

The single invariant `balance == Σ ethOwed + Σ reserved` is preserved: `fromCredit` moves
from `ethOwed` into the round's `reserved` (contract balance unchanged), and `msg.value`
adds to both sides equally; at settlement the slack returns to `ethOwed[requester]`,
replenishing the buffer. Only `msg.sender`'s *own* credit can fund `msg.sender`'s request
(no spending of another party's balance), so this adds no theft surface.

This is what keeps the claimable balance **bounded**: rather than accumulating the sum of
all historical refunds, a busy requester's `ethOwed` oscillates around roughly one round's
slack, because each request consumes it. A requester can even **pre-fund once** (send a
lump sum), then fire many requests with `msg.value = 0` drawing on the deposit while refunds
top it back up; the balance then *shrinks* toward zero as queries consume it, and
`withdrawEth()` is needed only to exit. Combined with the restricted trigger (§4.2), the
working balance cannot be forced out by a third party, so the prepaid-account behaviour is
robust **on the single `ethOwed` ledger** — no separate deposit mapping required.

> **How a caller sizes `msg.value`.** Call the `maxTotalFee(_maxOracleFee)` view first; it
> returns the exact worst case `effMaxFee * (K + B·P)`. Send `maxTotalFee − min(credit,
> maxTotalFee)` (or any amount ≥ that — overpayment is refunded). The actual cost depends
> on which oracles are selected and how many respond/cluster and is unknowable at request
> time, so worst-case prepay with slack-refund is inherent to ETH; fund-from-credit only
> changes the *source* of the committed ETH, not the worst-case amount reserved.

---

## 5. The dual-aggregator migration plan (LINK and ETH in parallel, one keeper)

### 5.1 The keeper already serves multiple aggregators
`approveContract(addr)` can approve any number of aggregators. Usage tracking is
**per calling contract** (`approvedContracts[msg.sender].usedOracles`), and
`updateScores` requires the caller to have recorded the oracle — so aggregators
cannot touch each other's score updates. `pushEntropy` from multiple aggregators is
harmless (first-writer-per-block wins). **Reputation scores are global per
`(oracle, jobId)`** and therefore *shared* across aggregators — desirable here,
because an arbiter's history carries seamlessly through the migration.

Because the operator's access gate is **keeper-based** (`isContractApproved`),
approving the new ETH aggregator in the shared keeper **auto-authorizes it at every
node already trusting that keeper** — **no operator change needed**.

### 5.2 Segregation by `maxFee`
- ETH fees are **much smaller numbers** than LINK fees, and the two ranges are kept
  **strictly non-overlapping**.
- The **ETH aggregator** calls `selectOracles` with a **low `maxFee`**. The
  eligibility filter `oracles[key].fee <= maxFee` therefore returns **only low-fee
  (ETH-intended) arbiters**; high-fee LINK arbiters are excluded before selection.
  This direction is clean and automatic.
- The **LINK aggregator** calls with a **high `maxFee`** and sees both. If it happens
  to select a low-fee arbiter, it pays that small number *in LINK* (plus
  `fee × bonusMultiplier`) — a trivial LINK amount. Acceptable on a temporary basis.

### 5.3 The critical safety invariant
> **The ETH aggregator must never be able to select an arbiter whose `fee` was meant
> as LINK.**

If it did, it would interpret a large LINK-scale number (e.g. `1e17`) as **ETH wei**
and try to pay ~0.1 ETH per oracle.

**Important — the contract-level ceiling is NOT enforced today.** A re-read of the
current code shows `maxOracleFee` is a *cosmetic* ceiling: it is used only in the
`maxTotalFee()` view, never in selection. The request entry point passes the
**caller-supplied** `_maxOracleFee` straight through to `reputationKeeper.selectOracles`
(`ReputationAggregator.sol:442`), and the keeper's eligibility filter
(`oracles[key].fee <= maxFee`) uses that raw per-call value. So a caller can pass any
`_maxOracleFee` — up to `type(uint256).max` — and pull LINK-scale arbiters into
selection. The keeper enforces no ceiling either: `registerOracle` only checks
`fee > 0` (`ReputationKeeper.sol:158`), with no upper bound and no LINK/ETH band
separation. Magnitude segregation alone is therefore **not** an on-chain guarantee.

Enforce the invariant in the ETH aggregator on two layers:

1. **Clamp the per-call fee to the contract ceiling (primary mechanism).** In the ETH
   aggregator's request entry point, clamp the caller's `_maxOracleFee` down to the
   contract-level `maxOracleFee` *before* calling `selectOracles`:
   ```solidity
   uint256 effMaxFee = _maxOracleFee < maxOracleFee ? _maxOracleFee : maxOracleFee;
   // pass effMaxFee (not _maxOracleFee) to reputationKeeper.selectOracles(...)
   ```
   This reuses the exact `min` pattern already in `maxTotalFee()` (`:378`), so the fee
   the caller is told to send and the fee selection actually uses finally agree. With
   `maxOracleFee` set strictly **below any LINK arbiter's `fee`**, the keeper's
   `fee <= effMaxFee` filter excludes every LINK-scale arbiter **regardless of what the
   caller passes** — even `type(uint256).max`. The contract ceiling becomes authoritative,
   and this is what makes the §5.2 "segregation by `maxFee`" partition real rather than
   advisory. Clamp semantics (not revert): a caller asking for more silently gets the
   ceiling and the request proceeds with eligible arbiters, matching `maxTotalFee()`'s
   existing behavior.
2. **Fail-safe value check + charge-time guard (defense in depth).** The ETH aggregator
   computes the required ETH from the **actually-selected** fees and **reverts if
   `msg.value` is short** (then refunds any remainder). As each selected oracle's fee is
   read in the charge loop, also assert `fee <= maxOracleFee` — selection and charge are
   in the same transaction with no state change between them, so this is cheap insurance
   against a keeper bug or a future selection-path change. Any accidental high-fee
   selection then fails safe (reverts) instead of draining ETH.

> **Range discipline is a heuristic, not a guarantee.** Keeping LINK and ETH `fee`
> ranges non-overlapping makes the clamp's ceiling easy to place and reasoning simple,
> but it depends on relative token prices and on operational discipline at registration —
> nothing on-chain enforces the bands. The clamp (layer 1) is the actual guarantee; treat
> non-overlap as a convenience that keeps the ceiling unambiguous.

> **Scope.** This clamp and charge-time guard are added in the **new ETH aggregator
> only**. The existing LINK aggregator has the same latent gap (its ceiling is unenforced
> too) but is intentionally left unchanged here.

### 5.4 Changing a fee requires an arbiter restart (no `setFee`)
**Decision: no `setFee` function.** There is no `setFee` in the keeper today, and we
keep it that way. Changing an arbiter's fee requires `deregisterOracle` +
`registerOracle` — i.e. an arbiter restart/re-registration, exactly as required now.
`deregisterOracle` does `delete oracles[key]`, so this **resets the oracle's
reputation** (and refunds/re-stakes VDKA). That reputation reset is **accepted** as the
cost of a fee change.

This matters here because existing arbiters are registered at LINK-scale fees
(prevailing ~0.002 LINK = `2e15`; the live aggregator ceiling is 0.05 LINK, set by
`deploy/03_config.js` — not the 0.1 LINK constructor default), which are far too large to
reinterpret as ETH; an arbiter must
re-register at a genuinely low (ETH-scale) fee to become correct for ETH payment. It
does so by restarting and re-registering — the standard operational flow — starting
fresh reputation, the same as any newly onboarded arbiter.

> A minimal `setFee(...)` to flip fees in place without losing reputation was
> considered and **rejected**: fee changes should require a restart, as they do today.

### 5.5 Expected, benign side effects during the mixed window
- The LINK aggregator's fee-weighting (`getSelectionScore`) gives low-fee (migrated)
  arbiters *less* selection weight, so they naturally see less LINK-aggregator
  traffic — which helps the wind-down.
- Any third-party arbiter selected by the LINK aggregator does real work for a tiny
  LINK payment. Fine if the LINK aggregator is retired promptly; otherwise warn
  operators.

---

## 6. Long-term goal: removing the Chainlink plumbing

The pull-in-aggregator design (this plan) is deliberately chosen because it keeps
**payment** and **transport** in different contracts:

- The **operator is transport-only** and touches no money. All payment logic
  (escrow, `ethOwed`, `withdrawEth`, refunds) lives in the aggregator and has **zero
  dependency on the operator or on LINK**. When Chainlink is later removed, you swap
  the transport (how requests are dispatched and how `fulfill` is authenticated) and
  the payment system is untouched.
- The `ethOwed` ledger keys on a **plain address**, which survives a future world where
  the Operator contract no longer exists (`owner()` would otherwise disappear). Hence
  the `_payeeFor(oracle)` seam in §4.3.

To make the eventual removal a single, isolated cut, structure the aggregator so the
transport lives behind small internal functions today:
- `_dispatchRequest(...)` — today wraps `ChainlinkClient` + `transferAndCall(…, 0, …)`;
  later swapped for a custom request event.
- `fulfill(...)` authentication — today `recordChainlinkFulfillment(requestId)` (which,
  together with the operator's `validateAuthorizedSender`, guarantees only the legit
  node can call back). **This is the real work of removing Chainlink**: you must rebuild
  callback authentication yourself (signed responses, an authorized-fulfiller registry,
  etc.). The payment layer does not need to change for it.

Because payment is transport-agnostic, both transports can even run in parallel during
that later migration, settling through the same ETH ledger.

---

## 7. Implementation checklist (ETH aggregator)

Changes to a new/forked `ReputationAggregator`:

1. **Entry point.** Make `requestAIEvaluationWithApproval` `payable`. Remove the LINK
   `transferFrom`. Fund the round from the caller's existing credit first, then fresh ETH:
   `fromCredit = min(ethOwed[msg.sender], required)`; `ethOwed[msg.sender] -= fromCredit`;
   require `msg.value + fromCredit >= required` where `required = effMaxFee * (K +
   bonusMultiplier·P)` (the worst case, `== maxTotalFee(effMaxFee)`) — so `msg.value` may
   be `0` when credit covers it; accept and later refund any excess. Store
   `agg.ethReceived = fromCredit + msg.value` and snapshot
   `agg.bonusMultiplierSnap = bonusMultiplier`. See §4.5 ("Funding a request from existing
   credit") for the recycling model and the `balance == Σ ethOwed + Σ reserved` invariant.
2. **Dispatch.** In `_sendSingleOracleRequest`, send `transferAndCall(operator, 0, data)`
   (0 LINK; aggregator needs no LINK balance). Keep reveal at 0 as today.
3. **Base credit — responders only (§4.5).** Do **not** credit base at request time.
   Credit `ethOwed[_payeeFor(oracle)] += fee` (and `agg.baseCredited += fee`) **when that
   oracle's commit is recorded** in `fulfill`, guarded by a per-slot "base paid" flag so it
   cannot double-credit. Non-responders are never credited; their reserved fee refunds to
   the requester at settlement. This changes the old "all polled paid 1× up front" semantic.
4. **Bonus credit (§4.5).** Replace `_payBonus`'s LINK `transferFrom` with
   `ethOwed[_payeeFor(operator)] += fee * agg.bonusMultiplierSnap` (use the **snapshot**,
   not the live var) and `agg.bonusCredited += …`. No external transfer occurs in finalize;
   `isComplete` is set after the credits purely as the re-entry / double-settle guard.
5. **Withdraw.** Funnel all payouts through one internal `_withdrawTo(payee)` —
   `nonReentrant`, checks-effects-interactions (read `ethOwed[payee]`, zero it, then
   `call`), and **revert on send failure** so a reverting payee's balance is restored
   rather than burned. Expose `withdrawEth()` (self: `_withdrawTo(msg.sender)`) and
   `withdrawEthFor(address payee)` with a **restricted trigger** — `require(msg.sender ==
   payee || msg.sender == owner())` — which always pays the credited `payee`, never the
   caller (see §4.2). Optionally `withdrawEth(address to)` so a payee may redirect *their
   own* funds. A second flush after a successful one finds `0` owed and reverts harmlessly.
6. **Refunds — pure pull, accumulating (§4.5).** On success, timeout, and the
   `commit`/`reveal` failure paths, credit the requester
   `ethOwed[agg.requester] += agg.ethReceived − agg.baseCredited − agg.bonusCredited`
   (one expression, every path). Never push. The requester is just another payee:
   refunds **accumulate across queries** and are claimed via `withdrawEth()` (or by the
   owner via `withdrawEthFor(requester)`, always paid to the requester — step 5), **or are
   recycled into the next request via fund-from-credit** (step 1, §4.5), which is the normal
   path and keeps the balance bounded. Assert the per-`aggId` reconciliation
   `ethReceived == baseCredited + bonusCredited + refund` and the global
   `balance == Σ ethOwed + Σ reserved` invariant in tests.
7. **Fee ceiling.** Add the clamp so `maxOracleFee` becomes the **hard ETH ceiling**
   (§5.3) — it is unenforced in selection today — and set it strictly below any LINK
   arbiter fee. `maxTotalFee()` becomes ETH-denominated.
8. **No owner ETH-sweep.** Do not add an ETH analog of `withdrawLink` that lets the
   owner move balances to an **owner-chosen / contract-owner destination**. This forbids
   only the *destination*, not the *trigger*: the owner *triggering* `withdrawEthFor(payee)`
   of step 5 is fine because it always pays the credited payee — the owner is just one of
   the two allowed callers (payee or owner), and it can never redirect funds.
   (`withdrawLink` for the tiny LINK reserve, if any, is fine.)
9. **Seams.** Wrap dispatch and fulfill-auth behind internal functions (§6).

No keeper change (no `setFee`; see §5.4).

Off-chain / clients:

10. Update `DemoClient` and consumer examples to drop LINK approval and send ETH.

    > **Client UX — one transaction per request (down from three).** Today a query is three
    > MetaMask signatures: (1) fund/approve LINK into the consumer — the aggregator pulls
    > payment via `transferFrom`, so `DemoClient` must hold LINK and pre-`approve` it
    > (`DemoClient.sol:45-48`, plus `transfer-link`); (2) `request()`; (3) `publish()`, which
    > also resets `currentAggId` so the next request may run. The ETH flow collapses this to
    > **one signed transaction**:
    > - Step 1 **disappears** — native ETH rides with the call as `msg.value`, so there is no
    >   ERC-20 `approve`, no pre-funding the consumer with LINK, and no need to *source* LINK
    >   at all (users already hold ETH for gas). Make the consumer `payable` and forward
    >   `{value:}` to the aggregator. With fund-from-credit (§4.5), repeat requests may even
    >   attach `msg.value = 0`, drawing on accumulated refund credit.
    > - Step 2 is the **single irreducible tx** — `request{value:}()` starts the evaluation.
    > - Step 3 is **not fundamental** — it is a `DemoClient` artifact (on-chain result write +
    >   single-slot `currentAggId` bookkeeping). Read results via the gas-free
    >   `getEvaluation(aggId)` **view** instead, and don't gate the next request on an
    >   on-chain `publish()`. Result retrieval then costs no MetaMask step.
    >
    > The refund adds **no** step: it recycles into the next request via fund-from-credit;
    > `withdrawEth()` is needed only to *exit* (pull ETH back out), never per request.
11. Update scripts/tests under `reputationBasedAggregator/` to the ETH flow.
12. Optionally pin `minContractPaymentLinkJuels = 0` in `verdikta-arbiter`'s
    `basicJobSpec` to make the 0-LINK path robust to node-config changes.

Tests — a **first-class deliverable**, not a risk-table footnote:

13. **There is no existing end-to-end approve→request→fulfill harness.**
    `test/aggregator.test.js` covers only config/getters; `keeper.test.js` only
    registration. The ETH custody/refund code is the part that can **lose funds**, so it
    must ship *with* tests, not have them retrofitted. Build (at minimum):
    - **Full ETH `{value:}` round-trip.** request → commit (base credited to responders)
      → reveal → finalize (bonus credited, requester refund credited) → `withdrawEth()`
      pays out. Assert balances and `ethOwed` at each step.
    - **Deliberately-reverting payee.** An oracle-owner (or requester) contract with a
      reverting / non-payable `receive()`. Assert its `withdrawEth` reverts, its `ethOwed`
      is **restored not burned** (§7 step 5), and that finalize and *other* payees are
      unaffected (the §4.2 isolation property).
    - **Fund-from-credit (§4.5).** After a refund leaves a credit, a follow-up request
      with `msg.value < required` succeeds by drawing `fromCredit`, and one with
      `msg.value = 0` succeeds when credit ≥ `required`; assert `ethOwed[requester]` is
      debited by exactly `fromCredit`, the invariant holds across the recycle, and a request
      reverts when `msg.value + credit < required`.
    - **Restricted withdraw trigger (§4.2).** `withdrawEthFor(payee)` succeeds for the payee
      and for the owner, **reverts for any other caller**, and in all cases pays the payee
      (never the caller). After `renounceOwnership()`, owner-trigger reverts and only the
      payee can withdraw.
    - **Accounting-invariant assertion.** After **every** exit path (success,
      timeout-with-cluster, commit/reveal shortfall): per-`aggId`
      `ethReceived == baseCredited + bonusCredited + refund`, global
      `address(this).balance == Σ ethOwed + Σ reserved`, and the solvency ceiling
      `clusteredCount ≤ clusterSize` ⇒ `bonusCredited ≤ B·P·effMaxFee` (§4.5).

Minor sweep-ups (decisions, with rationale):

14. **`getContractConfig()` — keep as-is (returns `linkAddr`).** The aggregator still
    holds and uses the LINK token (0-juel `transferAndCall`), and tests/scripts read
    `cfg.linkAddr` to locate LINK. Keep the 4-tuple signature for backward compatibility;
    `oracleAddr`/`jobId`/`fee` stay zero placeholders. No ETH-specific field is needed —
    ETH state is read via `ethOwed[...]` and `address(this).balance`.
15. **`withdrawLink` — keep as a LINK-only stuck-token escape hatch.** Under 0-juel
    dispatch the contract holds no routine LINK, so it is vestigial for normal operation,
    but retain it (owner-only) to recover LINK sent by mistake. This is **not** the
    forbidden owner-sweep of step 8 — that ban is about **ETH**; a LINK escape hatch is
    explicitly allowed (`withdrawLink` for the tiny LINK reserve, if any, is fine).
16. **Constructor keeps `linkAddr` — intentional asymmetry.** The aggregator still needs
    the LINK token address for `_setChainlinkToken` / `transferAndCall(operator, 0, …)`,
    so the `_link` constructor arg and `deploy/01_aggregator.js`'s `args: [linkAddr, ZERO]`
    wiring **stay**. Only the *consumer* drops its LINK arg, because it now sends ETH
    `{value:}` instead of approving LINK — `DemoClient` lives in the sibling project at
    `demoClient/contracts/DemoClient.sol` (today `constructor(address aggregator, address
    linkToken)`, with `link.approve(...)` calls to remove). Note this asymmetry in the
    deploy wiring so the aggregator's `linkAddr` is not "cleaned up" by mistake.

---

## 8. Migration runbook

1. Deploy the ETH aggregator. `approveContract(ethAggregator)` on the **existing**
   keeper. (No operator change — keeper-based gate auto-authorizes it.)
2. Set the ETH aggregator's `maxOracleFee` strictly below the lowest LINK fee
   (0.0004 ETH = `4e14` wei — below the prevailing 0.002-LINK arbiter band; see §4.6).
   Re-scale `estimatedBaseCost` and the request-time `_maxOracleFee` by the same ÷125 so
   the selection curve is preserved.
3. Bring arbiters to low ETH-scale fees by restarting + re-registering each arbiter at
   its new fee (reputation resets, as with any re-registration), per §5.4.
4. Point consumers/clients at the ETH aggregator (send ETH, no LINK approval).
5. Wind down LINK-aggregator usage; once idle, `removeContract(linkAggregator)` and
   retire it.
6. (Later, separate project) Replace the Chainlink transport per §6.

---

## 9. Risks and mitigations (summary)

| Risk | Mitigation |
|------|------------|
| ETH aggregator selects a LINK-scale arbiter and overpays ETH | Hard `maxOracleFee` ceiling below LINK fees; compute required ETH from selected fees and revert if `msg.value` short; non-overlapping fee ranges |
| Reverting recipient blocks requests/finalization | Pull model only; bonus and refund are *credits*, so finalize/timeout do only storage writes (zero external calls); `isComplete` guards re-entry/double-settle (§4.5) |
| Round under-funded by a mid-round `setBonusMultiplier` raise | Snapshot `bonusMultiplier` into the `aggId` at request and use the snapshot at finalize (§4.5) |
| Aggregator custodies unclaimed ETH (honeypot) | Tests (§7 step 13 — round-trip, reverting-payee, invariant), CEI + `nonReentrant`, no owner ETH-sweep; balances claimable indefinitely (old aggregator stays claimable after swap) |
| ETH fees mis-denominated / curve distorted by re-pick | Scale the monetary triple by one common factor (÷125), keeping `maxFeeBasedScalingFactor`/`bonusMultiplier` fixed; ceiling 0.0004 ETH below the 0.002-LINK band (§4.6) |
| Third party flushes a payee / forces a requester's recyclable credit out | Removed by the **restricted trigger** (§4.2): only the payee or the owner may trigger `withdrawEthFor`, always paid to the payee; owner can accelerate but never redirect. After `renounceOwnership()` only the payee can trigger |
| Requester's claimable balance grows unboundedly | Fund-from-credit (§4.5): refunds are recycled into subsequent requests, so the balance oscillates around ~one round's slack rather than accumulating; `withdrawEth()` needed only to exit |
| Re-registration resets an arbiter's reputation | Accepted by design — fee changes require an arbiter restart, as today (no `setFee`) |
| Node stops servicing 0-LINK after a config change | Pin `minContractPaymentLinkJuels = 0` in `basicJobSpec` |
| Third-party arbiters work for tiny LINK during window | Retire LINK aggregator promptly; warn operators |

---

## 10. Resolved decisions

- **No `setFee` in the keeper.** Fee changes require an arbiter restart +
  re-registration, as today; the reputation reset is accepted (§5.4). The keeper is
  not changed.
- **Send 0 juel** on commit dispatch — no LINK reserve in the aggregator (§3).
- **Pure pull** for all ETH payment — no push, no try-push-then-credit, for *both*
  oracle payouts and requester refunds (§4.2, §4.5).
- **Restricted payout trigger, fixed payee destination** — only the **payee or the owner**
  may call `withdrawEthFor(payee)`, and it always pays the credited payee (arbiter owner
  *or* requester awaiting refund); the owner can accelerate but never redirect, so an
  owner-destined sweep stays forbidden (§4.2, §7 steps 5 & 8). The owner-trigger is an
  early-days convenience; after `renounceOwnership()` only the payee can trigger. We drop
  fully-permissionless triggering so a griefer cannot force a requester's recyclable credit
  out; the cost is that arbiter owners self-claim (as with today's manual LINK claim).
  Time-gated escheatment of abandoned balances is out of scope.
- **Fund-from-credit (recycling), single ledger** — a request may draw on the caller's
  existing `ethOwed` (`fromCredit = min(credit, required)`), so refunds are recycled into
  later requests and the claimable balance stays bounded; the `balance == Σ ethOwed +
  Σ reserved` invariant is preserved and no separate deposit mapping is needed (§4.5).
  Callers size `msg.value` from the `maxTotalFee(_maxOracleFee)` view, net of credit.
- **Pay all polled oracles** — *(REVISED from the original "pay only responders"; see
  Implementation note 1 at the top.)* base (1×) is credited to every polled oracle's owner
  at **request time**, responsive or not, restoring the old "all polled paid 1× up front"
  semantic. This removes any incentive to submit a fake commit to collect base; freeloaders
  are still curbed by the reputation penalties on non-responders.
- **Single-stage settlement, refunds accumulate** — the requester prepays the worst case;
  one refund expression (`ethReceived − baseCredited − bonusCredited`) settles every path
  and accumulates in `ethOwed[requester]` for batch claiming (§4.5).
- **Snapshot `bonusMultiplier`** at request so a mid-round change can't under-fund the
  bonus reserve (§4.5).
- **ETH parameter values fixed (§4.6).** One common ÷125 scaling of the monetary triple
  (live ceiling 0.05 LINK → 0.0004 ETH = `4e14`; `estimatedBaseCost` = `8e9`; request
  `_maxOracleFee` = `8e13`; typical registration ≈ `1.6e13`). `maxFeeBasedScalingFactor`
  = 5 and `bonusMultiplier` = 3 unchanged, so the selection curve is preserved; the
  ceiling sits ~5× below the 0.002-LINK band. Baseline corrected: live ceiling is
  0.05 LINK (set by `deploy/03_config.js`), not the 0.1 LINK constructor default.
- **Tests are a checklist deliverable, not a footnote (§7 step 13).** No end-to-end
  harness exists today; the ETH custody/refund code ships with round-trip, reverting-payee,
  and accounting-invariant tests.
- **Sweep-ups (§7 steps 14–16).** `getContractConfig()` kept as-is (still returns the
  genuinely-used `linkAddr`); `withdrawLink` kept as a LINK-only stuck-token escape hatch
  (the ETH-sweep ban does not cover it); the constructor keeps `linkAddr` while
  `DemoClient` drops its LINK arg — an intentional asymmetry in the deploy wiring.
