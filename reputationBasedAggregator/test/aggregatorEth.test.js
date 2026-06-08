// test/aggregatorEth.test.js
// ----------------------------------------------------------------------------
// Self-contained unit tests for the ETH-funded ReputationAggregator (docs section 7
// step 13). Uses lightweight mocks (MockLinkToken / MockReputationKeeper /
// MockArbiterOperator / RevertingReceiver) so the full request -> commit -> reveal ->
// finalize -> withdraw round-trip can be driven without a live deployment.
//
// Groups:
//   1. Full {value:} round-trip (base to all K, bonus + refund credited, withdraw pays out)
//   2. Deliberately-reverting payee (balance restored, others unaffected)
//   3. Fund-from-credit (recycle refund; revert when value + credit < required)
//   4. Restricted withdraw trigger (payee / owner only; always pays payee; renounce)
//   5. Accounting invariants on every exit path
//   6. getEvaluation validity flag (a failed round is never reported as valid data)
// ----------------------------------------------------------------------------

const { expect } = require("chai");
const { ethers } = require("hardhat");

const abi = ethers.AbiCoder.defaultAbiCoder();
const REVEAL = [60n, 40n];               // identical vectors so the responders cluster
const FEE = 10n ** 13n;                  // 1e13 wei per oracle (well under the 4e14 ceiling)
const REQ_MAX_FEE = 8n * 10n ** 13n;     // 8e13 requested ceiling (clamped to maxOracleFee)
const BASE_COST = 8n * 10n ** 9n;        // 8e9
const SCALING = 5n;
const ZERO = ethers.ZeroAddress;

// 20-hex-char (80-bit) salt for slot i, matching AggregatorLib's cid:salt format.
function saltHexFor(i) {
  return (BigInt(i) + 1n).toString(16).padStart(20, "0");
}
// commit response[0]: low 128 bits hold bytes16(sha256(abi.encode(operator, reveal, salt))),
// which the contract recomputes and matches against the stored commit hash on reveal.
function commitResp0(operatorAddr, revealArr, saltBig) {
  const encoded = abi.encode(["address", "uint256[]", "uint256"], [operatorAddr, revealArr, saltBig]);
  return BigInt(ethers.dataSlice(ethers.sha256(encoded), 0, 16));
}
// Pull the Chainlink requestIds emitted (by the aggregator) within a tx receipt.
function reqIdsFrom(receipt, agg) {
  const topic = agg.interface.getEvent("ChainlinkRequested").topicHash;
  return receipt.logs
    .filter((l) => l.topics[0] === topic)
    .map((l) => agg.interface.parseLog({ topics: [...l.topics], data: l.data }).args.id);
}

