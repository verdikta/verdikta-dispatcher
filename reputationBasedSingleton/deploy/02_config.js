// deploy/02_config.js
require("dotenv").config();

module.exports = async (hre) => {
  const { ethers, getNamedAccounts, deployments } = hre;
  const { deployer } = await getNamedAccounts();
  const signer = await ethers.getSigner(deployer);

  // 0) Helper: robust RK approval view (does not rely on artifact ABI)
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
        const ret   = await signer.provider.call({ to: keeperAddr, data });
        if (ret && ret !== "0x") {
          const [val] = iface.decodeFunctionResult(fnName, ret);
          return { known: true, value: !!val, fn: fnName };
        }
      } catch { /* try next */ }
    }
    return { known: false, value: null, fn: null };
  }

  // 1) Grab the singleton address from hardhat-deploy
  const singletonDeployment = await deployments.get("ReputationSingleton");
  const singletonAddress = singletonDeployment.address;
  console.log("→ singletonAddress:", singletonAddress);

  // 2) Read keeper address from your JSON
  const allAddrs = require("../deployment-addresses.json");
  const keeperAddr = allAddrs.base_sepolia?.keeper;
  console.log("→ keeperAddr:", keeperAddr);
  if (!ethers.isAddress(keeperAddr)) {
    throw new Error("Invalid or missing keeper in deployment-addresses.json");
  }

  // 3) Connect to the on-chain keeper via your interface stub
  const keeperContract = await ethers.getContractAt("IReputationKeeper", keeperAddr, signer);

  // 3a) Optional: ensure we are the RK owner if owner() exists
  try {
    const owner = await keeperContract.owner();
    if (owner && owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(
        `Signer ${signer.address} is not the keeper owner ${owner}. ` +
        `Run this step with the keeper owner.`
      );
    }
  } catch (_) {
    console.log("keeper.owner() not available (ok).");
  }

  // 4) Ensure RK approval is actually in place (view + optional approve)
  console.log("Checking RK approval (robust view) …");
  let approvalView = await probeKeeperApprovalView(signer.provider, keeperAddr, singletonAddress);
  if (approvalView.known) {
    console.log(`  ${approvalView.fn}(${singletonAddress}) →`, approvalView.value ? "APPROVED" : "NOT approved");
  } else {
    console.log("  RK view function not found (isContractApproved/approved*). Will rely on post-tx verification.");
  }

  if (!approvalView.known || !approvalView.value) {
    // Call approveContract ONLY if not already approved or unknown
    console.log(`Approving singleton ${singletonAddress} on keeper ${keeperAddr}…`);
    // Minimal ABI, works even if your artifact doesn’t expose approveContract
    const approveIface = new ethers.Interface(["function approveContract(address)"]);
    const tx = await signer.sendTransaction({
      to: keeperAddr,
      data: approveIface.encodeFunctionData("approveContract", [singletonAddress])
    });
    await tx.wait();
    console.log("ReputationSingleton approved (tx mined)");

    // Re‑check approval
    approvalView = await probeKeeperApprovalView(signer.provider, keeperAddr, singletonAddress);
    if (!approvalView.known || !approvalView.value) {
      throw new Error(
        "approveContract() mined but RK view still NOT approved (or unknown). " +
        "Double‑check you ran with the RK owner and the RK matches this network."
      );
    }
    console.log("RK approval verified:", approvalView.value ? "APPROVED" : "NOT approved");
  }

  // 5) Verify selectOracles as the singleton (raw eth_call with from=singleton)
  const count  = 1n;
  const alpha  = 0n;
  const maxFee = ethers.parseUnits("1", 18); // 1 LINK cap
  const base   = 0n;
  const scale  = 1n;
  const klass  = 128n;

  console.log("Probing keeper.selectOracles via raw eth_call as the singleton…");
  const calldata = keeperContract.interface.encodeFunctionData(
    "selectOracles",
    [count, alpha, maxFee, base, scale, klass]
  );

  let ret;
  try {
    ret = await signer.provider.call({
      to: keeperAddr,
      data: calldata,
      from: singletonAddress,
    });
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    throw new Error(
      `Keeper probe failed (eth_call selectOracles as singleton). Revert: ${msg}\n` +
      `Ensure the singleton is approved in RK and your class/fee params are valid.`
    );
  }

  // Decode and report candidates
  const decoded = keeperContract.interface.decodeFunctionResult("selectOracles", ret);
  const candidates = Array.isArray(decoded[0]) ? decoded[0] : decoded;
  const n = candidates.length ?? 0;
  console.log(`Keeper accepts selection from singleton. Selected: ${n}`);
  if (n === 0) {
    throw new Error("selectOracles returned 0 candidates with these params; nothing to record.");
  }

  const first = candidates[0];
  const oracleAddr = first.oracle ?? first.operator ?? first[0];
  const jobId      = first.jobId  ?? first[1];
  console.log("First candidate tuple:", { oracle: oracleAddr, jobId });

  // 6) **Critical**: Probe recordUsedOracles as the singleton using the keeper’s OWN ABI
  //     (We pass the decoded array verbatim so struct shape matches exactly.)
  try {
    const dataRUO = keeperContract.interface.encodeFunctionData(
      "recordUsedOracles",
      [candidates] // pass entire array from selectOracles
    );
    await signer.provider.call({
      to: keeperAddr,
      data: dataRUO,
      from: singletonAddress,
    });
    console.log("recordUsedOracles (as singleton): WOULD SUCCEED");
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    throw new Error(
      `recordUsedOracles (as singleton) WOULD REVERT in this environment.\n` +
      `Revert: ${msg}\n\n` +
      `This indicates RK gating or invariant beyond 'approved'. Because we passed the EXACT tuples\n` +
      `that selectOracles returned, the failure is not a struct-shape artifact.\n` +
      `Action: inspect ReputationKeeper.recordUsedOracles() conditions (e.g., class/mode flags, entropy,\n` +
      `caller role, or per-contract configuration) and ensure the singleton satisfies them.`
    );
  }

  // 7) (Optional) Cross-check operator LINK token matches singleton’s LINK (if exposed)
  try {
    const OP_ABI = ["function getChainlinkToken() view returns (address)"];
    const op     = await ethers.getContractAt(OP_ABI, oracleAddr, signer);
    const opLink = await op.getChainlinkToken();
    console.log("Operator LINK:", opLink);
    // Pull singleton LINK address via the singleton’s getContractConfig
    const cfg = await (await ethers.getContractAt("ReputationSingleton", singletonAddress, signer)).getContractConfig();
    const singletonLink = cfg.linkAddr || cfg[1];
    console.log("Singleton LINK:", singletonLink);
    if (opLink.toLowerCase() !== singletonLink.toLowerCase()) {
      throw new Error(
        "Operator and Singleton LINK token addresses differ. Requests will revert on transferAndCall.\n" +
        `Operator LINK:  ${opLink}\nSingleton LINK: ${singletonLink}\n` +
        "Fix: point both to the same LINK token on this network."
      );
    }
  } catch (_) {
    // It’s fine if the operator doesn’t expose getChainlinkToken(); skip silently.
  }

  console.log("Config step complete.");
};

module.exports.tags = ["ConfigSingleton"];
module.exports.dependencies = ["ReputationSingleton"];

