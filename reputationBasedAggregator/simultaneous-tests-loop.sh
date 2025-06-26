for i in {1..10}; do echo "=== Test Run $i at $(date) ==="; ./simultaneous-tests.sh; echo ""; sleep 60; done > test_results.log 2>&1
