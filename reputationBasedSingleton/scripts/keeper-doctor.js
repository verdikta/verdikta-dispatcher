#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Usage (common):
//   HARDHAT_NETWORK=base_sepolia node scripts/keeper-doctor.js \
//     --singleton 0x9d65A82378B517A97515Fa8904C32cADF31FD7ed \
//     --aggregator 0xb2b724e4ee4Fa19Ccd355f12B4bB8A2F8C8D0089 \
//     --class 128 --owner 0xYourBrowserEOA \
//     --cid QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH \
//     --alpha 500 --maxFee 0.01 --base 0.0001 --scale 10
//
// With allowance commit (approve) of 0.5 LINK from --owner:
//   ... --approve --approveAmount 0.5
//
// Notes:
// - Read-only unless you pass --approve (then it sends an ERC‑20 approve tx from --owner).
// - Probes both Operator (6‑arg) and Oracle (8‑arg) request entrypoints;
//   many operators accept only the 8‑arg Oracle path.
// - NEW: Checks ReputationKeeper **consumer owner binding** and **class enablement** for both
//   Singleton and Aggregator consumers; these are common causes of "no oracles" errors.

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

// -------- Aggregator minimal ABI (as per your contract) --------
const AGG_MIN_ABI = [
  "function reputationKeeper() view returns (address)",
  "function getContractConfig() view returns (address,address,bytes32,uint256)",
  "function commitOraclesToPoll() view returns (uint256)",
  "function maxTotalFee(uint256) view returns (uint256)"
];

// -------- Helpers: approval flag (legacy) --------
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
      else return null;
    }
    return out.length >= 6 ? out : null;
  } catch { return null; }
}

function toHex(bn) {
  try { return "0x" + BigInt(bn).toString(16); } catch { return String(bn); }
}

// -------- NEW: Keeper consumer binding & class enablement probes --------
const OWNER_SIGS = [
  "function ownerEOA(address) view returns (address)",
  "function getOwnerEOA(address) view returns (address)",
  "function consumerOwner(address) view returns (address)",
  "function consumerOwnerOf(address) view returns (address)",
  "function consumerToOwner(address) view returns (address)",
];

const CLASS_ENABLED_SIGS = [
  "function isClassEnabled(address,uint64) view returns (bool)",
  "function isClassApproved(address,uint64) view returns (bool)",
  "function isClassAllowed(address,uint64) view returns (bool)"
];

const CLASS_MASK_SIGS = [
  "function allowedClassMask(address) view returns (uint256)",
  "function getAllowedClassMask(address) view returns (uint256)",
  "function getAllowedClasses(address) view returns (uint256)",
  "function consumerClassMask(address) view returns (uint256)",
  "function classMaskOf(address) view returns (uint256)"
];

async function callViewIfExists(provider, to, sig, args) {
  try {
    const iface = new ethers.Interface([sig]);
    // Extract function name from signature
    const fnName = sig.match(/function (\w+)/)?.[1];
    if (!fnName) return undefined;
    
    const data = iface.encodeFunctionData(fnName, args);
    const ret  = await provider.call({ to, data });
    if (ret && ret !== "0x") {
      const out = iface.decodeFunctionResult(fnName, ret);
      return out.length === 1 ? out[0] : out;
    }
  } catch (e) {
    // Add debug logging for this specific function
    console.log(`DEBUG: callViewIfExists failed for ${sig}: ${e.message}`);
  }
  return undefined;
}

async function probeConsumerBinding(provider, keeperAddr, consumerAddr) {
  console.log(`DEBUG: Probing consumer binding for ${consumerAddr}...`);
  for (const sig of OWNER_SIGS) {
    const owner = await callViewIfExists(provider, keeperAddr, sig, [consumerAddr]);
    if (owner !== undefined) {
      console.log(`DEBUG: Found owner via ${sig.match(/function (\w+)/)[1]}: ${owner}`);
      return { found: true, owner: owner };
    }
  }
  console.log(`DEBUG: No consumer binding function found`);
  return { found: false, owner: undefined };
}

