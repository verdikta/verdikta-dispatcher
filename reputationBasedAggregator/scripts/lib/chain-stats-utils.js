/*  scripts/lib/chain-stats-utils.js
    Shared helpers for the arbiter analytics scripts (arbiter-stats.js, arbiter-noise.js):
    chunked log scans, concurrency/retry, block timestamps, operator-fulfill decoding, and
    small statistics functions. No Hardhat dependency; callers pass an ethers provider.     */
const { ethers } = require("ethers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || "").toLowerCase();
const jsonSafe = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function pMap(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

async function withRetry(fn, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await sleep(500 * 2 ** i); }
  }
  throw err;
}

/** getLogs over [from,to] in chunks, halving the chunk on RPC range/size errors. */
async function getLogsChunked(provider, filter, from, to, chunk, label = "logs") {
  const out = [];
  let start = from, size = chunk, n = 0;
  while (start <= to) {
    const end = Math.min(to, start + size - 1);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      out.push(...logs);
      start = end + 1;
      if (++n % 25 === 0) process.stderr.write(`  ${label}: scanned to block ${end} (${out.length})\n`);
    } catch (e) {
      if (size <= 1) throw e;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return out;
}

/** Block -> timestamp. OP-stack chains have a constant block time (2s on Base, 0.2s on Base
 *  Sepolia as of late 2026); if spot checks agree to within 1s, timestamps are computed,
 *  otherwise fetched per block (cached). */
async function makeTimestamper(provider, from, to) {
  const probes = [from, to, Math.floor((from + to) / 2), Math.floor((3 * from + to) / 4)];
  const [b0, b1, ...checks] = await Promise.all(probes.map((n) => withRetry(() => provider.getBlock(n))));
  const dt = (b1.timestamp - b0.timestamp) / Math.max(1, to - from);
  const predict = (n) => Math.round(b0.timestamp + dt * (n - from));
  const exact = checks.every((b) => Math.abs(predict(b.number) - b.timestamp) <= 1);
  const cache = new Map();
  return {
    blockTime: dt,
    exact,
    ts: async (n) => {
      if (exact) return predict(n);
      if (!cache.has(n)) cache.set(n, (await withRetry(() => provider.getBlock(n))).timestamp);
      return cache.get(n);
    },
  };
}

/** Resolve [from,to] from explicit blocks or a lookback in days. */
async function resolveRange(provider, { fromBlock, toBlock, days }) {
  const to = toBlock ?? (await provider.getBlockNumber());
  if (fromBlock != null) return { from: fromBlock, to };
  const probe = await makeTimestamper(provider, Math.max(0, to - 1000), to);
  return { from: Math.max(0, to - Math.ceil((days * 86400) / probe.blockTime)), to };
}

/* Operator fulfill decoding: ArbiterOperator.fulfillOracleRequestV, or the stock Chainlink
   Operator.fulfillOracleRequest2 (same arguments). data = abi(bytes32 requestId, uint256[] scores,
   string cid) for ReputationAggregator.fulfill. */
const OPERATOR_IFACE = new ethers.Interface([
  "function fulfillOracleRequestV(bytes32 requestId,uint256 payment,address callbackAddress,bytes4 callbackFunctionId,uint256 expiration,bytes data)",
  "function fulfillOracleRequest2(bytes32 requestId,uint256 payment,address callbackAddress,bytes4 callbackFunctionId,uint256 expiration,bytes data)",
  "event OracleResponse(bytes32 indexed requestId)",
]);
const CODER = ethers.AbiCoder.defaultAbiCoder();

function decodeOperatorFulfill(txData) {
  let dec = null;
  for (const fn of ["fulfillOracleRequestV", "fulfillOracleRequest2"]) {
    try { dec = OPERATOR_IFACE.decodeFunctionData(fn, txData); break; } catch { /* next */ }
  }
  if (!dec) throw new Error("not an operator fulfill call");
  const [rid, scores, cid] = CODER.decode(["bytes32", "uint256[]", "string"], dec.data);
  return { requestId: lc(rid), callback: lc(dec.callbackAddress), scores: scores.map((x) => x.toString()), cid };
}

/** Split an arbiter reveal "cid:20hexsalt" (AggregatorLib.isValidCidSalt) -> {cid, salt} or null. */
function parseCidSalt(packed) {
  const i = packed.lastIndexOf(":");
  if (i <= 0 || packed.length - i - 1 !== 20 || !/^[0-9a-fA-F]{20}$/.test(packed.slice(i + 1))) return null;
  return { cid: packed.slice(0, i), salt: BigInt("0x" + packed.slice(i + 1)) };
}

/** The aggregator's commit check: bytes16(sha256(abi.encode(operator, response, salt))). */
function revealCommitHash(operator, scores, salt) {
  const enc = CODER.encode(["address", "uint256[]", "uint256"], [operator, scores.map(BigInt), salt]);
  return lc(ethers.sha256(enc).slice(0, 34));
}

/* ---- statistics ---- */
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const variance = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const quantile = (a, q) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

module.exports = {
  sleep, lc, jsonSafe, pMap, withRetry, getLogsChunked, makeTimestamper, resolveRange,
  OPERATOR_IFACE, decodeOperatorFulfill, parseCidSalt, revealCommitHash,
  mean, variance, quantile, fmt,
};
