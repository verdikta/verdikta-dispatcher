HARDHAT_NETWORK=base_sepolia \
node scripts/agg-history.js \
  --aggregator 0x6a26f45D5BbFC3AEEd8De9bd2B8285b96554bC47 \
  --aggid      ${1:-0x99c0235f1c034cd47c382d73acad2931fb7f54e46e879252b346a895c59aa85a}
