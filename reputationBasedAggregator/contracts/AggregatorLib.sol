// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title AggregatorLib
 * @notice Pure, stateless helpers extracted from ReputationAggregator to keep
 *         the main contract under the 24 KB EIP-170 limit. These functions are
 *         `public`, so the library is deployed once and reached via DELEGATECALL;
 *         the bodies live in the library's bytecode, not the aggregator's.
 * @dev    Logic is byte-for-byte equivalent to the inlined originals. The only
 *         change is that clustering takes the likelihood vectors directly
 *         (`uint256[][]`) instead of the aggregator's `Response[]`, so the
 *         library has no dependency on the contract's storage types.
 */
library AggregatorLib {
    error ArrayLengthMismatch();
    error NeedMoreResponses();

    // ----------------------------------------------------------------------
    //                              CLUSTERING
    // ----------------------------------------------------------------------

    /**
     * @dev Find the best cluster among the selected responses.
     * @param likelihoodsByResp Per-response likelihood vectors, indexed the same
     *        way as the aggregator's `responses` array.
     * @param selectedResponseIndices Indices (into `likelihoodsByResp`) of the
     *        responses eligible for clustering.
     * @param P Desired cluster size.
     * @return flags Array of length `selectedResponseIndices.length` with exactly
     *         `min(P, count)` ones marking the chosen cluster members.
     */
    function findBestCluster(
        uint256[][] memory likelihoodsByResp,
        uint256[] memory selectedResponseIndices,
        uint256 P
    ) public pure returns (uint256[] memory) {
        uint256 count = selectedResponseIndices.length;
        if (count < 2) revert NeedMoreResponses();

        // Cap P to available responses
        if (P > count) P = count;

        // ---- step 1: find the closest pair ----
        uint256 bestA;
        uint256 bestB;
        uint256 bestDist = type(uint256).max;
        for (uint256 i = 0; i < count - 1; ++i) {
            for (uint256 j = i + 1; j < count; ++j) {
                uint256 d = calculateDistance(
                    likelihoodsByResp[selectedResponseIndices[i]],
                    likelihoodsByResp[selectedResponseIndices[j]]
                );
                if (d < bestDist) {
                    bestDist = d;
                    bestA = i;
                    bestB = j;
                }
            }
        }

        // flags: 1 = in cluster, 0 = out
        uint256[] memory flags = new uint256[](count);
        flags[bestA] = 1;
        flags[bestB] = 1;
        uint256 clusterSizeNow = 2;

        // ---- step 2: greedy add until clusterSizeNow == P ----
        while (clusterSizeNow < P) {
            uint256 bestCand;
            uint256 bestScore = type(uint256).max;

            for (uint256 i = 0; i < count; ++i) {
                if (flags[i] == 1) continue; // already in cluster

                // score = sum distance to current cluster members
                uint256 score = 0;
                for (uint256 k = 0; k < count; ++k) {
                    if (flags[k] == 1) {
                        score += calculateDistance(
                            likelihoodsByResp[selectedResponseIndices[i]],
                            likelihoodsByResp[selectedResponseIndices[k]]
                        );
                    }
                }
                if (score < bestScore) {
                    bestScore = score;
                    bestCand  = i;
                }
            }

            flags[bestCand] = 1;
            ++clusterSizeNow;
        }

        return flags; // length == count, with exactly P ones
    }

    /**
     * @dev Calculate the squared Euclidean distance between two arrays.
     */
    function calculateDistance(uint256[] memory a, uint256[] memory b)
        internal pure returns (uint256)
    {
        if (a.length != b.length) revert ArrayLengthMismatch();
        uint256 sum = 0;
        for (uint256 i = 0; i < a.length; i++) {
            uint256 diff = (a[i] > b[i]) ? a[i] - b[i] : b[i] - a[i];
            sum += diff * diff;
        }
        return sum;
    }

    // ----------------------------------------------------------------------
    //                       MODAL-LENGTH NORMALIZATION
    // ----------------------------------------------------------------------

    /**
     * @dev Reveal-length normalization for the aggregator's finalize step. Reveals are accepted
     *      at ANY valid length; here we pick the MODAL (plurality) length among the response
     *      vectors and coerce every vector to it - truncating the overlong tail, zero-filling the
     *      short ones. Handing the clusterer a uniform width means calculateDistance can never hit
     *      a length mismatch, and an off-length (deviant) reveal is rejected by DISTANCE like any
     *      other outlier instead of the first reveal dictating the canonical length (which let a
     *      single deviant first-reveal exclude the honest majority and brick the round).
     *
     *      Mode is the plurality by pairwise count (O(n^2); n is the small reveal fan-out, so no
     *      sort is needed). Ties break toward the SMALLER length so the result is deterministic.
     * @param vectors Per-response likelihood vectors (same indexing as the aggregator's responses).
     * @return normalized The vectors, each resized to `modalLen` (input indexing preserved).
     * @return modalLen The chosen canonical width (0 iff `vectors` is empty).
     */
    function normalizeToModal(uint256[][] memory vectors)
        public pure
        returns (uint256[][] memory normalized, uint256 modalLen)
    {
        uint256 n = vectors.length;

        // modal length: for each vector's length, count how many vectors share it. A strictly
        // greater count wins; an equal count prefers the smaller length (deterministic tie-break).
        uint256 bestCount = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 li = vectors[i].length;
            uint256 c = 0;
            for (uint256 j = 0; j < n; j++) {
                if (vectors[j].length == li) c++;
            }
            if (c > bestCount || (c == bestCount && li < modalLen)) {
                bestCount = c;
                modalLen = li;
            }
        }

        // coerce each vector to modalLen (truncate if longer, zero-fill if shorter).
        normalized = new uint256[][](n);
        for (uint256 i = 0; i < n; i++) {
            uint256[] memory src = vectors[i];
            uint256[] memory dst = new uint256[](modalLen);
            uint256 copyLen = src.length < modalLen ? src.length : modalLen;
            for (uint256 j = 0; j < copyLen; j++) {
                dst[j] = src[j];
            }
            normalized[i] = dst;
        }
    }

    // ----------------------------------------------------------------------
    //                              CID : SALT
    // ----------------------------------------------------------------------

    /// @dev Split a reveal's "cid:32hex" (a 128-bit salt, items 4 and 5) in one pass: (false, "", 0) if
    ///      malformed. The salt is the 32 chars after the last ':', so the input must end in ':' and 32 hex
    ///      digits (either case), with a CID of at least 1 char before them. The CID is returned by
    ///      shortening `packed` in place (no copy): fine for this public function, whose argument is the
    ///      caller's ABI-encoded copy, but an internal caller would see its string cut.
    function parseCidSalt(string memory packed)
        public pure
        returns (bool ok, string memory cidOnly, uint256 salt)
    {
        bytes memory b = bytes(packed);
        uint256 n = b.length;
        if (n < 34 || b[n - 33] != ":") return (false, "", 0);
        assembly ("memory-safe") {
            let p := add(add(b, 32), sub(n, 32))     // the first salt char
            ok := 1
            for { let j := 0 } lt(j, 32) { j := add(j, 1) } {
                let c := byte(0, mload(add(p, j)))
                let d := sub(c, 48)                     // '0'..'9' (wraps below '0')
                if gt(d, 9) {
                    d := sub(or(c, 0x20), 97)           // 'a'..'f' / 'A'..'F' (wraps below 'a')
                    if gt(d, 5) { ok := 0 break }
                    d := add(d, 10)
                }
                salt := or(shl(4, salt), d)
            }
            if ok {
                let c := sub(n, 33)
                mstore(b, c)                            // the CID: everything before the ':'
                mstore(add(add(b, 32), c), 0)           // clean padding (the ':' and salt, inside b)
            }
        }
        if (!ok) return (false, "", 0);
        cidOnly = string(b);
    }

    // ----------------------------------------------------------------------
    //                          REQUEST PAYLOAD
    // ----------------------------------------------------------------------

    error BadInput();

    /// @notice The commit-request payload "1:<cid>,<cid>...[:<addendum>]". Reverts with BadInput for no
    ///         CIDs, more than `maxCount`, a CID longer than `maxLen` or an addendum longer than `maxAdd`.
    function buildCommitPayload(string[] memory cids, string memory addendum, uint256 maxCount, uint256 maxLen, uint256 maxAdd)
        public
        pure
        returns (string memory)
    {
        if (cids.length == 0 || cids.length > maxCount || bytes(addendum).length > maxAdd) revert BadInput();
        bytes memory cat = "1:";
        for (uint256 i = 0; i < cids.length; i++) {
            if (bytes(cids[i]).length > maxLen) revert BadInput();
            cat = abi.encodePacked(cat, cids[i], i + 1 < cids.length ? "," : "");
        }
        if (bytes(addendum).length > 0) cat = abi.encodePacked(cat, ":", addendum);
        return string(cat);
    }

    // ----------------------------------------------------------------------
    //                          HEX CONVERSIONS
    // ----------------------------------------------------------------------

    /// @dev 64 lowercase hex chars, no prefix (the reveal request's "2:<commit hash>")
    function bytes32ToHexLower(bytes32 data) public pure returns (string memory) {
        bytes memory s = new bytes(64);
        _hex64(data, s, 0);
        return string(s);
    }

    /// @dev "0x" + 64 lowercase hex chars (the request's aggId)
    function bytes32ToHex(bytes32 x) public pure returns (string memory) {
        bytes memory s = new bytes(66);
        s[0] = "0";
        s[1] = "x";
        _hex64(x, s, 2);
        return string(s);
    }

    /// @dev writes x as 64 lowercase hex chars into s from byte `at` (s must hold at + 64 bytes)
    function _hex64(bytes32 x, bytes memory s, uint256 at) private pure {
        assembly ("memory-safe") {
            mstore(0x0f, 0x30313233343536373839616263646566)   // "0123456789abcdef" ends at 0x2e:
            let o := add(add(s, 32), at)                       // mload(k) ends in char k
            for { let i := 0 } lt(i, 32) { i := add(i, 1) } {
                let v := byte(i, x)
                mstore8(add(o, shl(1, i)), mload(shr(4, v)))
                mstore8(add(o, add(shl(1, i), 1)), mload(and(v, 15)))
            }
        }
    }
}