async function probeClassEnablement(provider, keeperAddr, consumerAddr, klassBig) {
  console.log(`DEBUG: Probing class enablement for class ${klassBig} on ${consumerAddr}...`);
  
  // 1) Direct per-class boolean if available
  for (const sig of CLASS_ENABLED_SIGS) {
    const ok = await callViewIfExists(provider, keeperAddr, sig, [consumerAddr, Number(klassBig)]);
    if (ok !== undefined) {
      console.log(`DEBUG: Class enabled via ${sig.match(/function (\w+)/)[1]}: ${ok}`);
      return { mode: "fn", enabled: !!ok, mask: undefined, maskFound: false };
    }
  }
  
  // 2) Mask-based, infer by (mask & klass) != 0
  for (const sig of CLASS_MASK_SIGS) {
    const m = await callViewIfExists(provider, keeperAddr, sig, [consumerAddr]);
    if (m !== undefined) {
      try {
        const maskBig = BigInt(m.toString ? m.toString() : m);
        const enabled = (maskBig & klassBig) !== 0n;
        console.log(`DEBUG: Class mask ${toHex(maskBig)}, class ${klassBig} enabled: ${enabled}`);
        return { mode: "mask", enabled, mask: maskBig, maskFound: true };
      } catch {
        console.log(`DEBUG: Found mask but couldn't parse: ${m}`);
        return { mode: "mask", enabled: null, mask: m, maskFound: true };
      }
    }
  }
  
  console.log(`DEBUG: No class enablement mechanism found`);
  return { mode: "unknown", enabled: null, mask: undefined, maskFound: false };
}

// Try one onTokenTransfer payload variant and return {ok, reason}
async function tryOnTokenTransferVariant({ provider, operator, linkAddr, payloadLabel, payloadBytes, senderAddr, amountWei }) {
  const OP_OT_ABI = ["function onTokenTransfer(address,uint256,bytes) external"];
  const opOT      = new ethers.Interface(OP_OT_ABI);
  const callData  = opOT.encodeFunctionData("onTokenTransfer", [senderAddr, amountWei, payloadBytes]);
  try {
    await provider.call({ to: operator, data: callData, from: linkAddr }); // simulate as LINK
    return { ok: true, reason: null };
  } catch (e) {
    const msg = e.shortMessage || e.reason || e.message || String(e);
    return { ok: false, reason: msg };
  }
}

// Dual‑entrypoint probe: operatorRequest(6) and Oracle's oracleRequest(8)
async function detectOperatorEntrypointDetailed({ provider, signer, operator, linkAddr, jobId, singletonAddr, oracleFee, callbackSel }) {
  const dataVersion = 1;
  const nonceOp     = 111n;
  const nonceOr     = 112n;
  const fakeCbor    = ethers.getBytes("0x01");

  // Operator (6 args)
  const IF_OP = new ethers.Interface([
    "function operatorRequest(bytes32,address,bytes4,uint256,uint256,bytes)"
  ]);
  const payloadOp = IF_OP.encodeFunctionData("operatorRequest",
    [jobId, singletonAddr, callbackSel, nonceOp, dataVersion, fakeCbor]
  );

  // Oracle (8 args)
  const IF_OR = new ethers.Interface([
    "function oracleRequest(address,uint256,bytes32,address,bytes4,uint256,uint256,bytes)"
  ]);
  const payloadOr = IF_OR.encodeFunctionData("oracleRequest",
    [singletonAddr, oracleFee, jobId, singletonAddr, callbackSel, nonceOr, dataVersion, fakeCbor]
  );

  const a = await tryOnTokenTransferVariant({
    provider, operator, linkAddr,
    payloadLabel: "operatorRequest(6)",
    payloadBytes: payloadOp,
    senderAddr: singletonAddr, amountWei: oracleFee
  });

  const b = await tryOnTokenTransferVariant({
    provider, operator, linkAddr,
    payloadLabel: "oracleRequest(8)",
    payloadBytes: payloadOr,
    senderAddr: singletonAddr, amountWei: oracleFee
  });

  let flavor = "none";
  if (a.ok && b.ok) flavor = "both";
  else if (a.ok)    flavor = "operatorRequest(6)";
  else if (b.ok)    flavor = "oracleRequest(8)";

  return { flavor, results: { operatorRequest6: a, oracleRequest8: b } };
}

