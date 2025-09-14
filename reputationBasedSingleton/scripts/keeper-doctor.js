#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Usage (recommended):
//   HARDHAT_NETWORK=base_sepolia node scripts/keeper-doctor.js \
//     --singleton 0x92fDBEe3be721De0aC065F1E7Ed5E8E251CF9AcC \
//     --class 128 \
//     --owner 0xYourBrowserEOA \
//     --cid QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH \\
/**     */ //     --alpha 500 --maxFee 0.01 --base 0.0001 --scale 10
//
//   With allowance commit (approve) of 0.5 LINK:
//   HARDHAT_NETWORK=base_sepolia node scripts/keeper-doctor.js \
//     --singleton 0x92fDBEe3be721De0aC065F1E7Ed5E8E251CF9AcC \
//     --class 128 --owner 0xFBDE840eb654E0f8B9F3e6c69C354B309A9ffE6b \
//     --cid QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH \
//     --alpha 500 --maxFee 0.01 --base 0.0001 --scale 10 \
//     --approve --approveAmount 0.5
//
// Notes:
// - Read-only unless you pass --approve (then it sends an ERC‑20 approve tx from --owner).

const hre = require("hardhat");
const { ethers, deployments } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// -------- ERC20 ABIs --------
const ERC20_MIN_ABI = [
  { "constant": true, "inputs": [
      {"name":"owner","type":"address"},
      {"name":"spender","type":"address"}],
    "name":"allowance", "outputs":[{"name":"","type":"uint256"}], "type":"function" },
  { "constant": true, "inputs": [], "name":"decimals",
    "outputs":[{"name":"","type":"uint8"}], "type":"function" },
  { "constant": true, "inputs": [], "name":"symbol",
    "outputs":[{"name":"","type":"string"}], "type":"function" },
];
const ERC20_PLUS_ABI = [
  ...ERC20_MIN_ABI,
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

// -------- Helpers --------
async function tryReadApprovalFlag(keeper, target) {
  const candidates = [
    (addr) => keeper.approvedContracts && keeper.approvedContracts(addr),
    (addr) => keeper.isContractApproved && keeper.isContractApproved(addr),
    (addr) => keeper.isApproved && keeper.isApproved(addr),
    (addr) => keeper.approved && keeper.approved(addr),
  ];
  for (const fn of candidates) {
    try {
      if (!fn) continue;
      const out = await fn(target);
      if (typeof out === "boolean") return out;
      if (out != null) return !!out;
    } catch (_) {}
  }
  return null;
}

async function probeKeeperApprovalView(provider, keeperAddr, contractAddr) {
  const variants = [
    ["isContractApproved", "function isContractApproved(address) view returns (bool)"],
    ["approvedContracts",  "function approvedContracts(address)  view returns (bool)"],
    ["isApproved",         "function isApproved(address)         view returns (bool)"],
    ["approved",           "function approved(address)           view returns (bool)"],
  ];
  for (const [fnName, sig] of variants) {
    try {
      const iface = new ethers.Interface([sig]);
      const data  = iface.encodeFunctionData(fnName, [contractAddr]);
      const ret   = await provider.call({ to: keeperAddr, data });
      if (ret && ret !== "0x") {
        const [val] = iface.decodeFunctionResult(fnName, ret);
        return { known: true, value: !!val, fn: fnName };
      }
    } catch { /* try next */ }
  }
  return { known: false, value: null, fn: null };
}

function fmt(bi, dec = 18) {
  try { return ethers.formatUnits(bi, dec); } catch { return String(bi); }
}

function bytes32ToAsciiMaybe(b32) {
  try {
    const hex = (typeof b32 === "string" ? b32 : ethers.hexlify(b32)).slice(2);
    let out = "";
    for (let i = 0; i < 64; i += 2) {
      const byte = parseInt(hex.substr(i, 2), 16);
      if (byte === 0) break;
      if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
      else return null; // non-printable → bail
    }
    return out.length >= 6 ? out : null;
  } catch { return null; }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("singleton",      { type: "string", describe: "ReputationSingleton address (optional)" })
    .option("class",          { type: "number", default: 128, describe: "Requested oracle class" })
    .option("count",          { type: "number", default: 1,   describe: "How many oracles to select" })
    .option("alpha",          { type: "number", default: 0,   describe: "Alpha for selection (0..1000)" })
    .option("maxFee",         { type: "string", default: "1", describe: "Max oracle fee in LINK (e.g. '0.01')" })
    .option("base",           { type: "string", default: "0", describe: "Estimated base cost in LINK (e.g. '0.0001')" })
    .option("scale",          { type: "number", default: 1,   describe: "Max fee-based scaling factor (>=1)" })
    .option("owner",          { type: "string", describe: "EOA that will call the singleton (browser wallet)" })
    .option("cid",            { type: "string", describe: "CID for dry-run of requestAIEvaluationWithApproval" })
    .option("addendum",       { type: "string", default: "",  describe: "Addendum text" })
    .option("approve",        { type: "boolean", default: false, describe: "If true, send ERC20 approve from --owner to singleton" })
    .option("approveAmount",  { type: "string", default: "0.5",   describe: "LINK amount to approve (default 0.5 LINK)" })
    .argv;

  const { getNamedAccounts } = hre;
  const { deployer } = await getNamedAccounts().catch(() => ({ deployer: null }));
  const signer = deployer ? await ethers.getSigner(deployer) : (await ethers.getSigners())[0];
  const provider = signer.provider;
  const ownerEOA = argv.owner || signer.address;

  const net = await provider.getNetwork();
  console.log("Network:", net.name, `(#${net.chainId})`);

  // RPC diagnostics
  try {
    const latest = await provider.getBlock("latest");
    const baseFee = BigInt(latest?.baseFeePerGas ?? 0);
    console.log("Latest block gasLimit:", latest?.gasLimit?.toString?.() ?? "unknown",
                "baseFeePerGas:", baseFee.toString());
  } catch (_) {}
  try {
    await provider.send("eth_maxPriorityFeePerGas", []);
    console.log("RPC supports eth_maxPriorityFeePerGas: yes");
  } catch (_) {
    console.log("RPC supports eth_maxPriorityFeePerGas: no (prefer legacy gasPrice in UI)");
  }

  // Resolve singleton address
  let singletonAddr = argv.singleton;
  if (!singletonAddr) {
    const dep = await deployments.get("ReputationSingleton");
    singletonAddr = dep.address;
  }
  console.log("Singleton:", singletonAddr);

  // Code presence checks
  const codeSingleton = await provider.getCode(singletonAddr);
  if (codeSingleton === "0x") throw new Error("No code at singleton address on this network.");

  const singleton = await ethers.getContractAt("ReputationSingleton", singletonAddr, signer);

  // Read keeper and LINK from singleton
  const keeperAddr = await singleton.reputationKeeper();
  const cfg = await singleton.getContractConfig(); // (oracleAddr, linkAddr, jobId, fee)
  const linkAddr = cfg.linkAddr || cfg[1];
  console.log("Keeper from singleton:", keeperAddr);
  console.log("LINK from singleton  :", linkAddr);

  // Presence checks
  const codeKeeper = await provider.getCode(keeperAddr);
  if (codeKeeper === "0x") throw new Error("No code at keeper address.");
  const codeLink = await provider.getCode(linkAddr);
  if (codeLink === "0x") throw new Error("No code at LINK token address.");

  const keeper = await ethers.getContractAt("IReputationKeeper", keeperAddr, signer);
  const linkRO = await ethers.getContractAt(ERC20_MIN_ABI, linkAddr, signer);

  // Optional keeper owner
  try {
    const owner = await keeper.owner();
    console.log("Keeper owner:", owner);
  } catch (_) {
    console.log("Keeper.owner() not available (ok).");
  }

  // RK approval
  console.log("Checking RK approval (robust view) …");
  const approvalView = await probeKeeperApprovalView(provider, keeperAddr, singletonAddr);
  if (approvalView.known) {
    console.log(`RK view ${approvalView.fn}(${singletonAddr}) →`, approvalView.value ? "APPROVED" : "NOT approved");
  } else {
    console.log("RK view function not found (isContractApproved/approved*). Will rely on write-probe.");
  }
  try {
    const legacy = await tryReadApprovalFlag(keeper, singletonAddr);
    if (legacy !== null) console.log("RK approval via artifact ABI:", legacy);
  } catch {}

  // Basic parameter validation against singleton limits
  try {
    if (argv.cid) {
      const cidLen = String(argv.cid).length;
      if (cidLen > 100) console.warn(`WARNING: CID length ${cidLen} exceeds MAX_CID_LENGTH (100).`);
    }
    const addendumLen = (argv.addendum || "").length;
    if (addendumLen > 1000) console.warn(`WARNING: addendum length ${addendumLen} exceeds MAX_ADDENDUM_LENGTH (1000).`);
  } catch {}

  // Build selection params
  const count  = BigInt(argv.count);
  const alpha  = BigInt(argv.alpha);
  const maxFee = ethers.parseUnits(argv.maxFee, 18); // LINK 18 decimals
  const estBase = ethers.parseUnits(argv.base, 18);
  const scale  = BigInt(argv.scale);
  const klass  = BigInt(argv.class);

  console.log("Selection params:",
    { count: count.toString(), alpha: alpha.toString(),
      maxFee: maxFee.toString(), base: estBase.toString(),
      scale: scale.toString(), class: klass.toString() });

  // selectOracles as singleton
  console.log("Probing keeper.selectOracles as the singleton (eth_call)...");
  let selectedDecoded = null;
  let recordWouldRevert = false;
  let gateEmpty = true;

  let firstCandidate = null;
  let oracleAddr, jobId;
  let oracleFee = 0n;

  // PASS/FAIL bookkeeping
  let passReasons = [];
  let failReasons = [];

  try {
    const data = keeper.interface.encodeFunctionData(
      "selectOracles", [count, alpha, maxFee, estBase, scale, klass]
    );
    const ret = await provider.call({ to: keeperAddr, data, from: singletonAddr });
    selectedDecoded = keeper.interface.decodeFunctionResult("selectOracles", ret);
    const cands = Array.isArray(selectedDecoded[0]) ? selectedDecoded[0] : selectedDecoded;
    console.log(`selectOracles OK. Selected: ${cands.length}`);
    if (cands.length === 0) failReasons.push("No candidate oracles returned.");
    if (cands.length > 0) {
      firstCandidate = cands[0];
      oracleAddr = firstCandidate.oracle ?? firstCandidate.operator ?? firstCandidate[0];
      jobId      = firstCandidate.jobId  ?? firstCandidate[1];

      const jobAscii = bytes32ToAsciiMaybe(jobId);
      console.log("First candidate tuple:", {
        oracle: oracleAddr, jobId,
        ...(jobAscii ? { jobId_ascii: jobAscii } : {})
      });

      // ---- PROBE: recordUsedOracles(chosen) using keeper ABI + full array ----
      try {
        const dataRUO = keeper.interface.encodeFunctionData("recordUsedOracles", [cands]);
        await provider.call({ to: keeperAddr, data: dataRUO, from: singletonAddr });
        console.log("recordUsedOracles (as singleton): WOULD SUCCEED");
        passReasons.push("Keeper accepts recordUsedOracles from singleton.");
      } catch (e) {
        recordWouldRevert = true;
        const msg = e.shortMessage || e.reason || e.message || String(e);
        console.log("recordUsedOracles (as singleton): WOULD REVERT →", msg);
        failReasons.push("Keeper rejected recordUsedOracles in write-probe.");
      }

      // --- Operator LINK + gating ---
      const OP_ABI = [
        "function isReputationKeeperListEmpty() view returns (bool)",
        "function getReputationKeepers() view returns (address[])",
        "function getChainlinkToken() view returns (address)",
        "function getAuthorizedSenders() view returns (address[])"
      ];
      let opLinkKnown = false;
      let opLinkAddr  = null;
      try {
        const op = await ethers.getContractAt(OP_ABI, oracleAddr, signer);
        gateEmpty = await op.isReputationKeeperListEmpty();
        console.log("Operator gate enabled? ", gateEmpty ? "NO (accept all)" : "YES (RK‑gated)");
        try {
          opLinkAddr = await op.getChainlinkToken();
          opLinkKnown = true;
          console.log("Operator LINK:", opLinkAddr);
          if (opLinkAddr.toLowerCase() !== linkAddr.toLowerCase()) {
            console.warn("WARNING: Operator LINK differs from Singleton LINK. Requests will revert on transferAndCall.");
            failReasons.push("Operator LINK != Singleton LINK");
          } else {
            passReasons.push("Operator LINK matches Singleton LINK.");
          }
        } catch { /* ok */ }
        if (!gateEmpty) {
          try {
            const rks = await op.getReputationKeepers();
            console.log("Operator RK list:", rks);
          } catch {
            console.log("Operator getReputationKeepers() not available.");
          }
        }
        try {
          const senders = await op.getAuthorizedSenders();
          console.log("Operator authorized fulfillers:", senders);
        } catch {
          console.log("Operator getAuthorizedSenders() not available.");
        }
      } catch (e) {
        console.log("Operator gating probe failed:", e.message || String(e));
      }

      // ERC‑165 check for ArbiterOperator interface (optional but informative)
      try {
        const ERC165 = await ethers.getContractAt(
          ["function supportsInterface(bytes4) view returns (bool)"],
          oracleAddr
        );
        const isArbiter = await ERC165.supportsInterface("0xd9f812f9"); // IArbiterOperator
        console.log("Operator supports IArbiterOperator?", isArbiter ? "YES" : "NO");
      } catch { /* ignore */ }

      // --- Oracle fee, caps, allowance math ---
      try {
        const info = await keeper.getOracleInfo(oracleAddr, jobId);
        const active  = info[0];
        const jobId2  = info[4];
        oracleFee     = info[5];
        const ascii2  = bytes32ToAsciiMaybe(jobId2);
        console.log("Oracle info:", { active, jobId: jobId2, feeWei: oracleFee.toString(), feeLINK: fmt(oracleFee, 18), ...(ascii2 ? { jobId_ascii: ascii2 } : {}) });

        if (oracleFee > maxFee) {
          console.warn(`WARNING: Selected oracle fee (${fmt(oracleFee, 18)} LINK) exceeds your --maxFee (${argv.maxFee} LINK). This selection would fail.`);
          failReasons.push("Selected oracle fee > --maxFee");
        } else {
          passReasons.push("Selected oracle fee ≤ --maxFee.");
        }
      } catch (e) {
        console.log("getOracleInfo failed:", e.message || String(e));
      }

      // --- LINK balance / allowance / needs ---
      const linkPlus = await ethers.getContractAt(ERC20_PLUS_ABI, linkAddr, signer);
      const [sym, dec] = await Promise.all([
        linkPlus.symbol().catch(() => "LINK"),
        linkPlus.decimals().catch(() => 18)
      ]);
      const balOwner = await linkPlus.balanceOf(ownerEOA).catch(() => 0n);
      console.log(`Owner LINK balance: ${ethers.formatUnits(balOwner, dec)} ${sym}`);

      const needNow   = oracleFee;        // base pull at request time
      const needTotal = oracleFee * 2n;   // base + bonus at fulfill
      const allowanceWei = await linkPlus.allowance(ownerEOA, singletonAddr);
      console.log(`Allowance to singleton: ${fmt(allowanceWei, dec)} ${sym} (${allowanceWei.toString()} wei)`);
      console.log("Oracle fee (wei):", oracleFee.toString(),
                  "needNow:", needNow.toString(), "needTotal:", needTotal.toString());

      // Show recommended allowance via singleton.maxTotalFee(--maxFee)
      try {
        const cap = await singleton.maxTotalFee(maxFee);
        console.log(`Recommended allowance (maxTotalFee(--maxFee)): ${fmt(cap, 18)} LINK`);
      } catch {}

      if (allowanceWei < needNow) {
        console.warn("WARNING: allowance < base fee. Entry call will revert: LINK pull failed.");
        failReasons.push("Allowance < base fee (needNow)");
      } else {
        passReasons.push("Allowance ≥ base fee.");
        if (allowanceWei < needTotal) {
          console.warn("NOTE: allowance < 2x fee. Entry call will succeed but bonus transfer at fulfill will later revert.");
        } else {
          console.log("Allowance is sufficient for both base and bonus.");
        }
      }

      // ---- OPTIONAL: Send approval if requested ----
      if (argv.approve) {
        const target = ethers.parseUnits(argv.approveAmount, dec);
        if (signer.address.toLowerCase() !== ownerEOA.toLowerCase()) {
          console.error(`Refusing to approve: current signer ${signer.address} does not control --owner ${ownerEOA}.`);
        } else if (balOwner < target) {
          console.error(`Refusing to approve: owner’s LINK balance ${fmt(balOwner, dec)} < target ${fmt(target, dec)}.`);
        } else {
          if (allowanceWei >= target) {
            console.log(`Allowance already ≥ target (${fmt(target, dec)}). Skipping approve.`);
          } else {
            console.log(`Sending approve(${singletonAddr}, ${fmt(target, dec)} ${sym}) from ${ownerEOA} …`);
            const tx = await linkPlus.approve(singletonAddr, target);
            const rc = await tx.wait();
            console.log("approve tx:", rc.hash);
            const post = await linkPlus.allowance(ownerEOA, singletonAddr);
            console.log(`New allowance: ${fmt(post, dec)} ${sym}`);
            if (post < needNow) {
              console.warn("Allowance still < base fee; increase --approveAmount or use smaller --maxFee.");
              failReasons.push("Post-approve allowance still < base fee");
            }
          }
        }
      }

      // ---- PROBE A: transferAndCall path (shape-only; expected to fail if unfunded) ----
      try {
        const LINK_ABI = [
          "function transferAndCall(address to, uint256 value, bytes data) returns (bool)",
          "function balanceOf(address) view returns (uint256)"
        ];
        const linkRW = await ethers.getContractAt(LINK_ABI, linkAddr, signer);
        const dataVersion = 1;
        const fakeNonce   = 777n;
        const callbackSel = singleton.interface.getFunction("fulfill").selector;
        const fakeCbor    = ethers.getBytes("0x01");

        // IMPORTANT: encode operatorRequest (function selector + args)
        const OP_IFACE = new ethers.Interface([
          "function operatorRequest(bytes32,address,bytes4,uint256,uint256,bytes)"
        ]);
        const opReq = OP_IFACE.encodeFunctionData(
          "operatorRequest",
          [jobId, singletonAddr, callbackSel, fakeNonce, dataVersion, fakeCbor]
        );

        const enc = linkRW.interface.encodeFunctionData("transferAndCall", [oracleAddr, oracleFee, opReq]);
        const tret = await provider.call({ to: linkAddr, data: enc, from: singletonAddr });
        const ok   = linkRW.interface.decodeFunctionResult("transferAndCall", tret)[0];
        console.log("transferAndCall(link→operator) would succeed?", ok ? "YES" : "NO");
      } catch (e) {
        const msg = e.shortMessage || e.reason || e.message || String(e);
        console.log("transferAndCall(link→operator) would REVERT →", msg);
        if (/transfer amount exceeds balance/i.test(msg)) {
          console.log("NOTE: This is expected in this *isolated* probe because the singleton has not been funded yet.");
          console.log("NOTE: In the real call, the contract first pulls LINK via transferFrom(owner→singleton), then calls transferAndCall.");
        }
      }

      // ---- PROBE B: operator.onTokenTransfer *as LINK token* (best revert reason) ----
      try {
        const OP_OT_ABI = [ "function onTokenTransfer(address,uint256,bytes) external" ];
        const opOT      = await ethers.getContractAt(OP_OT_ABI, oracleAddr, signer);
        const dataVersion = 1;
        const fakeNonce   = 888n;
        const callbackSel = singleton.interface.getFunction("fulfill").selector;
        const fakeCbor    = ethers.getBytes("0x01");

        // IMPORTANT: operatorRequest selector must be present inside 'data'
        const OP_IFACE2 = new ethers.Interface([
          "function operatorRequest(bytes32,address,bytes4,uint256,uint256,bytes)"
        ]);
        const opReq2 = OP_IFACE2.encodeFunctionData(
          "operatorRequest",
          [jobId, singletonAddr, callbackSel, fakeNonce, dataVersion, fakeCbor]
        );

        const callData = opOT.interface.encodeFunctionData(
          "onTokenTransfer",
          [singletonAddr, oracleFee, opReq2]
        );
        await provider.call({ to: oracleAddr, data: callData, from: linkAddr }); // simulate LINK calling operator
        console.log("operator.onTokenTransfer(...) would SUCCEED (simulated as LINK).");
        passReasons.push("Operator accepts operatorRequest payload via onTokenTransfer.");
      } catch (e) {
        const msg = e.shortMessage || e.reason || e.message || String(e);
        console.log("operator.onTokenTransfer(...) would REVERT →", msg);
        if (/whitelisted functions/i.test(msg)) {
          console.log("NOTE: This usually happens if the payload is missing the operatorRequest selector.");
          console.log("NOTE: The probe encodes operatorRequest correctly; if you see this, check Operator build.");
        }
        failReasons.push("Operator rejected onTokenTransfer probe.");
      }
    }
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    console.error("selectOracles (as singleton) reverted:", msg);
    console.error("This usually means: not approved, wrong class, or all filtered out.");
    failReasons.push("selectOracles reverted.");
  }

  // Optional dry-run & gas estimate of the entry call
  if (argv.cid) {
    console.log("Dry-running requestAIEvaluationWithApproval via eth_call (from owner EOA)...");
    const cidArray = [argv.cid];
    const addendum = argv.addendum || "";
    try {
      const calldata = singleton.interface.encodeFunctionData(
        "requestAIEvaluationWithApproval",
        [cidArray, addendum, alpha, maxFee, estBase, scale, BigInt(klass)]
      );
      await provider.call({ to: singletonAddr, data: calldata, from: ownerEOA });
      console.log("Dry-run OK: request would succeed with current params and allowance.");
      passReasons.push("Entry-call dry-run succeeded.");
    } catch (e) {
      const msg = e.shortMessage || e.reason || e.message || String(e);
      console.error("Dry-run revert:", msg);
      console.error("Common causes: LINK pull failed (low allowance), Operator rejection, no eligible oracles, CID/addendum limits, or keeper not set.");
      console.error("NOTE: If all other probes above are green, an eth_call revert can still occur depending on RPC simulation of token transfers.");
      failReasons.push("Entry-call dry-run reverted.");
    }

    // Gas estimate (often yields a better revert reason than eth_call)
    try {
      const writeAsOwner = await ethers.getContractAt("ReputationSingleton", singletonAddr, await ethers.getSigner(ownerEOA).catch(() => signer));
      const est = await writeAsOwner.requestAIEvaluationWithApproval.estimateGas(
        cidArray, addendum, alpha, maxFee, estBase, scale, BigInt(klass)
      );
      console.log("estimateGas:", est.toString());
      passReasons.push("estimateGas succeeded.");
    } catch (e) {
      console.log("estimateGas failed:", e.shortMessage || e.reason || e.message || String(e));
      console.log("NOTE: estimateGas can fail for harmless reasons if underlying tokens/Operator revert in simulation.");
      // Not marking as failure on its own.
    }
  } else {
    console.log("Tip: pass --cid <yourCID> to dry-run the full request from your EOA.");
  }

  // ---- SUMMARY ----
  console.log("---- SUMMARY ----");
  const rkApproved = approvalView.known ? approvalView.value : (recordWouldRevert === false);
  console.log(`RK approval view: ${approvalView.known ? (approvalView.value ? "APPROVED" : "NOT approved") : "unknown (no view fn)"}`);
  console.log(`recordUsedOracles write-probe: ${selectedDecoded ? (recordWouldRevert ? "WOULD REVERT (RK likely blocking)" : "WOULD SUCCEED") : "n/a (no candidates)"}`);
  console.log(`Operator gate: ${gateEmpty ? "ACCEPT-ALL" : "RK-GATED"}`);
  console.log("If NOT approved: fix in deploy step by ensuring RK.approveContract(singleton) is called by the RK owner.");

  // PASS/FAIL decision:
  // We require: RK approved, at least one candidate, recordUsedOracles succeeds, oracleFee ≤ maxFee,
  // allowance ≥ base fee, and (if known) Operator LINK matches Singleton LINK.
  let haveCandidate = false;
  try {
    const cands = Array.isArray(selectedDecoded?.[0]) ? selectedDecoded[0] : (selectedDecoded || []);
    haveCandidate = cands.length > 0;
  } catch {}
  const recordOK = haveCandidate && !recordWouldRevert;
  const feeCapOK = oracleFee > 0n ? (oracleFee <= maxFee) : true;

  // Allowance check only if we computed needs:
  let allowBaseOK = true;
  try {
    const linkPlus = await ethers.getContractAt(ERC20_PLUS_ABI, linkAddr, signer);
    const allowanceWei = await linkPlus.allowance(ownerEOA, singletonAddr);
    allowBaseOK = oracleFee === 0n ? true : (allowanceWei >= oracleFee);
  } catch {}

  // Operator LINK match status (if detectable)
  let linkMatchOK = true;
  try {
    const opIface = new ethers.Interface(["function getChainlinkToken() view returns (address)"]);
    const data = opIface.encodeFunctionData("getChainlinkToken", []);
    const ret  = await provider.call({ to: oracleAddr, data });
    if (ret && ret !== "0x") {
      const [opLink] = opIface.decodeFunctionResult("getChainlinkToken", ret);
      linkMatchOK = opLink.toLowerCase() === linkAddr.toLowerCase();
    }
  } catch {}

  const overallPass = rkApproved && haveCandidate && recordOK && feeCapOK && allowBaseOK && linkMatchOK;

  if (overallPass) {
    console.log("OVERALL: PASS");
  } else {
    console.log("OVERALL: FAIL");
    const why = [];
    if (!rkApproved)    why.push("RK not approved for singleton (or unknown and write-probe failed).");
    if (!haveCandidate) why.push("No oracle candidates returned by selectOracles.");
    if (!recordOK)      why.push("recordUsedOracles would revert.");
    if (!feeCapOK)      why.push("Selected oracle fee exceeds --maxFee.");
    if (!allowBaseOK)   why.push("Allowance < base oracle fee.");
    if (!linkMatchOK)   why.push("Operator LINK != Singleton LINK.");
    if (why.length) console.log("Reasons:", "- " + why.join("\n- "));
  }

  console.log("Diagnostics complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

