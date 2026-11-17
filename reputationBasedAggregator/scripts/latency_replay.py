#!/usr/bin/env python3
"""Real arbiter latency from `arbiter-stats.js collect` output, and a replay of promotion rules.

Reads the JSON that `node scripts/arbiter-stats.js collect` writes (every round of one aggregator:
request, selected slots, commits, commit phase, reveals, finalization, with block timestamps) and
prints:
  - commit latency (request -> CommitReceived) overall, per operator node and per month;
  - reveal latency (promotion -> reveal) of the promoted slots;
  - commit-timeout rounds and which nodes never committed in them (outages, not latency);
  - today's round timings (first-M promotion) and each node's share of selected vs promoted slots;
  - a replay of the M+ / T+ promotion rule (TODO item 14) on the same rounds.

Censoring. The aggregator rejects commits and reveals once a round is complete, so a slot that had
not answered by then is right-censored at the round's end (finalization; request + timeout for a
timed-out round). Latency is estimated with Kaplan-Meier and with a lognormal fitted by maximum
likelihood with censoring. Latency fits use completed rounds only: a commit-timeout round is almost
always a node that is down, which item 7's freeze handles, not a slow answer.

Replay. For each completed round, promotion under M+ / T+ is min(t(M+), max(T+, t(M))) over the
sorted commit times. Commits logged after promotion are known up to the round's end; a commit that
never arrived before then is imputed from its node's fitted lognormal conditioned on arriving after
the end (`--draws` imputations per round, every round weighted equally). The reveal phase is the
round's actual one (finalization minus commit phase), which is only an approximation when the
replayed M differs from the deployed M.

Example:
    HARDHAT_NETWORK=base node scripts/arbiter-stats.js collect \\
        --aggregator 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a --from-block 47043694 --out arbiter-data.json
    python3 scripts/latency_replay.py arbiter-data.json --since 2026-10 --replay-m 4,5
"""

import argparse
import collections
import datetime as dt
import json
import math
import random
import statistics as st


# ---------------------------------------------------------------------------------------------
#  survival helpers
# ---------------------------------------------------------------------------------------------
def km(obs):
    """Kaplan-Meier: obs = [(time, event 1/0)] -> [(t, S(t))] at each event time."""
    obs = sorted(obs)
    n, S, out, i = len(obs), 1.0, [], 0
    while i < len(obs):
        t, d, c = obs[i][0], 0, 0
        while i < len(obs) and obs[i][0] == t:
            d += obs[i][1]
            c += 1
            i += 1
        if d:
            S *= 1 - d / n
            out.append((t, S))
        n -= c
    return out


def km_q(curve, q):
    """Time by which a fraction q has answered (inf if the curve never gets there)."""
    for t, S in curve:
        if 1 - S >= q:
            return t
    return float("inf")


def km_F(curve, x):
    F = 0.0
    for t, S in curve:
        if t <= x:
            F = 1 - S
    return F


def Phi(z):
    return 0.5 * math.erfc(-z / math.sqrt(2))


def Phi_inv(u):
    lo, hi = -40.0, 40.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if Phi(mid) < u:
            lo = mid
        else:
            hi = mid
    return lo


def lognorm_fit(obs):
    """Lognormal MLE with right censoring (pattern search). Returns median, sigma, mean, sd."""
    ev = [math.log(max(t, 0.5)) for t, e in obs if e]
    ce = [math.log(max(t, 0.5)) for t, e in obs if not e]

    def ll(mu, s):
        return (sum(-math.log(s) - 0.5 * ((x - mu) / s) ** 2 for x in ev)
                + sum(math.log(max(1 - Phi((x - mu) / s), 1e-300)) for x in ce))

    best = (ll(st.mean(ev), st.pstdev(ev) or 0.3), st.mean(ev), st.pstdev(ev) or 0.3)
    step = [0.5, 0.3]
    for _ in range(80):
        moved = False
        for dm in (-step[0], 0, step[0]):
            for ds in (-step[1], 0, step[1]):
                mu, s = best[1] + dm, max(0.05, best[2] + ds)
                v = ll(mu, s)
                if v > best[0] + 1e-9:
                    best, moved = (v, mu, s), True
        if not moved:
            step = [step[0] / 2, step[1] / 2]
    _, mu, s = best
    mean = math.exp(mu + s * s / 2)
    return dict(mu=mu, sigma=s, median=math.exp(mu), mean=mean, sd=mean * math.sqrt(math.exp(s * s) - 1))


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]


