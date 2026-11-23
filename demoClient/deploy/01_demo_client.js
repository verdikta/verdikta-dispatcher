// deploy/01_demo_client.js
module.exports = async ({ deployments, getNamedAccounts }) => {
  const { deploy }   = deployments;
  const { deployer } = await getNamedAccounts();

  // ETH-funded ReputationAggregator on Base Sepolia. On Base mainnet it is
  // 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a. Set this to the aggregator of your network.
  const AGGREGATOR = "0xe8a385E473EA710c5a88Cc72681a16a26fe380e4";

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

