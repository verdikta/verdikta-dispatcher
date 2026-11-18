#!/usr/bin/env python3
"""Exact bounty-sizing model for the bounty classes (TODO item 15).

For one jury configuration (K polled, M promoted, N counted, pass quota Q, forfeit line R) it
computes the largest bounty a forcing attacker can't profit from, and what a blocking cartel does to
an honest hunter, under the assumptions of TODO items 12 and 13:

  - Population: E eligible arbiters, a fraction X colluding; the jury is a uniform draw
    (hypergeometric). Honest scores are integer-rounded normal(true, SD); bad work's true score is
    BAD, good work's GOOD, the threshold T.
  - Honest arbiters no-show independently at commit and again at reveal (NS each).
  - Promotion. "first": colluders win the commit and reveal races, so every seated colluder that
    commits is promoted (up to M) and counted (up to N), as items 12 and 13 assume. "random": the M
    promoted are drawn at random from the commits (TODO item 14's M+ / T+ rule with entropy nobody
    can steer); colluders still reveal first, so a promoted colluder is always counted.
  - Outcome (item 12): pass if at least Q counted scores are >= T; hard fail (bond forfeited,
    submission ends) if fewer than R; otherwise soft fail; a round short of M commits or N reveals
    has no result. Soft fail and no result re-run, up to ROUNDS rounds per submission.
  - Forcing attacker (bad work): colluders vote T. In each round it may instead sink the round
    (never commit, or commit and stay silent) to keep the bond and re-run; it forces when at least
    c* colluders are seated and sinks otherwise, with c* chosen to minimise its cost per pass. A
    failed sink is a hard fail.
  - Repeated-submission limit = expected (rounds x cost per round + bond lost) / P(pass), per
    submission.
  - Sequencer limit: a bribe (BRIBE, per attempt) buys a choice of G seeds for the jury draw (item 9:
    the sequencer can grind blockhash(B+1); about 256 seeds, or about 40 with item 13's beacons). It
    keeps the seed seating the most colluders. Under "random" promotion it is assumed to steer the
    promotion draw too (the promotion entropy comes from the same seed), so the sequencer limit is
    always computed with "first".
  - Max bounty = the lower of the two limits, with no safety margin.
  - Blocking cartel (good work): per round it picks the lever with the lowest pass rate (vote T-1,
    commit and stay silent, never commit, or behave honestly).
  - Cost per round = fee x (K + B x P + 1 + beacons) + gas, gas ~ $0.05 at K = 6 to ~$0.39 at K = 50.
    The 1 is item 9's promote reward (adopted 2026-11-18): whoever calls promote() is paid one fee,
    counted as a cost since a third party may call first. The draw reward goes back to the hunter.
  - Beacons (item 9's per-request flag; the class table sets it for Jumbo only): 4 beacons polled,
    the first 2 values mixed into the seed. The sequencer is left about 40 seeds. A cartel holding
    cp of the 4 beacon seats chooses among seed_options(cp) seeds by when its beacons reveal, and
    keeps the one seating the most colluders, for both forcing and blocking.

Calibration: option A with beacons (50/38/27 Q17 R12, P = 2) gives a sequencer limit of $164K,
good work passing 74% of rounds while blocked, 0.5% never paid and 24% of bad rounds keeping the
bond, against item 13's $162K, 73.3%, 0.61% and 22.6%.

Examples:
    python3 scripts/bounty_sizing.py                       # the class table in TODO item 15
    python3 scripts/bounty_sizing.py --config 21,16,13,10,8 --fee 0.25 --bond 100
    python3 scripts/bounty_sizing.py --config 50,38,27,17,12 --bond 250 --B 3 --P 2 --beacons
"""

import argparse
from functools import lru_cache
from math import comb, erfc, sqrt

E, X, SD, T, BAD, GOOD, NS, ROUNDS, BRIBE = 300, 0.15, 3.0, 90, 80, 95, 0.05, 6, 1000.0


def p_at_least_t(mu):
    """P(an honest integer score >= T) for true score mu."""
    return 0.5 * erfc((T - 0.5 - mu) / SD / sqrt(2))


@lru_cache(None)
def binom(n, p):
    return tuple(comb(n, k) * p ** k * (1 - p) ** (n - k) for k in range(n + 1))


@lru_cache(None)
def seats(K):
    C = round(E * X)
    return tuple(comb(C, c) * comb(E - C, K - c) / comb(E, K) for c in range(K + 1))


def hypg(n, k, m):
    """P(j of m drawn from n are among k marked), j = 0..min(k, m)."""
    return [comb(k, j) * comb(n - k, m - j) / comb(n, m) if m - j <= n - k else 0.0 for j in range(min(k, m) + 1)]