# ---------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data", help="JSON written by arbiter-stats.js collect")
    ap.add_argument("--since", default=None, help="only rounds requested in or after this month, e.g. 2026-10")
    ap.add_argument("--replay-m", default=None, help="comma-separated M values to replay (default: deployed M)")
    ap.add_argument("--t-plus", default="90,120,150,180", help="T+ values (s) to replay; mean + 2 SD is added")
    ap.add_argument("--draws", type=int, default=50, help="imputations per round in the replay")
    ap.add_argument("--min-node-slots", type=int, default=30, help="per-node fits need this many slots")
    a = ap.parse_args()

    d = json.load(open(a.data))
    K, M0, N = (int(d["config"][k]) for k in ("k", "m", "n"))
    TO = int(d["config"]["timeout"])
    collected = dt.datetime.fromisoformat(d["meta"]["collectedAt"].replace("Z", "+00:00")).timestamp()
    month = lambda r: dt.datetime.fromtimestamp(r["reqTs"], dt.UTC).strftime("%Y-%m")
    R = [r for r in d["rounds"] if a.since is None or month(r) >= a.since]
    short = lambda x: x[:6]

    def end_of(r):
        if r.get("fulfilled"):
            return r["fulfilled"]["ts"]
        if r.get("timedOut"):
            return r["reqTs"] + TO
        return collected

    def commit_obs(rounds):
        by = collections.defaultdict(list)
        for r in rounds:
            end = end_of(r) - r["reqTs"]
            cby = {c["slot"]: c["ts"] - r["reqTs"] for c in r["commits"]}
            for s in r["selected"]:
                by[s["oracle"]].append((cby[s["slot"]], 1) if s["slot"] in cby else (end, 0))
        return by

    def line(name, obs):
        c, f = km(obs), lognorm_fit(obs)
        t2 = f["mean"] + 2 * f["sd"]
        print(f"  {name:10} slots {len(obs):5} answered {sum(e for _, e in obs):5} | KM p50 {km_q(c, .5):.0f}s "
              f"p90 {km_q(c, .9):.0f}s p95 {km_q(c, .95):.0f}s | <=60s {100 * km_F(c, 60):.0f}% "
              f"<=120s {100 * km_F(c, 120):.0f}% | lognormal median {f['median']:.0f}s sigma {f['sigma']:.2f} "
              f"mean {f['mean']:.0f}s SD {f['sd']:.0f}s -> mean+2SD {t2:.0f}s ({100 * km_F(c, t2):.0f}% by then)")
        return f

    first = dt.datetime.fromtimestamp(min(r["reqTs"] for r in R), dt.UTC)
    last = dt.datetime.fromtimestamp(max(r["reqTs"] for r in R), dt.UTC)
    outcome = collections.Counter("completed" if r.get("fulfilled") else
                                  f"timed out ({r.get('failedPhase', '?')})" if r.get("timedOut") else "open"
                                  for r in R)
    print(f"{d['meta']['network']} aggregator {d['meta']['aggregator']}, K/M/N {K}/{M0}/{N}, timeout {TO}s")
    print(f"{len(R)} rounds {first:%Y-%m-%d} .. {last:%Y-%m-%d}: {dict(outcome)}")

    done = [r for r in R if r.get("fulfilled") and r.get("commitPhaseTs") is not None]
    print(f"\nCOMMIT latency, completed rounds (request -> commit; unanswered slots censored at round end)")
    by = commit_obs(done)
    fall = line("all", [o for v in by.values() for o in v])
    fits = {"_all": fall}
    for op, obs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        f = line(short(op), obs)
        if len(obs) >= a.min_node_slots:
            fits[op] = f

    print("\n  by month, all rounds: median / p90 (KM)")
    bym = collections.defaultdict(list)
    for r in R:
        end = end_of(r) - r["reqTs"]
        cby = {c["slot"]: c["ts"] - r["reqTs"] for c in r["commits"]}
        for s in r["selected"]:
            bym[month(r)].append((cby[s["slot"]], 1) if s["slot"] in cby else (end, 0))
    for m in sorted(bym):
        c = km(bym[m])
        print(f"    {m}: slots {len(bym[m]):4}  median {km_q(c, .5):.0f}s  p90 {km_q(c, .9):.0f}s")

    ct = [r for r in R if r.get("failedPhase") == "commit"]
    slots = [(s["oracle"], s["slot"] in {c["slot"] for c in r["commits"]}) for r in ct for s in r["selected"]]
    nodes = sorted({o for o, _ in slots})
    print(f"\nCOMMIT TIMEOUTS: {len(ct)} rounds ({100 * len(ct) / len(R):.1f}%), "
          f"{sum(1 for r in R if not r['commits'])} with no commit at all. Never committed, by node: "
          + ", ".join(f"{short(o)} {sum(1 for oo, c in slots if oo == o and not c)}/"
                      f"{sum(1 for oo, _ in slots if oo == o)}" for o in nodes))

    rev = []
    for r in done:
        end = end_of(r) - r["commitPhaseTs"]
        rby = {v["slot"]: v["ts"] - r["commitPhaseTs"] for v in r["reveals"]}
        for c in sorted(r["commits"], key=lambda c: c["block"])[:M0]:
            rev.append((rby[c["slot"]], 1) if c["slot"] in rby else (end, 0))
    print("\nREVEAL latency (promotion -> reveal), promoted slots, censored at round end")
    line("all", rev)

    prom = [r["commitPhaseTs"] - r["reqTs"] for r in done]
    revph = [r["fulfilled"]["ts"] - r["commitPhaseTs"] for r in done]
    fin = [r["fulfilled"]["ts"] - r["reqTs"] for r in done]
    print(f"\nTODAY, first-M ({len(done)} completed rounds): promoted mean {st.mean(prom):.0f}s median "
          f"{q(prom, .5):.0f} p90 {q(prom, .9):.0f} | reveal phase median {q(revph, .5):.0f} p90 "
          f"{q(revph, .9):.0f} | finished mean {st.mean(fin):.0f} median {q(fin, .5):.0f} p90 {q(fin, .9):.0f}")

    sel, pro = collections.Counter(), collections.Counter()
    for r in done:
        op = {s["slot"]: s["oracle"] for s in r["selected"]}
        for s in r["selected"]:
            sel[s["oracle"]] += 1
        for c in sorted(r["commits"], key=lambda c: c["block"])[:M0]:
            pro[op[c["slot"]]] += 1
    print("RACE: share of selected slots -> share of promoted slots: " + ", ".join(
        f"{short(o)} {100 * sel[o] / sum(sel.values()):.1f}% -> {100 * pro[o] / sum(pro.values()):.1f}%"
        for o in sorted(sel, key=lambda o: -sel[o])))

    # ---- replay ----
    t_plus = [float(x) for x in a.t_plus.split(",")] + [round(fall["mean"] + 2 * fall["sd"])]
    for M in [int(x) for x in a.replay_m.split(",")] if a.replay_m else [M0]:
        Mp = min(K, max(M + 1, M + -(-(K - M) // 2)))
        rs = [r for r in done if len(r["commits"]) >= M]
        rng = random.Random(1)

        def promote(r, Tp):
            end = end_of(r) - r["reqTs"]
            known = [c["ts"] - r["reqTs"] for c in r["commits"]]
            have = {c["slot"] for c in r["commits"]}
            missing = [s["oracle"] for s in r["selected"] if s["slot"] not in have]
            out = []
            for _ in range(a.draws):
                ts = list(known)
                for op in missing:
                    f = fits.get(op, fall)
                    Fend = Phi((math.log(max(end, 1)) - f["mu"]) / f["sigma"])
                    u = min(max(Fend + rng.random() * (1 - Fend), 1e-15), 1 - 1e-15)
                    ts.append(max(end + 1, math.exp(f["mu"] + f["sigma"] * Phi_inv(u))))
                ts.sort()
                out.append(min(ts[Mp - 1], max(Tp, ts[M - 1])))
            return out

        base_p = [sorted(c["ts"] for c in r["commits"])[M - 1] - r["reqTs"] for r in rs]
        base_f = [p + (r["fulfilled"]["ts"] - r["commitPhaseTs"]) for p, r in zip(base_p, rs)]
        print(f"\nREPLAY K/M = {K}/{M}, M+ = {Mp} ({len(rs)} completed rounds with at least {M} commits logged)")
        print(f"  {'rule':22} {'promoted mean':>13} {'median':>7} {'p90':>5} | {'finished mean':>13} {'median':>7} {'p90':>5}")
        print(f"  {'first-M':22} {st.mean(base_p):13.0f} {q(base_p, .5):7.0f} {q(base_p, .9):5.0f} | "
              f"{st.mean(base_f):13.0f} {q(base_f, .5):7.0f} {q(base_f, .9):5.0f}")
        for Tp in t_plus:
            p, f_ = [], []
            for r in rs:
                ph = r["fulfilled"]["ts"] - r["commitPhaseTs"]
                for x in promote(r, Tp):
                    p.append(x)
                    f_.append(x + ph)
            print(f"  {'M+ / T+, T+ = %.0fs' % Tp:22} {st.mean(p):13.0f} {q(p, .5):7.0f} {q(p, .9):5.0f} | "
                  f"{st.mean(f_):13.0f} {q(f_, .5):7.0f} {q(f_, .9):5.0f}")


if __name__ == "__main__":
    main()