describe("ReputationAggregator (ETH-funded)", function () {
  let deployer, requester;
  let agg, link, keeper, lib;
  let operators, ownerAddrs;

  // Build (slot -> requestId) for a tx by reading the public reverse mapping.
  async function slotMap(receipt) {
    const ids = reqIdsFrom(receipt, agg);
    const m = {};
    for (const id of ids) {
      const slot = Number(await agg.requestIdToPollIndex(id));
      m[slot] = id;
    }
    return m;
  }

  async function setup(owners /* array of 3 addresses */) {
    [deployer, requester] = await ethers.getSigners();

    const Lib = await ethers.getContractFactory("AggregatorLib");
    lib = await Lib.deploy();
    await lib.waitForDeployment();

    const Link = await ethers.getContractFactory("MockLinkToken");
    link = await Link.deploy(ethers.parseEther("1000000"));
    await link.waitForDeployment();

    const Keeper = await ethers.getContractFactory("MockReputationKeeper");
    keeper = await Keeper.deploy();
    await keeper.waitForDeployment();

    const Agg = await ethers.getContractFactory("ReputationAggregator", {
      libraries: { AggregatorLib: await lib.getAddress() },
    });
    agg = await Agg.deploy(await link.getAddress(), await keeper.getAddress());
    await agg.waitForDeployment();

    // K=3, M=2, N=2, P=2 — poll 3, first 2 commits trigger reveal, 2 reveals finalize, cluster 2.
    await (await agg.setConfig(3, 2, 2, 2, 300)).wait();

    const Op = await ethers.getContractFactory("MockArbiterOperator");
    operators = [];
    for (let i = 0; i < 3; i++) {
      const op = await Op.deploy(owners[i]);
      await op.waitForDeployment();
      operators.push(op);
    }
    ownerAddrs = owners;
    await (await keeper.setOracles(
      await Promise.all(operators.map((o) => o.getAddress())),
      FEE,
    )).wait();
  }

  // Drive request -> commit slots 0,1 -> reveal slots 0,1 -> finalize. Slot 2 never responds.
  // Returns { aggId, required }.
  async function happyRound(value) {
    const required = await agg.maxTotalFee(REQ_MAX_FEE);
    const reqTx = await agg.connect(requester).requestAIEvaluationWithApproval(
      ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0,
      { value: value === undefined ? required : value },
    );
    const reqRcpt = await reqTx.wait();
    const aggId = agg.interface.parseLog(
      reqRcpt.logs.find((l) => l.topics[0] === agg.interface.getEvent("RequestAIEvaluation").topicHash),
    ).args.aggRequestId;

    const commitIds = await slotMap(reqRcpt);

    // commit slot 0, then slot 1 (the 2nd commit dispatches reveals in-tx)
    await (await operators[0].callFulfill(
      await agg.getAddress(), commitIds[0],
      [commitResp0(await operators[0].getAddress(), REVEAL, BigInt("0x" + saltHexFor(0)))], "",
    )).wait();
    const commit1Rcpt = await (await operators[1].callFulfill(
      await agg.getAddress(), commitIds[1],
      [commitResp0(await operators[1].getAddress(), REVEAL, BigInt("0x" + saltHexFor(1)))], "",
    )).wait();

    const revealIds = await slotMap(commit1Rcpt);

    // reveal slot 0, then slot 1 (the 2nd reveal finalizes in-tx)
    await (await operators[0].callFulfill(
      await agg.getAddress(), revealIds[0], REVEAL, `QmJustif0:${saltHexFor(0)}`,
    )).wait();
    await (await operators[1].callFulfill(
      await agg.getAddress(), revealIds[1], REVEAL, `QmJustif1:${saltHexFor(1)}`,
    )).wait();

    return { aggId, required };
  }

  async function assertSolvency(aggId) {
    const bal = await ethers.provider.getBalance(await agg.getAddress());
    let sumOwed = 0n;
    for (const a of [...ownerAddrs, requester.address]) sumOwed += await agg.ethOwed(a);
    const acc = await agg.getEthAccounting(aggId);
    expect(bal).to.equal(sumOwed + acc.reserved);
  }

  // --------------------------------------------------------------------------
  describe("1. full ETH round-trip", function () {
    let owners;
    before(async () => {
      owners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      await setup(owners);
    });

    it("credits 1x base to ALL K oracle owners at request time", async () => {
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      await (await agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).wait();

      // every polled owner credited 1x base, before any commit/reveal
      for (const o of owners) expect(await agg.ethOwed(o)).to.equal(FEE);
    });

    it("credits bonus to clustered owners and refunds the requester at finalize", async () => {
      await setup(owners); // fresh state for a clean full round
      const { aggId, required } = await happyRound();

      // slots 0,1 clustered: base + bonus; slot 2 non-responder: base only
      const bonus = FEE * 3n; // bonusMultiplier default 3
      expect(await agg.ethOwed(owners[0])).to.equal(FEE + bonus);
      expect(await agg.ethOwed(owners[1])).to.equal(FEE + bonus);
      expect(await agg.ethOwed(owners[2])).to.equal(FEE);

      const baseCredited = FEE * 3n;
      const bonusCredited = bonus * 2n;
      const refund = required - baseCredited - bonusCredited;
      expect(await agg.ethOwed(requester.address)).to.equal(refund);

      const acc = await agg.getEthAccounting(aggId);
      expect(acc.ethReceived).to.equal(required);
      expect(acc.baseCredited).to.equal(baseCredited);
      expect(acc.bonusCredited).to.equal(bonusCredited);
      expect(acc.reserved).to.equal(0n);
      await assertSolvency(aggId);
    });

    it("pays out an owner's balance via withdrawEthFor (owner-triggered)", async () => {
      const owed = await agg.ethOwed(owners[0]);
      expect(owed).to.be.gt(0n);
      const before = await ethers.provider.getBalance(owners[0]);
      await (await agg.connect(deployer).withdrawEthFor(owners[0])).wait();
      expect(await ethers.provider.getBalance(owners[0])).to.equal(before + owed);
      expect(await agg.ethOwed(owners[0])).to.equal(0n);
    });
  });

  // --------------------------------------------------------------------------
  describe("2. deliberately-reverting payee", function () {
    let reverter, owners;
    beforeEach(async () => {
      const R = await ethers.getContractFactory("RevertingReceiver");
      reverter = await R.deploy();
      await reverter.waitForDeployment();
      // slot 2's owner is the reverting contract; slots 0,1 are normal addresses
      owners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, await reverter.getAddress()];
      await setup(owners);
    });

    it("reverts the bad payee's withdrawal, restores its balance, and leaves others payable", async () => {
      const { aggId } = await happyRound();
      const reverterAddr = await reverter.getAddress();
      const owedToReverter = await agg.ethOwed(reverterAddr);
      expect(owedToReverter).to.equal(FEE); // base only (slot 2 never responded)

      // the bad payee's withdrawal reverts and its balance is restored, not burned
      await expect(agg.connect(deployer).withdrawEthFor(reverterAddr))
        .to.be.revertedWithCustomError(agg, "EthTransferFailed");
      expect(await agg.ethOwed(reverterAddr)).to.equal(owedToReverter);

      // other payees are entirely unaffected
      const before0 = await ethers.provider.getBalance(owners[0]);
      const owed0 = await agg.ethOwed(owners[0]);
      await (await agg.connect(deployer).withdrawEthFor(owners[0])).wait();
      expect(await ethers.provider.getBalance(owners[0])).to.equal(before0 + owed0);

      await assertSolvency(aggId);
    });
  });

  // --------------------------------------------------------------------------
  describe("3. fund-from-credit (recycling)", function () {
    let owners;
    beforeEach(async () => {
      owners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      await setup(owners);
    });

    it("a follow-up request draws on existing credit (partial msg.value)", async () => {
      const { required } = await happyRound();
      const credit = await agg.ethOwed(requester.address);
      expect(credit).to.be.gt(0n);

      // pay the shortfall only; fromCredit should cover the rest exactly
      const topUp = required > credit ? required - credit : 0n;
      const tx = await agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence2"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: topUp },
      );
      const rcpt = await tx.wait();
      const funded = agg.interface.parseLog(
        rcpt.logs.find((l) => l.topics[0] === agg.interface.getEvent("RequestFunded").topicHash),
      ).args;
      expect(funded.fromCredit).to.equal(credit < required ? credit : required);
      expect(funded.fromValue).to.equal(topUp);
      // credit fully consumed (credit <= required here)
      expect(await agg.ethOwed(requester.address)).to.equal(0n);
    });

    it("succeeds with msg.value = 0 when credit alone covers required", async () => {
      // First overpay so the refund leaves a credit >= required for the next round.
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      await happyRound(required * 2n);       // big overpay -> large refund credit
      const credit = await agg.ethOwed(requester.address);
      expect(credit).to.be.gte(required);

      await expect(agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence3"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: 0 },
      )).to.not.be.reverted;
      expect(await agg.ethOwed(requester.address)).to.equal(credit - required);
    });

    it("reverts when msg.value + credit < required", async () => {
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      // no prior credit; send strictly less than required
      await expect(agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence4"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required - 1n },
      )).to.be.revertedWithCustomError(agg, "InsufficientPayment");
    });
  });

  // --------------------------------------------------------------------------
  describe("4. restricted withdraw trigger", function () {
    let payee, other, owners;
    beforeEach(async () => {
      const signers = await ethers.getSigners();
      payee = signers[2];
      other = signers[3];
      // make the payee an oracle owner so it accrues a balance
      owners = [payee.address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      await setup(owners);
      await happyRound();
    });

    it("payee can self-withdraw; arbitrary caller cannot trigger", async () => {
      const owed = await agg.ethOwed(payee.address);
      expect(owed).to.be.gt(0n);
      await expect(agg.connect(other).withdrawEthFor(payee.address))
        .to.be.revertedWithCustomError(agg, "NotAuthorized");

      const before = await ethers.provider.getBalance(payee.address);
      const rcpt = await (await agg.connect(payee).withdrawEth()).wait();
      const gas = rcpt.gasUsed * rcpt.gasPrice;
      expect(await ethers.provider.getBalance(payee.address)).to.equal(before + owed - gas);
      expect(await agg.ethOwed(payee.address)).to.equal(0n);
    });

    it("owner can trigger but it always pays the payee, never the caller", async () => {
      const owed = await agg.ethOwed(payee.address);
      const before = await ethers.provider.getBalance(payee.address);
      await (await agg.connect(deployer).withdrawEthFor(payee.address)).wait();
      // paid to payee (a signer who spent no gas here), not to deployer
      expect(await ethers.provider.getBalance(payee.address)).to.equal(before + owed);
      expect(await agg.ethOwed(payee.address)).to.equal(0n);
    });

    it("after renounceOwnership, only the payee can trigger", async () => {
      await (await agg.connect(deployer).renounceOwnership()).wait();
      await expect(agg.connect(deployer).withdrawEthFor(payee.address))
        .to.be.revertedWithCustomError(agg, "NotAuthorized");
      await expect(agg.connect(payee).withdrawEth()).to.not.be.reverted;
    });
  });

  // --------------------------------------------------------------------------
  describe("5. accounting invariants on every exit path", function () {
    let owners;
    beforeEach(async () => {
      owners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      await setup(owners);
    });

    it("success path: ethReceived == base + bonus + refund, balance == owed + reserved", async () => {
      const { aggId, required } = await happyRound();
      const acc = await agg.getEthAccounting(aggId);
      const refund = await agg.ethOwed(requester.address);
      expect(acc.ethReceived).to.equal(acc.baseCredited + acc.bonusCredited + refund);
      // bonus solvency ceiling: clusteredCount (2) * FEE * B <= B * P * effMaxFee
      const B = await agg.bonusMultiplier();
      const P = await agg.clusterSize();
      const effMaxFee = REQ_MAX_FEE; // < maxOracleFee
      expect(acc.bonusCredited).to.be.lte(B * P * effMaxFee);
      await assertSolvency(aggId);
      expect(required).to.equal(acc.ethReceived);
    });

    it("commit-shortfall timeout: committers keep base, rest refunds", async () => {
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      const reqRcpt = await (await agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).wait();
      const aggId = agg.interface.parseLog(
        reqRcpt.logs.find((l) => l.topics[0] === agg.interface.getEvent("RequestAIEvaluation").topicHash),
      ).args.aggRequestId;

      // only 1 commit (< M=2) -> commit-phase failure on timeout
      const commitIds = await slotMap(reqRcpt);
      await (await operators[0].callFulfill(
        await agg.getAddress(), commitIds[0],
        [commitResp0(await operators[0].getAddress(), REVEAL, BigInt("0x" + saltHexFor(0)))], "",
      )).wait();

      await ethers.provider.send("evm_increaseTime", [301]);
      await ethers.provider.send("evm_mine", []);
      await (await agg.finalizeEvaluationTimeout(aggId)).wait();

      const acc = await agg.getEthAccounting(aggId);
      // base credited to all 3 at request (pay-all); no bonus
      expect(acc.baseCredited).to.equal(FEE * 3n);
      expect(acc.bonusCredited).to.equal(0n);
      const refund = await agg.ethOwed(requester.address);
      expect(acc.ethReceived).to.equal(acc.baseCredited + acc.bonusCredited + refund);
      expect(acc.reserved).to.equal(0n);
      await assertSolvency(aggId);
    });

    it("reveal-shortfall timeout: same single refund expression holds", async () => {
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      const reqRcpt = await (await agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).wait();
      const aggId = agg.interface.parseLog(
        reqRcpt.logs.find((l) => l.topics[0] === agg.interface.getEvent("RequestAIEvaluation").topicHash),
      ).args.aggRequestId;

      // 2 commits -> reveal phase, but 0 reveals -> reveal-phase failure on timeout
      const commitIds = await slotMap(reqRcpt);
      await (await operators[0].callFulfill(
        await agg.getAddress(), commitIds[0],
        [commitResp0(await operators[0].getAddress(), REVEAL, BigInt("0x" + saltHexFor(0)))], "",
      )).wait();
      await (await operators[1].callFulfill(
        await agg.getAddress(), commitIds[1],
        [commitResp0(await operators[1].getAddress(), REVEAL, BigInt("0x" + saltHexFor(1)))], "",
      )).wait();

      await ethers.provider.send("evm_increaseTime", [301]);
      await ethers.provider.send("evm_mine", []);
      await (await agg.finalizeEvaluationTimeout(aggId)).wait();

      const acc = await agg.getEthAccounting(aggId);
      expect(acc.bonusCredited).to.equal(0n);
      const refund = await agg.ethOwed(requester.address);
      expect(acc.ethReceived).to.equal(acc.baseCredited + acc.bonusCredited + refund);
      await assertSolvency(aggId);
    });
  });

  // --------------------------------------------------------------------------
  describe("6. getEvaluation validity flag", function () {
    let owners;
    beforeEach(async () => {
      owners = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      await setup(owners);
    });

    // A round that reaches reveal phase and gets ONE reveal (< N=2) allocates the
    // aggregatedLikelihoods scratch array (via _ensureAggArrayExists) but never
    // finalizes. On timeout it fails. getEvaluation must NOT report that zero-filled
    // scratch as valid data — the regression guard is the `!failed` term.
    it("reveal-phase timeout with one partial reveal reports hasValidData == false", async () => {
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      const reqRcpt = await (await agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).wait();
      const aggId = agg.interface.parseLog(
        reqRcpt.logs.find((l) => l.topics[0] === agg.interface.getEvent("RequestAIEvaluation").topicHash),
      ).args.aggRequestId;

      // 2 commits -> reveal phase
      const commitIds = await slotMap(reqRcpt);
      await (await operators[0].callFulfill(
        await agg.getAddress(), commitIds[0],
        [commitResp0(await operators[0].getAddress(), REVEAL, BigInt("0x" + saltHexFor(0)))], "",
      )).wait();
      const commit1Rcpt = await (await operators[1].callFulfill(
        await agg.getAddress(), commitIds[1],
        [commitResp0(await operators[1].getAddress(), REVEAL, BigInt("0x" + saltHexFor(1)))], "",
      )).wait();

      // exactly ONE reveal (< N=2): allocates the scratch array, does not finalize
      const revealIds = await slotMap(commit1Rcpt);
      await (await operators[0].callFulfill(
        await agg.getAddress(), revealIds[0], REVEAL, `QmJustif0:${saltHexFor(0)}`,
      )).wait();

      // time out in reveal phase -> failed
      await ethers.provider.send("evm_increaseTime", [301]);
      await ethers.provider.send("evm_mine", []);
      await (await agg.finalizeEvaluationTimeout(aggId)).wait();

      expect(await agg.isFailed(aggId)).to.equal(true);

      const [likelihoods, , hasValidData] = await agg.getEvaluation(aggId);
      // the scratch array exists (length == the one reveal's vector) and is zero-filled,
      // so the pre-fix code (isComplete && length > 0) would have returned true here...
      expect(likelihoods.length).to.equal(REVEAL.length);
      expect([...likelihoods].every((x) => x === 0n)).to.equal(true);
      // ...the `!failed` guard makes it correctly report invalid
      expect(hasValidData).to.equal(false);
    });

    // Sanity: a successful round still reports valid.
    it("successful round reports hasValidData == true", async () => {
      const { aggId } = await happyRound();
      expect(await agg.isFailed(aggId)).to.equal(false);
      const [, , hasValidData] = await agg.getEvaluation(aggId);
      expect(hasValidData).to.equal(true);
    });
  });

  // --------------------------------------------------------------------------
  describe("7. AggregatorLib.isValidCidSalt hex validation", function () {
    let libC;
    before(async () => {
      const Lib = await ethers.getContractFactory("AggregatorLib");
      libC = await Lib.deploy();
      await libC.waitForDeployment();
    });

    // helper: "<cid>:<19 zeros><ch>" — the trailing char occupies the 20-char salt region
    const withSaltChar = (ch) => `QmCid:${"0".repeat(19)}${ch}`;

    it("rejects punctuation ;<=>? that the old lower-bound-only parser accepted as hex", async () => {
      // ASCII 59..63: c-48 lands in 11..15, so the old code wrongly accepted these as hex.
      for (const ch of [";", "<", "=", ">", "?"]) {
        const [ok] = await libC.isValidCidSalt(withSaltChar(ch));
        expect(ok, `salt char "${ch}" must be rejected`).to.equal(false);
      }
    });

    it("still accepts the real hex boundary chars", async () => {
      for (const ch of ["0", "9", "a", "f", "A", "F"]) {
        const [ok] = await libC.isValidCidSalt(withSaltChar(ch));
        expect(ok, `hex char "${ch}" must be accepted`).to.equal(true);
      }
    });

    it("still rejects clearly out-of-range chars", async () => {
      // '/'=47 (below '0'), '@'=64 (above '9', already rejected pre-fix), 'g'=103, 'G'=71
      for (const ch of ["/", "@", "g", "G"]) {
        const [ok] = await libC.isValidCidSalt(withSaltChar(ch));
        expect(ok, `non-hex char "${ch}" must be rejected`).to.equal(false);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 8. H-1 regression: a malicious operator whose ERC-677 onTokenTransfer hook reverts
  //    (fired by the 0-juel transferAndCall dispatch) must only fail its OWN slot, never
  //    abort the whole request or wedge the M-th committer's fulfill. Pre-fix, the dispatch
  //    sat inside the `try owner()` body (whose catch does NOT cover body reverts), so any
  //    such revert unwound the entire transaction.
  // --------------------------------------------------------------------------
  describe("8. H-1: malicious operator dispatch cannot brick rounds", function () {
    const rand = () => ethers.Wallet.createRandom().address;

    // Deploy a fresh stack with a mix of honest (MockArbiterOperator) and hostile
    // (MockRevertingDispatchOperator) operators. `specs[i]` = { revert, from } chooses slot i.
    async function setupMixed(specs, ownerList) {
      [deployer, requester] = await ethers.getSigners();

      const Lib = await ethers.getContractFactory("AggregatorLib");
      lib = await Lib.deploy();
      await lib.waitForDeployment();

      const Link = await ethers.getContractFactory("MockLinkToken");
      link = await Link.deploy(ethers.parseEther("1000000"));
      await link.waitForDeployment();

      const Keeper = await ethers.getContractFactory("MockReputationKeeper");
      keeper = await Keeper.deploy();
      await keeper.waitForDeployment();

      const Agg = await ethers.getContractFactory("ReputationAggregator", {
        libraries: { AggregatorLib: await lib.getAddress() },
      });
      agg = await Agg.deploy(await link.getAddress(), await keeper.getAddress());
      await agg.waitForDeployment();

      // K=3, M=2, N=2, P=2
      await (await agg.setConfig(3, 2, 2, 2, 300)).wait();

      const Good = await ethers.getContractFactory("MockArbiterOperator");
      const Bad = await ethers.getContractFactory("MockRevertingDispatchOperator");
      operators = [];
      for (let i = 0; i < specs.length; i++) {
        const op = specs[i].revert === 0
          ? await Good.deploy(ownerList[i])
          : await Bad.deploy(ownerList[i], specs[i].revert, specs[i].from || 0);
        await op.waitForDeployment();
        operators.push(op);
      }
      ownerAddrs = ownerList;
      await (await keeper.setOracles(await Promise.all(operators.map((o) => o.getAddress())), FEE)).wait();
    }

    async function request() {
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      const rcpt = await (await agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).wait();
      const aggId = agg.interface.parseLog(
        rcpt.logs.find((l) => l.topics[0] === agg.interface.getEvent("RequestAIEvaluation").topicHash),
      ).args.aggRequestId;
      return { rcpt, aggId, required };
    }

    it("request-time: an always-reverting selected operator is skipped (not fatal), round still completes", async () => {
      const owners = [rand(), rand(), rand()];
      // slot 2 always reverts in onTokenTransfer
      await setupMixed([{ revert: 0 }, { revert: 0 }, { revert: 1 }], owners);

      // Pre-fix this call reverts entirely; post-fix it succeeds with slot 2 skipped.
      const { rcpt, aggId } = await request();

      // honest slots credited base; the bricked slot got NO base and was never dispatched
      expect(await agg.ethOwed(owners[0])).to.equal(FEE);
      expect(await agg.ethOwed(owners[1])).to.equal(FEE);
      expect(await agg.ethOwed(owners[2])).to.equal(0n);
      expect(reqIdsFrom(rcpt, agg).length).to.equal(2); // only 2 oracles dispatched

      // the round proceeds to a normal finalize on the 2 honest oracles
      const commitIds = await slotMap(rcpt);
      await (await operators[0].callFulfill(
        await agg.getAddress(), commitIds[0],
        [commitResp0(await operators[0].getAddress(), REVEAL, BigInt("0x" + saltHexFor(0)))], "",
      )).wait();
      const commit1Rcpt = await (await operators[1].callFulfill(
        await agg.getAddress(), commitIds[1],
        [commitResp0(await operators[1].getAddress(), REVEAL, BigInt("0x" + saltHexFor(1)))], "",
      )).wait();

      const revealIds = await slotMap(commit1Rcpt);
      await (await operators[0].callFulfill(
        await agg.getAddress(), revealIds[0], REVEAL, `QmJustif0:${saltHexFor(0)}`,
      )).wait();
      await (await operators[1].callFulfill(
        await agg.getAddress(), revealIds[1], REVEAL, `QmJustif1:${saltHexFor(1)}`,
      )).wait();

      const [, , hasValidData] = await agg.getEvaluation(aggId);
      expect(hasValidData).to.equal(true);
      await assertSolvency(aggId);
    });

    it("reveal-dispatch: a committed operator reverting at reveal-dispatch does not wedge the M-th commit", async () => {
      const owners = [rand(), rand(), rand()];
      // slot 0 lets the commit-phase poll dispatch through (call 1) but reverts on the
      // reveal-phase dispatch (call 2), which is triggered inside the 2nd committer's fulfill.
      await setupMixed([{ revert: 2, from: 2 }, { revert: 0 }, { revert: 0 }], owners);

      const { rcpt, aggId } = await request();
      expect(reqIdsFrom(rcpt, agg).length).to.equal(3); // all 3 dispatched at request time

      const commitIds = await slotMap(rcpt);
      // op0 commits (slot 0), then op1 commits (slot 1) -> M=2 -> reveal dispatch fires;
      // op0's reveal dispatch reverts in onTokenTransfer but is now caught.
      await (await operators[0].callFulfill(
        await agg.getAddress(), commitIds[0],
        [commitResp0(await operators[0].getAddress(), REVEAL, BigInt("0x" + saltHexFor(0)))], "",
      )).wait();

      // Pre-fix, THIS fulfill reverts (op0's reveal-dispatch revert unwinds it); post-fix it
      // succeeds and the commit phase completes.
      const commit1Rcpt = await (await operators[1].callFulfill(
        await agg.getAddress(), commitIds[1],
        [commitResp0(await operators[1].getAddress(), REVEAL, BigInt("0x" + saltHexFor(1)))], "",
      )).wait();

      const status = await agg.getAggregationStatus(aggId);
      expect(status.commitPhaseComplete).to.equal(true);
      expect(status.commitReceived).to.equal(2n);

      // a reveal request reached the honest slot 1 but not the bricked slot 0
      const revealIds = await slotMap(commit1Rcpt);
      expect(revealIds[1]).to.not.equal(undefined);
      expect(revealIds[0]).to.equal(undefined);
    });
  });

  // --------------------------------------------------------------------------
  // 9. M-3 regression: the round's escrow `required` is sized for EXACTLY K base credits.
  //    A keeper that returns a selection set whose size != commitOraclesToPoll must be rejected
  //    (BadSelectionCount) before any state is touched. An over-sized set is the dangerous case:
  //    without the guard it would over-credit base past `required` (past ethReceived), underflow
  //    _refundRequester at settlement, and credit ethOwed beyond the contract's backing ETH.
  // --------------------------------------------------------------------------
  describe("9. M-3: keeper selection-count backstop", function () {
    let badKeeper, anOperator;

    // Fresh stack pointed at the hostile MockBadCountKeeper, configured to return `returnCount`.
    async function setupBadCount(returnCount) {
      [deployer, requester] = await ethers.getSigners();

      const Lib = await ethers.getContractFactory("AggregatorLib");
      lib = await Lib.deploy();
      await lib.waitForDeployment();

      const Link = await ethers.getContractFactory("MockLinkToken");
      link = await Link.deploy(ethers.parseEther("1000000"));
      await link.waitForDeployment();

      const BadKeeper = await ethers.getContractFactory("MockBadCountKeeper");
      badKeeper = await BadKeeper.deploy();
      await badKeeper.waitForDeployment();

      const Agg = await ethers.getContractFactory("ReputationAggregator", {
        libraries: { AggregatorLib: await lib.getAddress() },
      });
      agg = await Agg.deploy(await link.getAddress(), await badKeeper.getAddress());
      await agg.waitForDeployment();

      // K = commitOraclesToPoll = 3
      await (await agg.setConfig(3, 2, 2, 2, 300)).wait();

      const Op = await ethers.getContractFactory("MockArbiterOperator");
      anOperator = await Op.deploy(ethers.Wallet.createRandom().address);
      await anOperator.waitForDeployment();

      await (await badKeeper.configure(await anOperator.getAddress(), FEE, returnCount)).wait();
    }

    async function expectRejected(returnCount) {
      await setupBadCount(returnCount);
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      await expect(agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).to.be.revertedWithCustomError(agg, "BadSelectionCount");
    }

    it("rejects an over-sized selection set (more than K) — the solvency-break case", async () => {
      await expectRejected(5); // K=3, keeper returns 5
    });

    it("rejects an under-sized selection set (fewer than K)", async () => {
      await expectRejected(2); // K=3, keeper returns 2
    });

    it("does not leak state on rejection (no base credited, no ETH retained)", async () => {
      await setupBadCount(5);
      const required = await agg.maxTotalFee(REQ_MAX_FEE);
      await expect(agg.connect(requester).requestAIEvaluationWithApproval(
        ["QmEvidence"], "", 500, REQ_MAX_FEE, BASE_COST, SCALING, 0, { value: required },
      )).to.be.revertedWithCustomError(agg, "BadSelectionCount");
      // the whole tx reverted: the operator owner accrued nothing and the contract holds no ETH
      const ownerAddr = await anOperator.owner();
      expect(await agg.ethOwed(ownerAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(await agg.getAddress())).to.equal(0n);
    });
  });
});
