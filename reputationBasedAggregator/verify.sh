# Aggregator
# npx hardhat verify --network base_sepolia \
# 0xYourContractAddressHere \
# 0xChainlinkAddressHere \
# 0x0000000000000000000000000000000000000000

if false; then
echo "Running Aggregator verification..."
npx hardhat verify --network base_sepolia \
  0xC60f4532F104EDD422335a9103c8Ce7B2DF5Bc84 \
  0xE4aB69C077896252FAFBD49EFD26B5D171A32410 \
  0x0000000000000000000000000000000000000000
fi

# Reputation Keeper
# npx hardhat verify --network base_sepolia \
#  0xYourReputationKeeperAddress \
#  0xYourWrappedVerdiktaTokenAddress
if true; then
echo "Running ReputationKeeper verification..."
npx hardhat verify --network base_sepolia \
  0x4B2e6728addc52968a1dCcAc79a7b70b9A661ccB \
  0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1
fi
