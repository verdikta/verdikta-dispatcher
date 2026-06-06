// deploy/01_demo_client.js
module.exports = async ({ deployments, getNamedAccounts }) => {
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  const AGGREGATOR = "0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02"; // <-- set to ETH aggregator

  // ETH-funded DemoClient: single constructor arg (no LINK token). Native ETH rides with
  // each request as msg.value, so there is no LINK to wire or approve.
  await deploy("DemoClient", {
    from: deployer,
    args: [AGGREGATOR],                  // one constructor param (aggregator only)
    log: true,
    deterministicDeployment: false,   
    proxy: false,
    skipIfAlreadyDeployed: false      // force fresh deploy
  });
};

