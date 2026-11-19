// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title ScoringLib (example implementation of TODO item 14)
 * @notice Pure helpers for finalization, deployed once and reached by DELEGATECALL so their bytecode
 *         does not count against the aggregator's 24 KB limit.
 *
 *  - bestCluster: the same greedy cluster as AggregatorLib.findBestCluster (closest pair, then add
 *    the response with the smallest summed distance to the cluster, first in scan order on ties), but
 *    with the n x n distance matrix computed once and the summed distances updated incrementally:
 *    O(n^2 + P n) distance work instead of O(P n^2). At N = 27, P = 17 that is 351 distance
 *    evaluations instead of about 2,500, plus 27 x 27 inner-loop iterations instead of about 11,000.
 *
 *  - classify: TODO item 14's quality classes. Reveals are likelihood vectors, so the 1-D rule is
 *    generalised: distance d_i = max_j |x_ij - med_j| against the coordinate-wise median, and
 *    spread = max(1.4826 x median_i(d_i), floor). For a single coordinate this is exactly
 *    |score - median| and 1.4826 x MAD. close: d <= 1.5 spread, off: d <= 3 spread, far: beyond.
 */
library ScoringLib {
    uint8 internal constant Q_CLOSE = 1;
    uint8 internal constant Q_OFF = 2;
    uint8 internal constant Q_FAR = 3;

    error NeedTwo();

    function bestCluster(uint256[][] memory v, uint256 P) public pure returns (bool[] memory inCluster) {
        uint256 n = v.length;
        if (n < 2) revert NeedTwo();
        if (P > n) P = n;
        uint256[] memory d = new uint256[](n * n);
        uint256 bestA;
        uint256 bestB;
        uint256 bestDist = type(uint256).max;
        for (uint256 i = 0; i + 1 < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                uint256 x = _dist(v[i], v[j]);
                d[i * n + j] = x;
                d[j * n + i] = x;
                if (x < bestDist) {
                    bestDist = x;
                    bestA = i;
                    bestB = j;
                }
            }
        }
        inCluster = new bool[](n);
        inCluster[bestA] = true;
        inCluster[bestB] = true;
        uint256[] memory sum = new uint256[](n);
        for (uint256 i = 0; i < n; i++) sum[i] = d[i * n + bestA] + d[i * n + bestB];
        for (uint256 size = 2; size < P; size++) {
            uint256 cand;
            uint256 best = type(uint256).max;
            for (uint256 i = 0; i < n; i++) {
                if (!inCluster[i] && sum[i] < best) {
                    best = sum[i];
                    cand = i;
                }
            }
            inCluster[cand] = true;
            for (uint256 i = 0; i < n; i++) sum[i] += d[i * n + cand];
        }
    }

    /// @dev squared Euclidean distance, as AggregatorLib.calculateDistance (vectors are equal length)
    function _dist(uint256[] memory a, uint256[] memory b) private pure returns (uint256 s) {
        for (uint256 k = 0; k < a.length; k++) {
            uint256 x = a[k] > b[k] ? a[k] - b[k] : b[k] - a[k];
            s += x * x;
        }
    }

    /**
     * @notice Everything finalization computes from the counted reveals (already normalized to one
     *         length), in one call to keep the aggregator small: the cluster (P closest; a single reveal
     *         is its own cluster), the cluster's coordinate-wise mean, and the quality classes.
     */
    function aggregate(uint256[][] memory v, uint256 P, uint256 floor_)
        public
        pure
        returns (bool[] memory inCl, uint256[] memory agg, uint8[] memory codes, uint256[] memory med, uint256 spread)
    {
        uint256 n = v.length;
        if (n >= 2) {
            inCl = bestCluster(v, P);
        } else {
            inCl = new bool[](n);
            if (n == 1) inCl[0] = true;
        }
        uint256 len = n > 0 ? v[0].length : 0;
        agg = new uint256[](len);
        uint256 cnt;
        for (uint256 i = 0; i < n; i++) {
            if (!inCl[i]) continue;
            cnt++;
            for (uint256 j = 0; j < len; j++) agg[j] += v[i][j];
        }
        if (cnt > 0) for (uint256 j = 0; j < len; j++) agg[j] /= cnt;
        (codes, med, spread) = classify(v, floor_);
    }

    /**
     * @return codes quality class per vector (1 close, 2 off, 3 far)
     * @return med coordinate-wise median (stored so late reveals can be classified on arrival)
     * @return spread robust spread, floored
     */
    function classify(uint256[][] memory v, uint256 floor_)
        public
        pure
        returns (uint8[] memory codes, uint256[] memory med, uint256 spread)
    {
        uint256 n = v.length;
        uint256 len = v[0].length;
        med = new uint256[](len);
        uint256[] memory col = new uint256[](n);
        for (uint256 j = 0; j < len; j++) {
            for (uint256 i = 0; i < n; i++) col[i] = v[i][j];
            med[j] = _median(col);
        }
        uint256[] memory dist = new uint256[](n);
        for (uint256 i = 0; i < n; i++) dist[i] = _dev(v[i], med);
        uint256[] memory tmp = new uint256[](n);
        for (uint256 i = 0; i < n; i++) tmp[i] = dist[i];
        spread = _median(tmp) * 14826 / 10000;
        if (spread < floor_) spread = floor_;
        codes = new uint8[](n);
        for (uint256 i = 0; i < n; i++) codes[i] = _class(dist[i], spread);
    }

    /**
     * @notice Promotion draw (item 14's M+ / T+ rule): M slots chosen uniformly at random from all
     *         committed slots (partial Fisher-Yates driven by `seed`). The caller guarantees at least M
     *         commits.
     */
    function pickPromoted(bool[] memory committed, uint256 m, bytes32 seed) public pure returns (uint256[] memory chosen) {
        uint256 k = committed.length;
        uint256[] memory pool = new uint256[](k);
        uint256 n;
        for (uint256 i = 0; i < k; i++) if (committed[i]) pool[n++] = i;
        chosen = new uint256[](m);
        for (uint256 j = 0; j < m; j++) {
            uint256 pick = j + uint256(keccak256(abi.encodePacked(seed, j))) % (n - j);
            (pool[j], pool[pick]) = (pool[pick], pool[j]);
            chosen[j] = pool[j];
        }
    }

    function classifyOne(uint256[] memory x, uint256[] memory med, uint256 spread) public pure returns (uint8) {
        return _class(_dev(x, med), spread);
    }

    function _class(uint256 dist, uint256 spread) private pure returns (uint8) {
        if (dist * 2 <= spread * 3) return Q_CLOSE;   // d <= 1.5 spread
        if (dist <= spread * 3) return Q_OFF;          // d <= 3 spread
        return Q_FAR;
    }

    /// @dev max-coordinate deviation from the median; a missing coordinate counts as 0
    function _dev(uint256[] memory x, uint256[] memory med) private pure returns (uint256 m) {
        for (uint256 j = 0; j < med.length; j++) {
            uint256 xj = j < x.length ? x[j] : 0;
            uint256 dj = xj > med[j] ? xj - med[j] : med[j] - xj;
            if (dj > m) m = dj;
        }
    }

    /// @dev median by insertion sort (sorts `a` in place); mean of the two middle values when even
    function _median(uint256[] memory a) private pure returns (uint256) {
        uint256 n = a.length;
        for (uint256 i = 1; i < n; i++) {
            uint256 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = key;
        }
        return n % 2 == 1 ? a[n / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    }
}
