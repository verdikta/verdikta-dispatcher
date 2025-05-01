module.exports = async (hre) => {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const oracleAddress = "0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101";

  // ----- bytes32 job ID -----
  const rawJobId = "0x38f19572c51041baa5f2dea284614590";
  const jobId    = ethers.zeroPadValue(rawJobId, 32);   // ← pads to 0x…00 length 66

  const fee           = ethers.parseEther("0.05");
  const linkToken     = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  const requiredClass = 128;

  await deploy("SimpleContract", {
    from: deployer,
    args: [oracleAddress, jobId, fee, linkToken, requiredClass],
    log: true,
  });
};

