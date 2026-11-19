// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title ScoringLib (example implementation of TODO item 14)
 * @notice Pure helpers for finalization, deployed once and reached by DELEGATECALL so their bytecode
 *         does not count against the aggregator's 24 KB limit.
 *
 *  - bestCluster: TODO item 10's nearest-neighbour cluster, replacing v1's greedy one (closest pair,
 *    then the response with the smallest summed distance). Greedy let colluders with identical
 *    reports seed the cluster wherever they liked and pull its mean: at Jumbo (P = 17 of 27) 4
 *    colluders moved it about 6 points, against about 1 now. For P = 2 both give the closest pair.
 *    The inner loops read memory directly, without bounds checks or checked arithmetic.
 *
 *  - Inputs: every value is at most 1e34 (the aggregator caps reveals at MAX_SCORE), at most 255
 *    vectors of at most 20 values, so no sum below can overflow. The hand-written loops rely on this
 *    and on equal lengths (checked). test/aggregator.flow.test.js compares every function here with a
 *    JavaScript reference on random inputs, ties included, and with v1's AggregatorLib where v1 is
 *    meant to agree (normalization, and the cluster at P = 2).
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
    error LengthMismatch();
    error TooMany();

    /**
     * @notice The cluster of P counted reveals (TODO item 10, nearest-neighbour rule). For each reveal
     *         c, its group is c and its P - 1 nearest reveals (squared Euclidean distance, ties to the
     *         earlier reveal). The cluster is the group with the smallest sum of pairwise distances,
     *         the first centre on ties. P below 2 is taken as 2, where this is v1's closest pair.
     * @dev O(n^2) distances once, then per centre a scan of its row keeping the P nearest sorted
     *      (O(n P)), and the group's P(P-1)/2 pairwise sum, abandoned once it reaches the best so far.
     */
    function bestCluster(uint256[][] memory v, uint256 P) public pure returns (bool[] memory inCluster) {
        uint256 n = v.length;
        if (n < 2) revert NeedTwo();
        if (n > 256) revert TooMany();                // indexes are packed into 8 bits below
        if (P > n) P = n;
        if (P < 2) P = 2;
        uint256 len = _sameLength(v);
        uint256[] memory d = new uint256[](n * n);
        unchecked {
            for (uint256 i = 0; i + 1 < n; i++) {
                uint256[] memory a = v[i];
                for (uint256 j = i + 1; j < n; j++) {
                    uint256[] memory b = v[j];
                    assembly ("memory-safe") {
                        // squared Euclidean distance, as AggregatorLib.calculateDistance
                        let x := 0
                        let pa := add(a, 32)
                        let pb := add(b, 32)
                        for { let k := 0 } lt(k, len) { k := add(k, 1) } {
                            let ak := mload(add(pa, shl(5, k)))
                            let bk := mload(add(pb, shl(5, k)))
                            let t := sub(ak, bk)
                            if lt(ak, bk) { t := sub(bk, ak) }
                            x := add(x, mul(t, t))
                        }
                        let pd := add(d, 32)
                        mstore(add(pd, shl(5, add(mul(i, n), j))), x)
                        mstore(add(pd, shl(5, add(mul(j, n), i))), x)
                    }
                }
            }
        }
        // per centre, the P nearest as sortable keys (distance << 8 | index: distances are below 2^231,
        // and the index breaks ties toward the earlier reveal), kept sorted while scanning the row
        uint256[] memory near = new uint256[](P);
        uint256[] memory group = new uint256[](P);
        assembly ("memory-safe") {
            let pd := add(d, 32)
            let pn := add(near, 32)
            let pg := add(group, 32)
            let last := add(pn, shl(5, sub(P, 1)))
            let bestScore := not(0)
            for { let c := 0 } lt(c, n) { c := add(c, 1) } {
                let row := add(pd, shl(5, mul(c, n)))
                let m := 0
                for { let j := 0 } lt(j, n) { j := add(j, 1) } {
                    let key := or(shl(8, mload(add(row, shl(5, j)))), j)
                    let k := m
                    switch eq(m, P)
                    case 1 {
                        if iszero(lt(key, mload(last))) { continue }
                        k := sub(P, 1)                                  // drops the current farthest
                    }
                    default { m := add(m, 1) }
                    for {} gt(k, 0) {} {
                        let prev := mload(add(pn, shl(5, sub(k, 1))))
                        if lt(prev, key) { break }
                        mstore(add(pn, shl(5, k)), prev)
                        k := sub(k, 1)
                    }
                    mstore(add(pn, shl(5, k)), key)
                }
                // the group's pairwise sum, abandoned once it is not better than the best so far
                let score := 0
                for { let x := 0 } and(lt(x, P), lt(score, bestScore)) { x := add(x, 1) } {
                    let rx := add(pd, shl(5, mul(and(mload(add(pn, shl(5, x))), 0xff), n)))
                    for { let y := add(x, 1) } lt(y, P) { y := add(y, 1) } {
                        score := add(score, mload(add(rx, shl(5, and(mload(add(pn, shl(5, y))), 0xff)))))
                    }
                }
                if lt(score, bestScore) {
                    bestScore := score
                    for { let x := 0 } lt(x, P) { x := add(x, 1) } { mstore(add(pg, shl(5, x)), and(mload(add(pn, shl(5, x))), 0xff)) }
                }
            }
        }
        inCluster = new bool[](n);
        for (uint256 x = 0; x < P; x++) inCluster[group[x]] = true;
    }

    /// @dev the common length of the vectors (they must all have it)
    function _sameLength(uint256[][] memory v) private pure returns (uint256 len) {
        len = v[0].length;
        for (uint256 i = 1; i < v.length; i++) if (v[i].length != len) revert LengthMismatch();
    }

    /**
     * @dev AggregatorLib.normalizeToModal: resize every vector to the most common length (ties to the
     *      smaller), truncating or zero-filling. Returns `v` itself when the lengths already agree.
     */
    function _normalize(uint256[][] memory v) private pure returns (uint256[][] memory out) {
        uint256 n = v.length;
        if (n == 0) return v;
        uint256 len0 = v[0].length;
        bool same = true;
        for (uint256 i = 1; i < n; i++) {
            if (v[i].length != len0) {
                same = false;
                break;
            }
        }
        if (same) return v;
        uint256 modalLen;
        uint256 bestCount;
        for (uint256 i = 0; i < n; i++) {
            uint256 li = v[i].length;
            uint256 c;
            for (uint256 j = 0; j < n; j++) if (v[j].length == li) c++;
            if (c > bestCount || (c == bestCount && li < modalLen)) {
                bestCount = c;
                modalLen = li;
            }
        }
        out = new uint256[][](n);
        for (uint256 i = 0; i < n; i++) {
            uint256[] memory src = v[i];
            uint256[] memory dst = new uint256[](modalLen);
            uint256 m = src.length < modalLen ? src.length : modalLen;
            for (uint256 j = 0; j < m; j++) dst[j] = src[j];
            out[i] = dst;
        }
    }

    /**
     * @notice Everything finalization computes from the counted reveals, in one call to keep the
     *         aggregator small: the vectors resized to their most common length (as v1's
     *         normalizeToModal), the cluster (P closest; a single reveal is its own cluster), the
     *         cluster's coordinate-wise mean, and the quality classes.
     */
    function aggregate(uint256[][] memory v, uint256 P, uint256 floor_)
        public
        pure
        returns (bool[] memory inCl, uint256[] memory agg, uint8[] memory codes, uint256[] memory med, uint256 spread)
    {
        v = _normalize(v);
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
        unchecked {
            for (uint256 i = 0; i < n; i++) {
                if (!inCl[i]) continue;
                cnt++;
                uint256[] memory x = v[i];
                for (uint256 j = 0; j < len; j++) agg[j] += x[j];
            }
            if (cnt > 0) for (uint256 j = 0; j < len; j++) agg[j] /= cnt;
        }
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
        uint256 len = _sameLength(v);
        med = new uint256[](len);
        uint256[] memory col = new uint256[](n);
        for (uint256 j = 0; j < len; j++) {
            assembly ("memory-safe") {
                // col[i] = v[i][j]
                let pv := add(v, 32)
                let pcol := add(col, 32)
                let off := add(32, shl(5, j))
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    mstore(add(pcol, shl(5, i)), mload(add(mload(add(pv, shl(5, i))), off)))
                }
            }
            med[j] = _median(col);
        }
        uint256[] memory dist = new uint256[](n);
        uint256[] memory tmp = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 x = _dev(v[i], med);
            dist[i] = x;
            tmp[i] = x;
        }
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
        assembly ("memory-safe") {
            let lx := mload(x)
            let lm := mload(med)
            for { let j := 0 } lt(j, lm) { j := add(j, 1) } {
                let xj := 0
                if lt(j, lx) { xj := mload(add(x, add(32, shl(5, j)))) }
                let mj := mload(add(med, add(32, shl(5, j))))
                let dj := sub(xj, mj)
                if lt(xj, mj) { dj := sub(mj, xj) }
                if gt(dj, m) { m := dj }
            }
        }
    }

    /// @dev median by insertion sort (sorts `a` in place, length >= 1); mean of the two middle values
    ///      when even
    function _median(uint256[] memory a) private pure returns (uint256 m) {
        assembly ("memory-safe") {
            let n := mload(a)
            let p := add(a, 32)
            for { let i := 1 } lt(i, n) { i := add(i, 1) } {
                let key := mload(add(p, shl(5, i)))
                let j := i
                for {} gt(j, 0) {} {
                    let prev := mload(add(p, shl(5, sub(j, 1))))
                    if iszero(gt(prev, key)) { break }
                    mstore(add(p, shl(5, j)), prev)
                    j := sub(j, 1)
                }
                mstore(add(p, shl(5, j)), key)
            }
            let h := shr(1, n)
            switch and(n, 1)
            case 1 { m := mload(add(p, shl(5, h))) }
            default { m := shr(1, add(mload(add(p, shl(5, sub(h, 1)))), mload(add(p, shl(5, h))))) }
        }
    }
}