@lru_cache(None)
def round_outcome(K, M, N, Q, R, c, mode, promotion):
    """One round with c colluders seated. mode: force (vote T on bad work), low (vote T-1 on good
    work), silent (commit, never reveal; good work), abstain (never commit; good work), honest
    (colluders act honestly; good work). Returns (pass, hard fail, no result)."""
    pp = ph = nores = 0.0
    if mode == "honest":
        c_commit, honest_seats, p_yes = 0, K, p_at_least_t(GOOD)
    else:
        c_commit = 0 if mode == "abstain" else c
        honest_seats, p_yes = K - c, p_at_least_t(BAD if mode == "force" else GOOD)
    reveals = mode in ("force", "low")
    for hc, w1 in enumerate(binom(honest_seats, 1 - NS)):
        n = c_commit + hc
        if n < M:
            nores += w1
            continue
        if promotion == "first" or c_commit == 0:
            draws = [(min(c_commit, M), 1.0)]
        else:
            draws = list(enumerate(hypg(n, c_commit, M)))
        for cp, w2 in draws:
            if not w2:
                continue
            cc = min(cp, N) if reveals else 0
            for hr, w3 in enumerate(binom(M - cp, 1 - NS)):
                if cc + hr < N:
                    nores += w1 * w2 * w3
                    continue
                for y, w4 in enumerate(binom(N - cc, p_yes)):
                    yes = y + (cc if mode == "force" else 0)
                    w = w1 * w2 * w3 * w4
                    if yes >= Q:
                        pp += w
                    elif yes < R:
                        ph += w
    return pp, ph, nores


def per_submission(p, h, rounds=ROUNDS):
    """Per-round pass p and hard fail h -> (eventually pass, eventually hard, out of rounds, E[rounds])."""
    s = 1 - p - h
    ev = sum(s ** k for k in range(rounds))
    return p * ev, h * ev, s ** rounds, ev


BEACONS_POLLED, BEACON_QUORUM = 4, 2
PROMOTE_FEES = 1   # item 9: promote() pays its caller one fee


def seed_options(cp, polled=BEACONS_POLLED, q=BEACON_QUORUM):
    """Seeds a cartel holding cp of the polled beacons can choose from when the seed mixes the first q
    revealed values (risk script S4): its own q values before any honest one, (q - k) of its values
    after k honest ones, or all-honest values if it withholds. Assumes honest values land in
    distinct blocks (0.2 s blocks against ~15 s replies)."""
    h = polled - cp
    return sum(comb(cp, q - k) for k in range(q + 1) if k <= h and q - k <= cp)


@lru_cache(None)
def chosen_seats(K):
    """Jury colluder count when the cartel picks the best of its beacon seed options."""
    hy = seats(K)
    cdf = [sum(hy[:x + 1]) for x in range(K + 1)]
    pool = round(E * X)
    out = [0.0] * (K + 1)
    for cp in range(BEACONS_POLLED + 1):
        w = comb(pool, cp) * comb(E - pool, BEACONS_POLLED - cp) / comb(E, BEACONS_POLLED)
        n = seed_options(cp)
        for x in range(K + 1):
            out[x] += w * (cdf[x] ** n - (cdf[x - 1] ** n if x else 0))
    return tuple(out)


def evaluate(K, M, N, Q, R, fee, bond, B=3, P=None, beacons=False, seeds=None, promotion="random", rounds=ROUNDS):
    """beacons: item 9's per-request flag. On: 4 beacons polled, the first 2 values mixed into the
    seed (2 paid values per round); a bribed sequencer is left about 40 usable seeds (item 13), and
    the cartel picks the best of its beacon seed options in every round (forcing and blocking)."""
    P = Q if P is None else P
    seeds = (40 if beacons else 256) if seeds is None else seeds
    cost = fee * (K + B * P + PROMOTE_FEES + (BEACON_QUORUM if beacons else 0)) + 0.05 + 0.34 * K / 50
    hy = chosen_seats(K) if beacons else seats(K)
    force = [round_outcome(K, M, N, Q, R, c, "force", promotion) for c in range(K + 1)]
    sink = [max(round_outcome(K, M, N, Q, R, c, m, promotion)[2] for m in ("silent", "abstain")) for c in range(K + 1)]
    resub = bad_pass = bad_hard = None
    for cstar in range(K + 2):
        p = sum(hy[c] * force[c][0] for c in range(cstar, K + 1))
        h = sum(hy[c] * force[c][1] for c in range(cstar, K + 1)) + sum(hy[c] * (1 - sink[c]) for c in range(cstar))
        if p <= 0:
            continue
        ep, eh, _, er = per_submission(p, h, rounds)
        lim = (er * cost + eh * bond) / ep
        if resub is None or lim < resub:
            resub, bad_pass, bad_hard = lim, p, h
    # sequencer: best of `seeds` jury draws by colluder count, then one forcing round (it also steers promotion)
    first = [round_outcome(K, M, N, Q, R, c, "force", "first") for c in range(K + 1)]
    cdf = [sum(seats(K)[:x + 1]) for x in range(K + 1)]
    best = [cdf[x] ** seeds - (cdf[x - 1] ** seeds if x else 0) for x in range(K + 1)]
    sp = sum(b * f[0] for b, f in zip(best, first))
    sh = sum(b * f[1] for b, f in zip(best, first))
    seq = (BRIBE + cost + sh * bond) / sp if sp else float("inf")
    # blocking cartel against good work
    blk = []
    for c in range(K + 1):
        opts = [round_outcome(K, M, N, Q, R, c, m, promotion)[:2] for m in ("low", "silent", "abstain")]
        opts.append(round_outcome(K, M, N, Q, R, 0, "honest", promotion)[:2])
        blk.append(min(opts, key=lambda t: (t[0], -t[1])))
    gp = sum(w * b[0] for w, b in zip(hy, blk))
    gh = sum(w * b[1] for w, b in zip(hy, blk))
    paid, _, _, _ = per_submission(gp, gh, rounds)
    return dict(cfg=f"{K}/{M}/{N} Q{Q} R{R}" + (" +beacons" if beacons else ""), cost=cost, bond=bond, fee=fee,
                resub=resub, seq=seq,
                limit=min(resub, seq), good=round_outcome(K, M, N, Q, R, 0, "honest", promotion)[0],
                blocked=gp, never_paid=1 - paid, bad_pass=bad_pass, bad_keeps=1 - bad_pass - bad_hard)


