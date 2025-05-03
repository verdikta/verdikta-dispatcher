module.exports = async (hre) => {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  /* ------------------------------------------------------------------ */
  /* CONFIG                                                             */
  const oracleAddress = "0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101";

  // ---- raw 16-byte job-ID (32 hex chars, no hyphens) -----------------
  const rawJobId = "0x38f19572c51041baa5f2dea284614590";

  // ---- pad it on the *right* to 32 bytes -----------------------------
  function rightPadToBytes32(id16) {
    const h = id16.startsWith("0x") ? id16.slice(2) : id16;
    if (h.length !== 32) throw Error("rawJobId must be 16 bytes / 32 hex chars");
    return "0x" + h.padEnd(64, "0");      // 32 bytes total
  }
  const jobId = rightPadToBytes32(rawJobId);

  const fee           = ethers.parseEther("0.05");  // 0.05 LINK
  const linkToken     = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  const requiredClass = 128;
  /* ------------------------------------------------------------------ */

  await deploy("SimpleContract", {
    from: deployer,
    args: [oracleAddress, jobId, fee, linkToken, requiredClass],
    log: true,
  });
};

