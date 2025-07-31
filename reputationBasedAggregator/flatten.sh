npx hardhat flatten contracts/ReputationAggregator.sol > flat.sol
# the following results should match:
grep -o '{' flat.sol | wc -l
grep -o '}' flat.sol | wc -l
# grep -n '^[[:space:]]*}' flat.sol
# tail -n 20 flat.sol