CLASSES = [  # name, (K, M, N, Q, R), fee per arbiter (USD), bond (USD), beacons
    ("Bondless Small", (6, 5, 4, 3, 1), 0.046, 0, False),
    ("Small", (6, 5, 4, 3, 1), 0.046, 5, False),
    ("Medium", (8, 5, 4, 3, 2), 0.25, 50, False),
    ("Large", (21, 16, 13, 10, 8), 0.25, 100, False),
    ("Jumbo", (50, 38, 27, 17, 12), 0.25, 200, True),
]


def money(x):
    return "inf" if x == float("inf") else f"${x:,.0f}"


def show(name, r_first, r_rand):
    print(f"{name:15} {r_first['cfg']:16} fee ${r_first['fee']:<5} bond ${r_first['bond']:<4} cost/round ${r_first['cost']:.2f} | "
          f"max bounty: first {money(r_first['limit'])}, random {money(r_rand['limit'])} "
          f"(repeat {money(r_first['resub'])} / {money(r_rand['resub'])}, sequencer {money(r_first['seq'])}) | "
          f"good {r_rand['good']:.1%} | blocked pass {r_first['blocked']:.0%} / {r_rand['blocked']:.0%} "
          f"never paid {r_first['never_paid']:.1%} / {r_rand['never_paid']:.1%} | "
          f"bad pass/round {r_first['bad_pass']:.3%} / {r_rand['bad_pass']:.3%}, keeps bond {r_first['bad_keeps']:.0%} / {r_rand['bad_keeps']:.0%}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="K,M,N,Q,R (default: print the class table)")
    ap.add_argument("--fee", type=float, default=0.25, help="fee per arbiter, USD")
    ap.add_argument("--bond", type=float, default=0.0, help="hunter's bond, USD")
    ap.add_argument("--B", type=int, default=3, help="bonus multiplier")
    ap.add_argument("--P", type=int, default=None, help="cluster size paid the bonus (default Q)")
    ap.add_argument("--beacons", action="store_true", help="item 9's beacon flag: 4 polled, first 2 used")
    ap.add_argument("--seeds", type=int, default=None, help="seeds a bribed sequencer can choose from "
                                                            "(default 40 with beacons, 256 without)")
    a = ap.parse_args()
    print(f"Assumptions: {E} eligible, {X:.0%} colluding, SD {SD:g}, bad {BAD} / T {T} / good {GOOD}, no-show {NS:.0%} "
          f"per stage, {ROUNDS} rounds per submission, ${BRIBE:,.0f} sequencer bribe. Columns: first-M / random promotion.")
    if a.config:
        K, M, N, Q, R = (int(x) for x in a.config.split(","))
        kw = dict(fee=a.fee, bond=a.bond, B=a.B, P=a.P, beacons=a.beacons, seeds=a.seeds)
        show("config", evaluate(K, M, N, Q, R, promotion="first", **kw), evaluate(K, M, N, Q, R, promotion="random", **kw))
        return
    for name, (K, M, N, Q, R), fee, bond, bea in CLASSES:
        show(name, evaluate(K, M, N, Q, R, fee, bond, beacons=bea, promotion="first"),
             evaluate(K, M, N, Q, R, fee, bond, beacons=bea, promotion="random"))


if __name__ == "__main__":
    main()
