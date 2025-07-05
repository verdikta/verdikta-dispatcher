// deploy/01_demo_client.js
module.exports = async ({ deployments, getNamedAccounts }) => {
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  const AGGREGATOR = "0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02"; // Base Sepolia
  const LINK_TOKEN = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"; // LINK on Base

  await deploy("DemoClient", {
    from: deployer,
    args: [AGGREGATOR, LINK_TOKEN],      // two constructor params
    log: true,
    deterministicDeployment: false,   
    proxy: false,
    skipIfAlreadyDeployed: false      // force fresh deploy
  });
};

