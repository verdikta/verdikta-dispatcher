module.exports = async (hre) => {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  /* ------------------------------------------------------------------ */
  /* CONFIG                                                             */
  // Set this to the address of your deployed operator contract:
  const oracleAddress = "0x0e9C48924c5918ab7aED7B9EFBfcd6d6A9d21D0b";

  // ---- raw 16-byte job-ID (32 hex chars, no hyphens) -----------------
  // Set this to the job ID you recieved when configuring the Chainlink job:
  const rawJobId = "c6a5a82aa4814f8296c30fa44aff715e";

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

