# gets size in hex chars. Divide by 2 to get bytes.
# Note: 24KB is the limit
cat artifacts/contracts/ReputationAggregator.sol/ReputationAggregator.json | jq '.deployedBytecode' | wc -c
cat artifacts/contracts/ReputationKeeper.sol/ReputationKeeper.json | jq '.deployedBytecode' | wc -c
