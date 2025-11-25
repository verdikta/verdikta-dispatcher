for i in {1..5}; do echo "=== Test Run $i at $(date) ==="; ./simultaneous-tests.sh; echo ""; sleep 30; done > test_results.log 2>&1
