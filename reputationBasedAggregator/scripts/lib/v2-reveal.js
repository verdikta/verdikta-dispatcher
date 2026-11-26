/*  scripts/lib/v2-reveal.js
    Pure helpers for reading v2 ReputationAggregator rounds off-chain (reveal-forensics.js,
    arbiter-noise.js). No Hardhat dependency.

    REQUEST IDS. v2 sends oracle requests itself (no ChainlinkClient), with a nonce that encodes the
    round and slot, so every request id is computable from (aggregator, roundId, slot, reveal?):
        nonce     = ((roundId << 8 | slot) << 1) | isReveal
        requestId = keccak256(abi.encodePacked(aggregator, nonce))     (the Chainlink Operator's formula)
    aggId = bytes32(roundId). requestRef(requestId) holds operator << 96 | roundId << 8 | slot only
    until the request is answered, so it cannot be used to map history.

    REVEALS. The reveal's `cid` string is "<cid>:<32 hex salt>" (AggregatorLib.parseCidSalt), and the
    commit is keccak256(abi.encode(aggId, operator, response, salt)), all 32 bytes. The aggregator
    ignores an invalid reveal without an event; checkReveal repeats its static checks in its order.  */
const { ethers } = require("ethers");

const CODER = ethers.AbiCoder.defaultAbiCoder();
const lc = (s) => String(s || "").toLowerCase();

// ReputationAggregator constants
const MAX_LIKELIHOOD_LENGTH = 20;
const MAX_REVEAL_CID_LENGTH = 133;           // MAX_CID_LENGTH (100) + ":" + 32 hex salt
const MAX_SCORE = 10n ** 34n;                // larger scores are clamped, not rejected
const SLOT_FLAGS = { DISPATCHED: 1, COMMITTED: 2, PROMOTED: 4, REVEALED: 8, COUNTED: 16 };
const PHASES = { 1: "DRAW", 2: "BEACON", 3: "COMMIT", 4: "CLOSING", 5: "REVEAL", 6: "FINAL", 7: "SETTLED", 8: "FAILED", 9: "CANCELLED" };
const SKIP_REASONS = { 1: "owner() failed", 2: "commit dispatch reverted", 3: "reveal dispatch reverted", 4: "keeper call reverted" };
const QCODES = { 0: "-", 1: "close", 2: "off", 3: "far" };

const roundIdOf = (aggId) => BigInt(aggId);
const aggIdOf = (roundId) => ethers.zeroPadValue(ethers.toBeHex(BigInt(roundId)), 32).toLowerCase();

function requestNonce(roundId, slot, isReveal) {
  return (((BigInt(roundId) << 8n) | BigInt(slot)) << 1n) | (isReveal ? 1n : 0n);
}

/** The request id the aggregator's request for (round, slot, commit|reveal) gets at the operator. */
function requestIdFor(aggregator, roundId, slot, isReveal) {
  const nonce = requestNonce(roundId, slot, isReveal);
  return lc(ethers.solidityPackedKeccak256(["address", "uint256"], [aggregator, nonce]));
}

/** requestRef(id) -> {operator, roundId, slot}, or null for 0 (unknown or already answered). */
function decodeRequestRef(ref) {
  ref = BigInt(ref);
  if (ref === 0n) return null;
  const low = ref & ((1n << 96n) - 1n);
  return { operator: lc(ethers.getAddress(ethers.toBeHex(ref >> 96n, 20))), roundId: low >> 8n, slot: Number(low & 0xffn) };
}

/** flags -> "D C P R K" style letters (dispatched, committed, promoted, revealed, counted). */
function flagString(flags) {
  const f = Number(flags);
  return ["D", "C", "P", "R", "K"].map((c, i) => (f & (1 << i) ? c : "-")).join("");
}

/** AggregatorLib.parseCidSalt on bytes: "<cid>:<32 hex>" with a non-empty cid -> {cid, salt} or null. */
function parseRevealCid(packed) {
  const b = ethers.toUtf8Bytes(packed);
  const n = b.length;
  if (n < 34 || b[n - 33] !== 0x3a) return null;
  let salt = 0n;
  for (let j = n - 32; j < n; j++) {
    const c = b[j];
    let d;
    if (c >= 48 && c <= 57) d = c - 48;
    else if ((c | 0x20) >= 97 && (c | 0x20) <= 102) d = (c | 0x20) - 87;
    else return null;
    salt = (salt << 4n) | BigInt(d);
  }
  return { cid: ethers.toUtf8String(b.slice(0, n - 33)), salt };
}

/** The v2 commit: keccak256(abi.encode(aggId, operator, response, salt)). */
function commitHashV2(aggId, operator, scores, salt) {
  const enc = CODER.encode(["bytes32", "address", "uint256[]", "uint256"],
    [aggId, ethers.getAddress(operator), scores.map(BigInt), BigInt(salt)]);
  return lc(ethers.keccak256(enc));
}

/** The aggregator treats a reply as a commit iff it has one value and an empty cid. */
const isCommitShaped = (scores, cid) => scores.length === 1 && ethers.toUtf8Bytes(cid).length === 0;

/**
 * The aggregator's static reveal checks, in its order (fulfill, after the deadline/phase/flag checks):
 * length, cid length, cid:salt format, commit hash. Returns {ok, reason, salt, cid, clamped}.
 * `commitHash` is the slot's stored commit (getSlot or CommitReceived).
 */
function checkReveal({ aggId, operator, scores, cid, commitHash }) {
  const out = { ok: false, reason: null, salt: null, cid: null, clamped: 0 };
  if (isCommitShaped(scores, cid)) { out.reason = "commit-shaped reply (1 value, empty cid)"; return out; }
  if (scores.length === 0) { out.reason = "no scores"; return out; }
  if (scores.length > MAX_LIKELIHOOD_LENGTH) { out.reason = `too many scores (${scores.length} > ${MAX_LIKELIHOOD_LENGTH})`; return out; }
  const cidLen = ethers.toUtf8Bytes(cid).length;
  if (cidLen > MAX_REVEAL_CID_LENGTH) { out.reason = `cid too long (${cidLen} > ${MAX_REVEAL_CID_LENGTH} bytes)`; return out; }
  const p = parseRevealCid(cid);
  if (!p) { out.reason = "bad cid:salt format (need <cid>:<32 hex>)"; return out; }
  out.salt = p.salt;
  out.cid = p.cid;
  if (!commitHash || BigInt(commitHash) === 0n) { out.reason = "no commit stored for the slot"; return out; }
  if (commitHashV2(aggId, operator, scores, p.salt) !== lc(commitHash)) { out.reason = "hash mismatch"; return out; }
  out.clamped = scores.filter((x) => BigInt(x) > MAX_SCORE).length;
  out.ok = true;
  return out;
}

module.exports = {
  MAX_LIKELIHOOD_LENGTH, MAX_REVEAL_CID_LENGTH, MAX_SCORE, SLOT_FLAGS, PHASES, SKIP_REASONS, QCODES,
  roundIdOf, aggIdOf, requestNonce, requestIdFor, decodeRequestRef, flagString,
  parseRevealCid, commitHashV2, isCommitShaped, checkReveal,
};
