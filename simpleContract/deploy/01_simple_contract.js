module.exports = async (hre) => {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  /* ------------------------------------------------------------------ */
  /* CONFIG                                                             */
  // Set this to the address of your deployed operator contract:
  const oracleAddress = "0xb8b2302759e1FB7144d35f6F41057f11dbFAdDbD";

  // ---- raw 16-byte job-ID (32 hex chars, no hyphens) -----------------
  // Set this to the job ID you recieved when configuring the Chainlink job:
  const rawJobId = "6c751f1a36f348dc8655c11e0f804b31";

  // ---- pad it on the *right* to 32 bytes -----------------------------
  function rightPadToBytes32(id16) {
    const h = id16.startsWith("0x") ? id16.slice(2) : id16;
    if (h.length !== 32) throw Error("rawJobId must be 16 bytes / 32 hex chars");
    return "0x" + h.padEnd(64, "0");      // 32 bytes total
  }
  const jobId = rightPadToBytes32(rawJobId);

  const fee           = ethers.parseEther("0.01");  // 0.01 LINK
  const linkToken     = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  const requiredClass = 128;
  /* ------------------------------------------------------------------ */

  await deploy("SimpleContract", {
    from: deployer,
    args: [oracleAddress, jobId, fee, linkToken, requiredClass],
    log: true,
  });
};

