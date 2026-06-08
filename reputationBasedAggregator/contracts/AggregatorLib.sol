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
    //                              CID : SALT
    // ----------------------------------------------------------------------

    /// @dev Fast shape check for "cid:20hex" format.
    ///      Returns (ok, lastColonPos) where `lastColonPos` is the index
    ///      of ':' that separates cid and salt (undefined if !ok).
    function isValidCidSalt(string memory packed)
        public pure
        returns (bool, uint256)
    {
        bytes memory b = bytes(packed);

        // at least 1 char + ':' + 20 chars
        if (b.length <= 21) return (false, 0);

        // find the last ':'
        uint256 i = b.length;
        while (i > 0 && b[i-1] != ":") { unchecked { --i; } }
        if (i == 0 || (b.length - i) != 20) return (false, 0);

        // check all 20 chars are hex. Each branch bounds BOTH ends of its ASCII range:
        // the digit branch's upper bound matters because c-48 for ':' .. '?' (58..63)
        // would otherwise land in 10..15 and be wrongly accepted as a hex nibble.
        unchecked {
            for (uint256 j = i; j < b.length; ++j) {
                uint8 c = uint8(b[j]);
                uint8 v = (c >= 97 && c <= 102) ? c - 87   // a-f
                       : (c >= 65 && c <= 70)  ? c - 55     // A-F
                       : (c >= 48 && c <= 57)  ? c - 48     // 0-9
                       : 255;
                if (v >= 16) return (false, 0);
            }
        }
        return (true, i);
    }

    /// @dev Call **only after** `isValidCidSalt` returned (true, pos).
    function parseCidSaltUnchecked(string memory packed, uint256 colonPos)
        public pure
        returns (string memory cidOnly, uint256 salt)
    {
        bytes memory b = bytes(packed);

        // copy CID bytes
        bytes memory cidBytes = new bytes(colonPos - 1);
        for (uint256 j; j < cidBytes.length; ++j) cidBytes[j] = b[j];

        // parse 20-char hex salt. Bounds mirror isValidCidSalt (which has already accepted
        // this input); kept identical so the two never diverge if called independently.
        unchecked {
            for (uint256 j = colonPos; j < b.length; ++j) {
                uint8 c = uint8(b[j]);
                uint8 v = (c >= 97 && c <= 102) ? c - 87   // a-f
                       : (c >= 65 && c <= 70)  ? c - 55     // A-F
                       : (c >= 48 && c <= 57)  ? c - 48     // 0-9
                       : 0;           // unreachable post-validation; safe default
                salt = (salt << 4) | v;
            }
        }
        cidOnly = string(cidBytes);
    }

    // ----------------------------------------------------------------------
    //                          HEX CONVERSIONS
    // ----------------------------------------------------------------------

    function bytes16ToHexLower(bytes16 data) public pure returns (string memory) {
        bytes memory hexChars = new bytes(32);
        for (uint256 i = 0; i < 16; i++) {
            uint8 b = uint8(data[i]);
            hexChars[2 * i] = lowerHexChar(b >> 4);
            hexChars[2 * i + 1] = lowerHexChar(b & 0x0f);
        }
        return string(hexChars);
    }

    function bytes32ToHex(bytes32 x) public pure returns (string memory) {
        bytes memory s = new bytes(2+64);
        s[0] = "0";
        s[1] = "x";
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(x[i]);
            s[2 + 2*i]     = lowerHexChar(b >> 4);
            s[3 + 2*i] = lowerHexChar(b & 0x0f);
        }
        return string(s);
    }

    function lowerHexChar(uint8 nib) internal pure returns (bytes1) {
        return bytes1(uint8(nib < 10 ? 48 + nib : 87 + nib)); // 0-9 → '0'-'9', 10-15 → 'a'-'f'
    }
}