// Select with specified "from"
async function selectWithFrom({ provider, keeper, fromAddr, count, alpha, maxFee, estBase, scale, klass }) {
  const data = keeper.interface.encodeFunctionData(
    "selectOracles", [count, alpha, maxFee, estBase, scale, klass]
  );
  const ret  = await provider.call({ to: keeper.target ?? keeper.address, data, from: fromAddr });
  const decoded = keeper.interface.decodeFunctionResult("selectOracles", ret);
  const arr = Array.isArray(decoded[0]) ? decoded[0] : decoded;
  return arr.map((x) => ({
    oracle: x.oracle ?? x.operator ?? x[0],
    jobId:  x.jobId  ?? x[1]
  }));
}

function tupleKey(t) { return `${t.oracle.toLowerCase()}::${ethers.hexlify(t.jobId).toLowerCase()}`; }

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("singleton",      { type: "string", describe: "ReputationSingleton address (optional)" })
    .option("aggregator",     { type: "string", describe: "ReputationAggregator address (optional)" })
    .option("class",          { type: "number", default: 128, describe: "Requested oracle class" })
    .option("count",          { type: "number", default: 1,   describe: "How many oracles to select (singleton)" })
    .option("alpha",          { type: "number", default: 0,   describe: "Alpha for selection (0..1000)" })
    .option("maxFee",         { type: "string", default: "1", describe: "Max oracle fee in LINK (e.g. '0.01')" })
    .option("base",           { type: "string", default: "0", describe: "Estimated base cost in LINK (e.g. '0.0001')" })
    .option("scale",          { type: "number", default: 1,   describe: "Max fee-based scaling factor (>=1)" })
    .option("owner",          { type: "string", describe: "EOA that will call the contracts (browser wallet)" })
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

  // Resolve singleton
  let singletonAddr = argv.singleton;
  if (!singletonAddr) {
    const dep = await deployments.get("ReputationSingleton");
    singletonAddr = dep.address;
  }
  console.log("Singleton:", singletonAddr);
  const codeSingleton = await provider.getCode(singletonAddr);
  if (codeSingleton === "0x") throw new Error("No code at singleton address.");
  const singleton = await ethers.getContractAt("ReputationSingleton", singletonAddr, signer);

  // Keeper & LINK from singleton
  const keeperAddr = await singleton.reputationKeeper();
  const cfgS = await singleton.getContractConfig(); // (operatorAddr, linkAddr, jobId, fee)
  const linkAddr = cfgS.linkAddr || cfgS[1];
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

  // RK approval for singleton
  console.log("Checking RK approval (robust view) …");
  const approvalViewS = await probeKeeperApprovalView(provider, keeperAddr, singletonAddr);
  if (approvalViewS.known) {
    console.log(`RK view ${approvalViewS.fn}(${singletonAddr}) →`, approvalViewS.value ? "APPROVED" : "NOT approved");
  } else {
    console.log("RK view function not found (isContractApproved/approved*).");
  }
  try {
    const legacy = await tryReadApprovalFlag(keeper, singletonAddr);
    if (legacy !== null) console.log("RK approval via artifact ABI:", legacy);
  } catch {}

  // (NEW) Keeper consumer owner & class for singleton
  const klass = BigInt(argv.class);
  const bindS = await probeConsumerBinding(provider, keeperAddr, singletonAddr);
  const classS = await probeClassEnablement(provider, keeperAddr, singletonAddr, klass);
  const ownerSStr = bindS.owner ? String(bindS.owner) : (bindS.found ? "0x0000000000000000000000000000000000000000" : "<unknown>");
  console.log(`RK consumer owner (singleton): ${ownerSStr}${bindS.found ? "" : " (owner function not found)"}`);
  if (classS.mode === "fn") {
    console.log(`RK class ${argv.class} enabled for singleton?: ${classS.enabled ? "YES" : "NO"} (via isClassEnabled*)`);
  } else if (classS.mode === "mask") {
    console.log(`RK class ${argv.class} enabled for singleton?: ${(classS.enabled===true) ? "YES" : (classS.enabled===false ? "NO" : "unknown")} (via class mask ${toHex(classS.mask)})`);
  } else {
    console.log(`RK class ${argv.class} enabled for singleton?: <unknown> (no view found)`);
  }

  // If aggregator provided, read its keeper & link and approval too
  let aggAddr = argv.aggregator || null;
  let aggKeeperAddr = null;
  let aggLinkAddr = null;
  let aggK = null;
  let agg = null;
  let bindA = null;
  let classA = null;

  if (aggAddr) {
    console.log("Aggregator:", aggAddr);
    const codeAgg = await provider.getCode(aggAddr);
    if (codeAgg === "0x") {
      console.warn("WARNING: No code at aggregator address; ignoring --aggregator.");
      aggAddr = null;
    } else {
      agg = await ethers.getContractAt(AGG_MIN_ABI, aggAddr, signer);
      aggKeeperAddr = await agg.reputationKeeper();
      const cfgA = await agg.getContractConfig();
      aggLinkAddr = cfgA[1];

      console.log("Keeper from aggregator:", aggKeeperAddr);
      console.log("LINK from aggregator :", aggLinkAddr);

      if (aggKeeperAddr.toLowerCase() !== keeperAddr.toLowerCase()) {
        console.warn("WARNING: Aggregator and Singleton point to DIFFERENT keepers.");
      }
      if (aggLinkAddr.toLowerCase() !== linkAddr.toLowerCase()) {
        console.warn("WARNING: Aggregator and Singleton use DIFFERENT LINK tokens.");
      }

      const approvalViewA = await probeKeeperApprovalView(provider, keeperAddr, aggAddr);
      if (approvalViewA.known) {
        console.log(`RK view ${approvalViewA.fn}(${aggAddr}) →`, approvalViewA.value ? "APPROVED" : "NOT approved");
      }

      try {
        aggK = await agg.commitOraclesToPoll();
        console.log("Aggregator commitOraclesToPoll (K):", aggK.toString());
      } catch {
        console.log("Aggregator.commitOraclesToPoll() not readable; will fall back to --count.");
      }

      // (NEW) Keeper consumer owner & class for aggregator
      bindA  = await probeConsumerBinding(provider, keeperAddr, aggAddr);
      classA = await probeClassEnablement(provider, keeperAddr, aggAddr, klass);
      const ownerAStr = bindA.owner ? String(bindA.owner) : (bindA.found ? "0x0000000000000000000000000000000000000000" : "<unknown>");
      console.log(`RK consumer owner (aggregator): ${ownerAStr}${bindA.found ? "" : " (owner function not found)"}`);
      if (classA.mode === "fn") {
        console.log(`RK class ${argv.class} enabled for aggregator?: ${classA.enabled ? "YES" : "NO"} (via isClassEnabled*)`);
      } else if (classA.mode === "mask") {
        console.log(`RK class ${argv.class} enabled for aggregator?: ${(classA.enabled===true) ? "YES" : (classA.enabled===false ? "NO" : "unknown")} (via class mask ${toHex(classA.mask)})`);
      } else {
        console.log(`RK class ${argv.class} enabled for aggregator?: <unknown> (no view found)`);
      }
    }
  }

  // Basic parameter validation
  try {
    if (argv.cid) {
      const cidLen = String(argv.cid).length;
      if (cidLen > 100) console.warn(`WARNING: CID length ${cidLen} exceeds MAX_CID_LENGTH (100).`);
    }
    const addendumLen = (argv.addendum || "").length;
    if (addendumLen > 1000) console.warn(`WARNING: addendum length ${addendumLen} exceeds MAX_ADDENDUM_LENGTH (1000).`);
  } catch {}

  // Build selection params
  const alpha  = BigInt(argv.alpha);
  const maxFee = ethers.parseUnits(argv.maxFee, 18);
  const estBase = ethers.parseUnits(argv.base, 18);
  const scale  = BigInt(argv.scale);

  console.log("Selection params (common):",
    { alpha: alpha.toString(), maxFee: maxFee.toString(),
      base: estBase.toString(), scale: scale.toString(), class: klass.toString() });

  const countS = BigInt(argv.count);
  console.log("Singleton selection count:", countS.toString());

  let countA = null;
  if (aggAddr) {
    countA = aggK ? BigInt(aggK) : BigInt(argv.count);
    console.log("Aggregator selection count:", countA.toString(), aggK ? "(K from contract)" : "(fallback to --count)");
  }

  // PASS/FAIL bookkeeping
  let passS = true, passA = true;
  const failS = [], failA = [];

  // ---- SELECTION(S) ----
  let selectedS = [];
  let selectedA = [];

  console.log("Selecting (as singleton)…");
  try {
    selectedS = await selectWithFrom({ provider, keeper, fromAddr: singletonAddr, count: countS, alpha, maxFee, estBase, scale, klass });
    console.log(`Singleton selected ${selectedS.length}:`, selectedS.map(t => ({
      oracle: t.oracle,
      jobId: t.jobId,
      jobId_ascii: bytes32ToAsciiMaybe(t.jobId) || undefined
    })));
    if (selectedS.length === 0) { passS = false; failS.push("No candidate oracles returned."); }
  } catch (e) {
    console.error("selectOracles (as singleton) reverted:", e.shortMessage || e.reason || e.message || String(e));
    passS = false; failS.push("selectOracles reverted.");
  }

  if (aggAddr) {
    console.log("Selecting (as aggregator)…");
    try {
      selectedA = await selectWithFrom({ provider, keeper, fromAddr: aggAddr, count: countA, alpha, maxFee, estBase, scale, klass });
      console.log(`Aggregator selected ${selectedA.length}:`, selectedA.map(t => ({
        oracle: t.oracle,
        jobId: t.jobId,
        jobId_ascii: bytes32ToAsciiMaybe(t.jobId) || undefined
      })));
      if (selectedA.length === 0) { passA = false; failA.push("No candidate oracles returned."); }
    } catch (e) {
      console.error("selectOracles (as aggregator) reverted:", e.shortMessage || e.reason || e.message || String(e));
      passA = false; failA.push("selectOracles reverted.");
    }
  }

  // ---- recordUsedOracles probe (canonical tuple encoding) ----
  async function probeRecord(fromAddr, label, tuples) {
    const R_IF = new ethers.Interface([
      "function recordUsedOracles(tuple(address oracle, bytes32 jobId)[] chosen) external"
    ]);
    const packed = tuples.map(t => [t.oracle, t.jobId]); // canonical positional tuples
    try {
      const dataRUO = R_IF.encodeFunctionData("recordUsedOracles", [packed]);
      await provider.call({ to: keeperAddr, data: dataRUO, from: fromAddr });
      console.log(`recordUsedOracles (as ${label}): WOULD SUCCEED`);
      return true;
    } catch (e) {
      console.log(`recordUsedOracles (as ${label}): WOULD REVERT →`, e.shortMessage || e.reason || e.message || String(e));
      return false;
    }
  }
  if (selectedS.length) {
    const ok = await probeRecord(singletonAddr, "singleton", selectedS);
    if (!ok) { 
      // Don't fail for singleton since it might not need recordUsedOracles
      console.log("NOTE: recordUsedOracles fails but singleton might not require it");
    }
  }
  if (aggAddr && selectedA.length) {
    const ok = await probeRecord(aggAddr, "aggregator", selectedA);
    if (!ok) { passA = false; failA.push("Keeper rejected recordUsedOracles (aggregator)."); }
  }

  // ---- Operator checks for EACH candidate ----
  const OP_ABI = [
    "function isReputationKeeperListEmpty() view returns (bool)",
    "function getReputationKeepers() view returns (address[])",
    "function getChainlinkToken() view returns (address)",
    "function getAuthorizedSenders() view returns (address[])"
  ];
  const callbackSel = singleton.interface.getFunction("fulfill").selector;

  async function enrichCandidate(t) {
    const enriched = { ...t };
    try {
      const info = await keeper.getOracleInfo(t.oracle, t.jobId);
      enriched.active = info[0];
      enriched.feeWei = info[5];
      enriched.feeLINK = fmt(info[5], 18);
    } catch (e) {
      enriched.infoError = e.message || String(e);
    }

    try {
      const op = await ethers.getContractAt(OP_ABI, t.oracle, signer);
      try {
        enriched.gateEmpty = await op.isReputationKeeperListEmpty();
      } catch {}
      try {
        enriched.opLink = await op.getChainlinkToken();
        enriched.linkMatch = enriched.opLink && (enriched.opLink.toLowerCase() === linkAddr.toLowerCase());
      } catch {}
      try {
        enriched.authorized = await op.getAuthorizedSenders();
        if (Array.isArray(enriched.authorized)) {
          console.log("Operator authorized fulfillers @", t.oracle, ":", enriched.authorized);
        }
      } catch {}
      // ERC‑165 probe (optional)
      try {
        const E165 = await ethers.getContractAt(["function supportsInterface(bytes4) view returns (bool)"], t.oracle);
        enriched.isArbiter = await E165.supportsInterface("0xd9f812f9");
      } catch {}
      // Entrypoint flavor detection with detailed reasons
      try {
        const fee = enriched.feeWei ?? 0n;
        const d = await detectOperatorEntrypointDetailed({
          provider, signer, operator: t.oracle, linkAddr, jobId: t.jobId, singletonAddr, oracleFee: fee, callbackSel
        });
        enriched.entrypoint = d.flavor;
        enriched.entryReasons = d.results;
      } catch (e) {
        enriched.entrypoint = "probe-error";
        enriched.entryErr = e.message || String(e);
      }
    } catch (e) {
      enriched.operatorErr = e.message || String(e);
    }
    return enriched;
  }

  const enrichedS = [];
  for (const t of selectedS) enrichedS.push(await enrichCandidate(t));

  const enrichedA = [];
  if (aggAddr) {
    for (const t of selectedA) enrichedA.push(await enrichCandidate(t));
  }

  function printList(label, list) {
    console.log(`\n[ ${label} candidates ]`);
    for (const e of list) {
      console.log({
        oracle: e.oracle,
        jobId: e.jobId,
        jobId_ascii: bytes32ToAsciiMaybe(e.jobId) || undefined,
        active: e.active,
        feeLINK: e.feeLINK,
        opLINK: e.opLink,
        opLINK_matches_singleton: e.linkMatch,
        gate: e.gateEmpty === undefined ? "unknown" : (e.gateEmpty ? "ACCEPT-ALL" : "RK-GATED"),
        entrypoint: e.entrypoint,
        entry_reasons: e.entryReasons ? {
          operatorRequest6: e.entryReasons.operatorRequest6,
          oracleRequest8:   e.entryReasons.oracleRequest8
        } : undefined,
        isArbiterOperator: e.isArbiter
      });
    }
  }
  printList("Singleton", enrichedS);
  if (aggAddr) printList("Aggregator", enrichedA);

  // ---- Selection overlap/diff ----
  if (aggAddr) {
    const setS = new Set(enrichedS.map(tupleKey));
    const setA = new Set(enrichedA.map(tupleKey));
    const inter = [...setS].filter(k => setA.has(k));
    const onlyS = [...setS].filter(k => !setA.has(k));
    const onlyA = [...setA].filter(k => !setS.has(k));
    console.log("\n[ Selection comparison ]");
    console.log("Intersection size:", inter.length);
    console.log("Only Singleton:", onlyS.length, onlyS);
    console.log("Only Aggregator:", onlyA.length, onlyA);
    if (onlyS.length && !inter.length) {
      console.log("NOTE: Divergent selection alone can make one path succeed while the other fails.");
    }
  }

  // ---- LINK balances & allowance (singleton) ----
  const linkRW = await ethers.getContractAt(ERC20_PLUS_ABI, linkAddr, signer);
  const [sym, dec] = await Promise.all([
    linkRW.symbol().catch(() => "LINK"),
    linkRW.decimals().catch(() => 18)
  ]);
  const balOwner = await linkRW.balanceOf(ownerEOA).catch(() => 0n);
  const allowanceWei = await linkRW.allowance(ownerEOA, singletonAddr);
  console.log(`\nOwner LINK balance: ${ethers.formatUnits(balOwner, dec)} ${sym}`);
  console.log(`Allowance to singleton: ${fmt(allowanceWei, dec)} ${sym} (${allowanceWei.toString()} wei)`);

  try {
    const capS = await singleton.maxTotalFee(maxFee);
    console.log(`Recommended allowance (singleton.maxTotalFee(--maxFee)): ${fmt(capS, 18)} LINK`);
  } catch {}

  // Optional approve
  if (argv.approve) {
    const target = ethers.parseUnits(argv.approveAmount, dec);
    if (signer.address.toLowerCase() !== ownerEOA.toLowerCase()) {
      console.error(`Refusing to approve: current signer ${signer.address} does not control --owner ${ownerEOA}.`);
    } else if (balOwner < target) {
      console.error(`Refusing to approve: owner's LINK balance ${fmt(balOwner, dec)} < target ${fmt(target, dec)}.`);
    } else {
      if (allowanceWei >= target) {
        console.log(`Allowance already ≥ target (${fmt(target, dec)}). Skipping approve.`);
      } else {
        console.log(`Sending approve(${singletonAddr}, ${fmt(target, dec)} ${sym}) from ${ownerEOA} …`);
        const tx = await linkRW.approve(singletonAddr, target);
        const rc = await tx.wait();
        console.log("approve tx:", rc.hash);
        const post = await linkRW.allowance(ownerEOA, singletonAddr);
        console.log(`New allowance: ${fmt(post, dec)} ${sym}`);
      }
    }
  }

  // ---- Dry-run entry call (singleton) ----
  if (argv.cid) {
    console.log("\nDry-running singleton.requestAIEvaluationWithApproval via eth_call (from owner EOA)...");
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
      console.error("Common causes: LINK pull failed (low allowance), Operator/Oracle entrypoint mismatch, no eligible oracles, CID/addendum limits, or keeper not set.");
      console.error("NOTE: If other probes above are green, eth_call may still revert due to token/Operator simulation quirks.");
    }
  }

  // ---- (Optional) Aggregator math and allowance hint ----
  if (aggAddr) {
    try {
      const capA = await agg.maxTotalFee(maxFee);
      console.log(`\nAggregator maxTotalFee(--maxFee): ${fmt(capA, 18)} LINK`);
      console.log("NOTE: Aggregator needs K base-fees up front and bonus later; ensure allowance covers maxTotalFee for smoother runs.");
    } catch {}
  }

  // ---- PASS/FAIL decisions ----
  function evaluate(list, label) {
    let ok = true;
    const reasons = [];
    if (!list.length) { ok = false; reasons.push("No candidates selected."); }

    for (const e of list) {
      if (e.feeWei && e.feeWei > maxFee) { ok = false; reasons.push(`Oracle fee ${fmt(e.feeWei,18)} > --maxFee for ${e.oracle}`); }
      if (e.linkMatch === false) { ok = false; reasons.push(`Operator LINK != Singleton LINK for ${e.oracle}`); }

      // Check entrypoint based on what the aggregator is using
      // If aggregator works with operator(6), accept either
      if (e.entrypoint === "none" || e.entrypoint === "probe-error") {
        ok = false;
        const r6 = e.entryReasons?.operatorRequest6?.reason;
        const r8 = e.entryReasons?.oracleRequest8?.reason;
        reasons.push(`Operator ${e.oracle} rejected both entrypoints. Reasons: op(6)=${r6 || "?"}, or(8)=${r8 || "?"}`);
      }
    }
    return { ok, reasons };
  }

  const evalS = evaluate(enrichedS, "Singleton");

  // Fold in RK approval + NEW consumer owner/class checks for Singleton
  if (!approvalViewS.known || !approvalViewS.value) {
    evalS.ok = false; evalS.reasons.push("RK not approved (singleton).");
  }
  if (bindS.found) {
    const isZeroOwner = String(bindS.owner).toLowerCase() === "0x0000000000000000000000000000000000000000";
    if (isZeroOwner) { evalS.ok = false; evalS.reasons.push("RK consumer owner not set for singleton."); }
  }
  if (classS.mode === "fn" && classS.enabled === false) {
    evalS.ok = false; evalS.reasons.push(`RK class ${argv.class} is DISABLED for singleton.`);
  } else if (classS.mode === "mask" && classS.enabled === false) {
    evalS.ok = false; evalS.reasons.push(`RK class ${argv.class} bit is not set in consumer mask for singleton.`);
  }

  let evalA = { ok: true, reasons: [] };
  if (aggAddr) {
    evalA = evaluate(enrichedA, "Aggregator");

    const approvalViewA = await probeKeeperApprovalView(provider, keeperAddr, aggAddr);
    if (!approvalViewA.known || !approvalViewA.value) { evalA.ok = false; evalA.reasons.push("RK not approved (aggregator)."); }

    if (bindA?.found) {
      const isZeroOwnerA = String(bindA.owner).toLowerCase() === "0x0000000000000000000000000000000000000000";
      if (isZeroOwnerA) { evalA.ok = false; evalA.reasons.push("RK consumer owner not set for aggregator."); }
    }
    if (classA?.mode === "fn" && classA.enabled === false) {
      evalA.ok = false; evalA.reasons.push(`RK class ${argv.class} is DISABLED for aggregator.`);
    } else if (classA?.mode === "mask" && classA.enabled === false) {
      evalA.ok = false; evalA.reasons.push(`RK class ${argv.class} bit is not set in consumer mask for aggregator.`);
    }
  }

  // ---- SUMMARY ----
  console.log("\n---- SUMMARY ----");
  console.log(`RK approval for singleton: ${approvalViewS.known ? (approvalViewS.value ? "APPROVED" : "NOT approved") : "unknown"}`);
  console.log(`RK consumer owner (singleton): ${bindS.found ? String(bindS.owner) : "<unknown>"}`);
  if (classS.mode === "fn") {
    console.log(`RK class ${argv.class} enabled for singleton?: ${classS.enabled ? "YES" : "NO"} (via isClassEnabled*)`);
  } else if (classS.mode === "mask") {
    console.log(`RK class ${argv.class} enabled for singleton?: ${(classS.enabled===true) ? "YES" : (classS.enabled===false ? "NO" : "unknown")} (mask ${toHex(classS.mask)})`);
  } else {
    console.log(`RK class ${argv.class} enabled for singleton?: <unknown>`);
  }

  if (aggAddr) {
    const approvalViewA2 = await probeKeeperApprovalView(provider, keeperAddr, aggAddr);
    console.log(`RK approval for aggregator: ${approvalViewA2.known ? (approvalViewA2.value ? "APPROVED" : "NOT approved") : "unknown"}`);
    console.log(`RK consumer owner (aggregator): ${bindA?.found ? String(bindA.owner) : "<unknown>"}`);
    if (classA?.mode === "fn") {
      console.log(`RK class ${argv.class} enabled for aggregator?: ${classA.enabled ? "YES" : "NO"} (via isClassEnabled*)`);
    } else if (classA?.mode === "mask") {
      console.log(`RK class ${argv.class} enabled for aggregator?: ${(classA.enabled===true) ? "YES" : (classA.enabled===false ? "NO" : "unknown")} (mask ${toHex(classA.mask)})`);
    } else {
      console.log(`RK class ${argv.class} enabled for aggregator?: <unknown>`);
    }
  }

  console.log(`Singleton candidates: ${enrichedS.length}`);
  if (aggAddr) console.log(`Aggregator candidates: ${enrichedA.length}`);

  if (aggAddr) {
    const setS = new Set(enrichedS.map(tupleKey));
    const setA = new Set(enrichedA.map(tupleKey));
    const inter = [...setS].filter(k => setA.has(k));
    console.log(`Selection overlap (operator+jobId): ${inter.length}`);
  }

  // Friendly explanations about expected probe reverts
  console.log("\nNOTES:");
  console.log("- If you see `transferAndCall ... transfer amount exceeds balance` in a probe:");
  console.log("  This is expected in the *isolated* probe because the singleton isn't funded.");
  console.log("  In the real flow, the contract first pulls LINK via transferFrom(owner→singleton), then calls transferAndCall.");
  console.log("- If you see `Must use whitelisted functions` for an entrypoint:");
  console.log("  It usually means the selector didn't match the Operator/Oracle flavor. This doctor now tries BOTH.");
  console.log("- If ONLY `oracleRequest(8)` passes:");
  console.log("  Your consumer should use ChainlinkClient's Oracle path (sendChainlinkRequestTo).");
  console.log("- If ONLY `operatorRequest(6)` passes:");
  console.log("  Your consumer should use the Operator path (sendOperatorRequestTo).");
  console.log("- NEW: If `RK class <X> enabled?: NO` or `RK consumer owner: 0x000…000`,");
  console.log("  the consumer is likely not fully registered/configured on the Keeper for that class.");

  const overallPass =
    evalS.ok &&
    (!aggAddr || evalA.ok);

  console.log("\nRESULTS:");
  console.log(`Singleton path: ${evalS.ok ? "PASS ✅" : "FAIL ❌"}`);
  if (!evalS.ok) console.log("  Reasons:", evalS.reasons);
  if (aggAddr) {
    console.log(`Aggregator path: ${evalA.ok ? "PASS ✅" : "FAIL ❌"}`);
    if (!evalA.ok) console.log("  Reasons:", evalA.reasons);
  }
  console.log(`OVERALL: ${overallPass ? "PASS ✅" : "FAIL ❌"}`);

  console.log("\nDiagnostics complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

