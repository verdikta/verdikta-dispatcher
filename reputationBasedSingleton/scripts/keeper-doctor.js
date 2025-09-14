#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Usage (recommended):
//   HARDHAT_NETWORK=base_sepolia node scripts/keeper-doctor.js \
//     --singleton 0xf1aE90D897982D43C47Ca6b46e6c71209bC2a91a \
//     --class 128 \
//     --owner 0xYourBrowserEOA \
//     --cid QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH \
//     --alpha 500 --maxFee 0.01 --base 0.0001 --scale 10
//
//   With auto-approval of LINK allowance (0.5 LINK by default):
//   HARDHAT_NETWORK=base_sepolia node scripts/keeper-doctor.js \
//     --singleton 0x92fDBEe3be721De0aC065F1E7Ed5E8E251CF9AcC \
//     --class 128 \
//     --owner 0xFBDE840eb654E0f8B9F3e6c69C354B309A9ffE6b \
//     --cid QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH \
//     --alpha 500 --maxFee 0.01 --base 0.0001 --scale 10 \
//     --approve --approveAmount 0.5
//
// Notes:
// - By default this script is read-only. If you pass --approve, it will send a real ERC-20
//   approval transaction from --owner to the singleton for --approveAmount LINK.
// - To send that tx, the configured signer MUST control --owner.

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

  // Code presence checks
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
  // Legacy ABI-aware approval check (if artifact exposes it)
  try {
    const legacy = await tryReadApprovalFlag(keeper, singletonAddr);
    if (legacy !== null) console.log("RK approval via artifact ABI:", legacy);
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
  try {
    const data = keeper.interface.encodeFunctionData(
      "selectOracles", [count, alpha, maxFee, estBase, scale, klass]
    );
    const ret = await provider.call({ to: keeperAddr, data, from: singletonAddr });
    selectedDecoded = keeper.interface.decodeFunctionResult("selectOracles", ret);
    const cands = Array.isArray(selectedDecoded[0]) ? selectedDecoded[0] : selectedDecoded;
    console.log(`selectOracles OK. Selected: ${cands.length}`);
    if (cands.length > 0) {
      firstCandidate = cands[0];
      const oracleAddr = firstCandidate.oracle ?? firstCandidate.operator ?? firstCandidate[0];
      const jobId      = firstCandidate.jobId  ?? firstCandidate[1];

      const jobAscii = bytes32ToAsciiMaybe(jobId);
      console.log("First candidate tuple:", {
        oracle: oracleAddr, jobId,
        ...(jobAscii ? { jobId_ascii: jobAscii } : {})
      });

      // ---- PROBE: recordUsedOracles(chosen) AS THE SINGLETON (keeper ABI + full array) ----
      try {
        const full = Array.isArray(selectedDecoded[0]) ? selectedDecoded[0] : selectedDecoded;
        const dataRUO = keeper.interface.encodeFunctionData("recordUsedOracles", [full]);
        await provider.call({ to: keeperAddr, data: dataRUO, from: singletonAddr });
        console.log("recordUsedOracles (as singleton): WOULD SUCCEED");
      } catch (e) {
        recordWouldRevert = true;
        console.log("recordUsedOracles (as singleton): WOULD REVERT →", e.shortMessage || e.reason || e.message || String(e));
      }

      // ---- PROBE: transferAndCall(link -> operator) path (shape only) ----
      try {
        const LINK_ABI = [
          "function transferAndCall(address to, uint256 value, bytes data) returns (bool)",
          "function balanceOf(address) view returns (uint256)"
        ];
        const linkRW = await ethers.getContractAt(LINK_ABI, linkAddr, signer);

        const dataVersion = 1;         // Operator v1 path
        const fakeNonce   = 777n;      // arbitrary (read-only)
        const callbackSel = singleton.interface.getFunction("fulfill").selector;
        const fakeCbor    = ethers.getBytes("0x01"); // minimal non-empty bytes

        const opReq = ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32","address","bytes4","uint256","uint256","bytes"],
          [jobId, singletonAddr, callbackSel, fakeNonce, dataVersion, fakeCbor]
        );

        const feeWei = (await keeper.getOracleInfo(oracleAddr, jobId))[5]; // oracle fee
        const enc = linkRW.interface.encodeFunctionData("transferAndCall", [oracleAddr, feeWei, opReq]);

        const tret = await provider.call({ to: linkAddr, data: enc, from: singletonAddr });
        const ok   = linkRW.interface.decodeFunctionResult("transferAndCall", tret)[0];
        console.log("transferAndCall(link→operator) would succeed?", ok ? "YES" : "NO");
      } catch (e) {
        const msg = e.shortMessage || e.reason || e.message || String(e);
        console.log("transferAndCall(link→operator) would REVERT →", msg);
        if (/transfer amount exceeds balance/i.test(msg)) {
          console.log("NOTE: This is expected in the probe if the singleton hasn’t been funded yet. " +
                      "In real flow, the contract first pulls LINK via transferFrom(owner→singleton).");
        }
      }

      // --- LINK balance, decimals, symbol ---
      const linkPlus = await ethers.getContractAt(ERC20_PLUS_ABI, linkAddr, signer);
      const [sym, dec] = await Promise.all([
        linkPlus.symbol().catch(() => "LINK"),
        linkPlus.decimals().catch(() => 18)
      ]);
      const balOwner = await linkPlus.balanceOf(ownerEOA).catch(() => 0n);
      console.log(`Owner LINK balance: ${ethers.formatUnits(balOwner, dec)} ${sym}`);

      // Allowance & needs
      const info = await keeper.getOracleInfo(oracleAddr, jobId);
      const oracleFee = info[5];
      const needNow   = oracleFee;        // base pull at request time
      const needTotal = oracleFee * 2n;   // base + bonus at fulfill

      const allowanceWei = await linkPlus.allowance(ownerEOA, singletonAddr);
      console.log(`Allowance to singleton: ${fmt(allowanceWei, dec)} ${sym} (${allowanceWei.toString()} wei)`);
      console.log("Oracle fee (wei):", oracleFee.toString(),
                  "needNow:", needNow.toString(), "needTotal:", needTotal.toString());

      if (allowanceWei < needNow) {
        console.warn("WARNING: allowance < base fee. Entry call will revert: LINK pull failed.");
      } else if (allowanceWei < needTotal) {
        console.warn("NOTE: allowance < 2x fee. Entry call will succeed but bonus transfer at fulfill will later revert.");
      } else {
        console.log("Allowance is sufficient for both base and bonus.");
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
              console.warn("Allowance still < base fee; increase --approveAmount or use --maxFee smaller.");
            }
          }
        }
      }

      // Operator gating + RK list
      const OP_ABI = [
        "function isReputationKeeperListEmpty() view returns (bool)",
        "function getReputationKeepers() view returns (address[])",
        "function getChainlinkToken() view returns (address)"
      ];
      try {
        const op = await ethers.getContractAt(OP_ABI, oracleAddr);
        gateEmpty = await op.isReputationKeeperListEmpty();
        console.log("Operator gate enabled? ", gateEmpty ? "NO (accept all)" : "YES (RK‑gated)");
        try {
          const opLink = await op.getChainlinkToken();
          console.log("Operator LINK:", opLink);
          if (opLink.toLowerCase() !== linkAddr.toLowerCase()) {
            console.warn("WARNING: Operator LINK differs from Singleton LINK. Requests will revert on transferAndCall.");
          }
        } catch { /* older operator: no getter; ok */ }
        if (!gateEmpty) {
          try {
            const rks = await op.getReputationKeepers();
            console.log("Operator RK list:", rks);
          } catch {
            console.log("Operator getReputationKeepers() not available.");
          }
        }
      } catch (e) {
        console.log("Operator gating probe failed:", e.message || String(e));
      }

      // Fetch oracle info again, print human fee
      try {
        const info2 = await keeper.getOracleInfo(oracleAddr, jobId);
        const active  = info2[0];
        const jobId2  = info2[4];
        const feeWei  = info2[5];
        const ascii2  = bytes32ToAsciiMaybe(jobId2);
        console.log("Oracle info:", { active, jobId: jobId2, feeWei: feeWei.toString(), feeLINK: fmt(feeWei, 18), ...(ascii2 ? { jobId_ascii: ascii2 } : {}) });
      } catch (e) {
        console.log("getOracleInfo failed:", e.message || String(e));
      }
    }
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    console.error("selectOracles (as singleton) reverted:", msg);
    console.error("This usually means: not approved, wrong class, or all filtered out.");
  }

  // Optional dry-run of entry call
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
    } catch (e) {
      const msg = e.shortMessage || e.reason || e.message || String(e);
      console.error("Dry-run revert:", msg);
      console.error("Common causes: LINK pull failed (low allowance), RK gating (recordUsedOracles), no eligible oracles, CID/addendum limits, or keeper not set.");
    }
  } else {
    console.log("Tip: pass --cid <yourCID> to dry-run the full request from your EOA.");
  }

  // ---- SUMMARY ----
  console.log("---- SUMMARY ----");
  console.log(`RK approval view: ${approvalView.known ? (approvalView.value ? "APPROVED" : "NOT approved") : "unknown (no view fn)"}`);
  console.log(`recordUsedOracles write-probe: ${selectedDecoded ? (recordWouldRevert ? "WOULD REVERT (RK likely blocking)" : "WOULD SUCCEED") : "n/a (no candidates)"}`);
  console.log(`Operator gate: ${gateEmpty ? "ACCEPT-ALL" : "RK-GATED"}`);
  console.log("If NOT approved: fix in deploy step by ensuring RK.approveContract(singleton) is called by the RK owner.");
  console.log("Diagnostics complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

