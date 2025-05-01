// deploy/01_simple_contract.js
// Deploys SimpleContract with the same arguments used in Truffle

module.exports = async ({ getNamedAccounts, deployments }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // --- constructor params (copy-pasted from Truffle migration) ---
  const oracleAddress   = "0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101";
  const jobId           = "0x38f19572c51041baa5f2dea284614590"; // already 32-byte hex
  const fee             = ethers.utils.parseEther("0.05");      // 0.05 LINK
  const linkToken       = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  const requiredClass   = 128;

  await deploy("SimpleContract", {
    from: deployer,
    args: [oracleAddress, jobId, fee, linkToken, requiredClass],
    log: true,
  });
};

