#!/usr/bin/env node
/*  scripts/tidy-classes.js
    -------------------------------------------------------------------------------------------
    The class lists' health, and the two permissionless calls that keep them dense
    (review 2026-11-27, item 1; docs/contracts/reputation-keeper.md, "Dense lists and eviction").

    A draw visits at most maxScan slots of a class list. Slots that hold no arbiter (holes, and
    the old slots of moved arbiters for a day) and listed arbiters that cannot be drawn (paused,
    frozen, banned, exiting) each cost a visit. This script reports, per class:
        slots / listed / ghosts      the keeper's classStats(cls)
        evictable                    listed arbiters idle for evictAfter (anyone may evict them)
    and with --send it evicts those arbiters and compacts each class and the registry.
    It moves no funds and needs no special role: any funded account can run it. Evicting is not a
    penalty (stake, scores and registration stay; the arbiter returns when it unpauses or answers).

    USAGE
      HARDHAT_NETWORK=base_sepolia node scripts/tidy-classes.js --keeper 0x... [--from-block N]
          [--budget 50] [--send]

      --keeper      ReputationKeeper address (default: the hardhat-deploy deployment, if any)
      --from-block  where to start reading ArbiterRegistered events (default: the deployment's block, else 0)
      --budget      compact()'s budget per class per run (default 50)
      --send        send the transactions (default: report only)
    Exit code 2 when a class needs attention (slots above maxScan, or anything to evict or compact)
    and --send was not given, so a cron job can alert on it.
*/
const hre = require("hardhat");

/** Everything the report needs, read from the keeper. `keys`: every key ever registered. */
async function readClasses(keeper, keys, now) {
  const [evictAfter, callDeadline, maxScan] = await Promise.all([keeper.evictAfter(), keeper.callDeadline(), keeper.maxScan()]);
  const F = { REGISTERED: 1n, PAUSED: 2n, BANNED: 4n, EXITING: 8n, CALL_PENDING: 16n };
  const t = BigInt(now);
  const classes = new Map();
  const evictable = [];
  for (const key of keys) {
    if (!(await keeper.isListed(key))) continue;
    const a = await keeper.getArbiter(key);
    const why =
      (a.flags & F.EXITING) !== 0n && a.exitAt !== 0n && t >= a.exitAt ? "exiting, past exitAt"
      : (a.flags & F.BANNED) !== 0n && t > a.blockedUntil + evictAfter ? "banned"
      : (a.flags & F.CALL_PENDING) !== 0n && t > a.callSentAt + callDeadline + evictAfter ? "frozen (no health answer)"
      : (a.flags & F.PAUSED) !== 0n ? "paused"      // its pausedAt is not in a view: evict() is tried by simulation
      : null;
    const cls = (await keeper.arbiterClasses(key)).map(String);
    for (const c of cls) if (!classes.has(c)) classes.set(c, null);
    if (why) evictable.push({ key, why, classes: cls });
  }
  for (const c of classes.keys()) {
    const s = await keeper.classStats(c);
    classes.set(c, { slots: Number(s.slots), listed: Number(s.listed), ghosts: Number(s.ghosts) });
  }
  return { maxScan: Number(maxScan), evictAfter: Number(evictAfter), classes, evictable };
}

/** Keys whose evict() would succeed now (a paused key's clock is only known to the contract). */
async function confirmEvictable(keeper, candidates) {
  const out = [];
  for (const c of candidates) {
    try {
      await keeper.evict.staticCall(c.key);
      out.push(c);
    } catch { /* not yet */ }
  }
  return out;
}

async function tidy({ keeper, keys, now, budget = 50, send = false, log = console.log }) {
  const r = await readClasses(keeper, keys, now);
  const evictable = await confirmEvictable(keeper, r.evictable);
  let attention = evictable.length > 0;
  log(`maxScan ${r.maxScan}, evictAfter ${r.evictAfter} s`);
  for (const [cls, s] of [...r.classes].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const empty = s.slots - s.listed;
    const flags = [s.slots > r.maxScan ? "LONGER THAN maxScan" : null, empty > 0 ? `${empty} slot(s) hold no arbiter` : null].filter(Boolean);
    if (flags.length) attention = true;
    log(`class ${cls}: ${s.slots} slots, ${s.listed} listed, ${s.ghosts} ghosts${flags.length ? "  <-- " + flags.join("; ") : ""}`);
  }
  for (const e of evictable) log(`evictable: ${e.key} (${e.why}; classes ${e.classes.join(", ")})`);
  if (!send) return { ...r, evictable, attention, sent: 0 };
  let sent = 0;
  for (const e of evictable) {
    await (await keeper.evict(e.key)).wait();
    sent++;
    log(`evicted ${e.key}`);
  }
  for (const [cls, s] of r.classes) {
    if (s.slots === s.listed && !evictable.some((e) => e.classes.includes(cls))) continue;
    await (await keeper.compact(cls, budget)).wait();
    sent++;
  }
  if (Number(await keeper.registrySlots()) !== Number(await keeper.registryLength())) {
    await (await keeper.compactRegistry(budget)).wait();
    sent++;
  }
  log(`sent ${sent} transaction(s)`);
  return { ...r, evictable, attention, sent };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  const { ethers } = hre;
  let address = opt("keeper");
  let fromBlock = Number(opt("from-block", 0));
  if (!address) {
    const d = await hre.deployments.get("ReputationKeeper");
    address = d.address;
    fromBlock = fromBlock || d.receipt?.blockNumber || 0;
  }
  const keeper = await ethers.getContractAt("ReputationKeeper", address);
  const head = await ethers.provider.getBlockNumber();
  const keys = new Set();
  for (let b = fromBlock; b <= head; b += 10_000) {
    const logs = await keeper.queryFilter(keeper.filters.ArbiterRegistered(), b, Math.min(head, b + 9_999));
    for (const l of logs) keys.add(l.args.key);
  }
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const send = args.includes("--send");
  const r = await tidy({ keeper, keys: [...keys], now, budget: Number(opt("budget", 50)), send });
  if (r.attention && !send) process.exitCode = 2;
}

module.exports = { readClasses, tidy };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
