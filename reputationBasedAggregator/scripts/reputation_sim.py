#!/usr/bin/env python3
"""
Reputation-management simulation for the reputation-based aggregator and keeper.

Simulates every registered arbiter round by round: selection (uniform shortlist, then
reputation-weighted picks), the commit / reveal races, clustering, the keeper's score updates,
blocking, and optional hash-chain liveness calls that freeze arbiters that do not answer by the
end of the round. Arbiters can be honest, colluding, or incompetent (biased model, noisy model,
or a lazy near-constant reporter), and any non-colluder can go down and come back.

Three questions, each with its own metrics:
  1. Down arbiters:        how fast they stop being selected, how many jury slots they waste,
                           and the juror no-show rate that results (option A assumes <= 5%).
  2. Dishonest arbiters:   how fast a cartel is removed under each strategy, and how much of the
                           jury and the bonus it holds meanwhile.
  3. Incompetent arbiters: how fast each wrong-model type is removed.
  Plus the cost: honest arbiters blocked or frozen by mistake.

Reputation policies:
  current  - exact port of ReputationKeeper.updateScores + ReputationAggregator score deltas:
             cumulative quality / timeliness, +60/+60 clustered, -60 quality counted but not
             clustered, -20 timeliness for every other polled slot (including honest arbiters
             that simply lost the commit or reveal race), mild (-300) lock, severe (-900) block
             with reset to -300, 25-record "worsening" block, 24 h lock, selection weight
             clamped to [60, 6000].
  v2       - proposal. Per-arbiter tests, each a CUSUM (floored at 0, so long good records
             buy no immunity), each leading to a block whose duration doubles, with a ban after
             --max-offenses:
               quality  - (--scoring two, default) one CUSUM per arbiter with increment
                          (min(z^2, 9) - 2) / 5 + (2.3 if z > 3 else -0.095), block at 8: z is the
                          reveal's distance from the round median in robust SDs, so persistent
                          deviation (wrong model, lazy) and intermittent large deviations both count.
                          --scoring three keeps the earlier separate CUSUMs:
                 quality  - capped z^2, block at 40
                 extreme  - Bernoulli CUSUM on z > 3, block at 7
               flip     - OFF by default, not implementable in the core contracts (they do not know
                          T or how results are used); kept only as an experiment (--flip 1) for an
                          application-side feedback channel.
                          Consumer feedback: voted on the other side of T from the
                          submission's eventual outcome, exact LLR against the honest flip rate,
                          plus a round-level bonus when the flippers changed the outcome
               silence  - misses counted only when unambiguous: timed-out rounds, or any round
                          when late commits / reveals are recorded (--late-window); plus a
                          round-level sink rule (a round sunk by more live arbiters than the
                          slack allows penalises all of them, scaled by how improbable that many
                          silences are under honest miss rates, so small rounds with a slack of 1 do
                          not block honest arbiters for two coincident transients)
             Selection weight is bounded (max/min ratio --w-ratio) and built from EMAs of
             agreement and on-time commits. Race rank is never penalised.

Liveness (--liveness freeze): every juror also gets a hash-chain call with its commit request,
plus jurors that missed a commit last round (suspects) and --live-random random arbiters. Any
called arbiter that has not answered by the end of the round is frozen (excluded from selection)
until it answers (modelled as a geometric delay after it is back up).

Races (--commit-select): "race" promotes the first M commits (today); "random" promotes M drawn at
random from the commits that arrive within --commit-window, so answering early earns nothing.
Colluder speed (--col-speed, default attack): colluders answer near-instantly only in attack rounds,
where no inference is needed (a fixed force / low vote, or a junk commit for silent); otherwise
they have honest-like latency. "always" reproduces the earlier worst case.

Workload (--mix): each round draws a class K/M/N/P/Q/R by share; all classes share one arbiter pool,
one reputation state and the keeper's global shortlist. The mix-* presets use the nominal workload
(80% 6/5/4/3/3, 16% 8/6/5/4/4, 4% option A 50/38/27/17/17). Bonus shares are by value: every round
escrows a pool of B x P x fee; the cluster pays it to exactly P members, the band rule splits it
evenly among the counted reveals within --agree-z of the median.

Examples:
    python3 scripts/reputation_sim.py --compare --presets today,mix-cur,mix-v2,mix-v2-rnd
    python3 scripts/reputation_sim.py --preset A-v2 --strategy block --lever silent
    python3 scripts/reputation_sim.py --compare --days 60 --json out.json
"""

import argparse
import json
import math
import sys
import random
import statistics
import time

HON, COL, BIAS, NOISY, LAZY = range(5)
TYPE_NAMES = ["honest", "colluder", "biased", "noisy", "lazy"]

# nominal workload: K/M/N/P/Q/R:share of rounds (TODO item 13 option A for the 4% of high-value rounds)
NOMINAL_MIX = "6/5/4/3/3/1:80,8/6/5/4/4/1:16,50/38/27/17/17/12:4"

PRESETS = {
    # today's deployed config: 6/4/3/2, shortlist 20, current rules, no liveness calls
    "today":     dict(K=6, M=4, N=3, P=2, Q=2, R=1, shortlist=20, policy="current", liveness="none"),
    # option A (TODO item 13) under today's reputation rules, P = 2 and P = 17
    "A-cur-P2":  dict(K=50, M=38, N=27, P=2, Q=17, R=12, shortlist=60, policy="current", liveness="none"),
    "A-cur":     dict(K=50, M=38, N=27, P=17, Q=17, R=12, shortlist=60, policy="current", liveness="none"),
    # option A, today's rules + hash-chain freeze
    "A-cur-frz": dict(K=50, M=38, N=27, P=17, Q=17, R=12, shortlist=60, policy="current", liveness="freeze"),
    # option A, proposed rules + hash-chain freeze
    "A-v2":      dict(K=50, M=38, N=27, P=17, Q=17, R=12, shortlist=60, policy="v2", liveness="freeze",
                      late_window=1),
    # as A-v2, but the M promoted committers are drawn at random from the commits that arrive within
    # the commit window, instead of the first M to arrive
    "A-v2-rnd":  dict(K=50, M=38, N=27, P=17, Q=17, R=12, shortlist=60, policy="v2", liveness="freeze",
                      late_window=1, commit_select="random"),
    # nominal mixed workload (80% 6/5/4/3/3, 16% 8/6/5/4/4, 4% option A), one shared arbiter pool and
    # reputation state; the keeper's shortlist is global, so 60 for every class
    "mix-cur":     dict(mix=NOMINAL_MIX, shortlist=60, policy="current", liveness="none"),
    "mix-cur-frz": dict(mix=NOMINAL_MIX, shortlist=60, policy="current", liveness="freeze"),
    "mix-v2":      dict(mix=NOMINAL_MIX, shortlist=60, policy="v2", liveness="freeze", late_window=1),
    "mix-v2-rnd":  dict(mix=NOMINAL_MIX, shortlist=60, policy="v2", liveness="freeze", late_window=1,
                        commit_select="random", commit_window=2.0),
}


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a = ap.add_argument
    a("--preset", default="mix-v2", choices=sorted(PRESETS))
    a("--compare", action="store_true", help="run every preset against every cartel strategy")
    a("--presets", default=None, help="comma-separated presets for --compare (default: all)")
    a("--mix", default=None, help="round classes K/M/N/P/Q/R:share,... drawn per round (overrides K..R); "
                                  f"nominal: {NOMINAL_MIX}")
    a("--days", type=float, default=30.0)
    a("--rounds-per-day", type=float, default=144.0, help="evaluation rounds per day (144 = one per 10 min)")
    a("--seed", type=int, default=1)
    a("--json", default=None, help="write all metrics to this file")
    # round config (overrides the preset)
    for k in ("K", "M", "N", "P", "Q", "R", "shortlist"):
        a(f"--{k}", type=int, default=None)
    a("--policy", choices=["current", "v2"], default=None)
    a("--liveness", choices=["none", "freeze"], default=None)
    a("--bonus", type=int, default=3, help="bonus multiplier B (for bonus-share accounting only)")
    a("--threshold", type=float, default=90.0, help="T for the Q-of-N outcome")
    # population
    a("--eligible", type=int, default=300)
    a("--colluders", type=float, default=0.15)
    a("--biased", type=float, default=0.02, help="fraction running a model biased by --bias")
    a("--bias", type=float, default=6.0)
    a("--noisy", type=float, default=0.02, help="fraction running a model with SD --noisy-sd")
    a("--noisy-sd", type=float, default=8.0)
    a("--lazy", type=float, default=0.01, help="fraction reporting about --lazy-value regardless of the task")
    a("--lazy-value", type=float, default=75.0)
    a("--sd", type=float, default=3.0, help="honest arbiter noise SD")
    a("--task-sd-spread", type=float, default=0.25, help="log-SD of per-task difficulty multiplier on SD")
    # tasks
    a("--good-frac", type=float, default=0.10, help="fraction of tasks that are good bounty work (95)")
    a("--bad-frac", type=float, default=0.10, help="fraction that are bad bounty work (80)")
    a("--good-true", type=float, default=95.0)
    a("--bad-true", type=float, default=80.0)
    a("--general-lo", type=float, default=30.0)
    a("--general-hi", type=float, default=98.0)
    # latency and reliability
    a("--lat-spread", type=float, default=0.4, help="log-SD of per-arbiter median latency")
    a("--lat-noise", type=float, default=0.3, help="log-SD of per-response latency")
    a("--slow-frac", type=float, default=0.10, help="honest arbiters with --slow-factor x latency")
    a("--slow-factor", type=float, default=3.0)
    a("--on-time", type=float, default=4.0, help="v2 absolute commit deadline, in median-latency units")
    a("--commit-select", choices=["race", "random"], default=None,
      help="race: the first M commits are promoted (today); random: M drawn at random from the commits "
           "that arrive within --commit-window (if fewer than M arrive in time, the earliest late ones fill up)")
    a("--commit-window", type=float, default=None, help="commit window for --commit-select random, in "
                                                         "median-latency units (default --on-time)")
    a("--eps-commit", type=float, default=0.01, help="honest transient miss rate per commit")
    a("--eps-reveal", type=float, default=0.01, help="honest transient miss rate per reveal")
    a("--eps-call", type=float, default=0.005, help="honest transient miss rate per hash-chain call")
    a("--mtbf-days", type=float, default=30.0, help="mean time between failures per arbiter (0 = never)")
    a("--mttr-hours", type=float, default=12.0, help="mean time to repair")
    a("--ai-down-frac", type=float, default=0.3, help="failures where the node answers but the AI backend is down")
    a("--call-checks-ai", type=int, default=1, help="1 = the hash-chain call exercises the AI pipeline (item 7)")
    # cartel
    a("--strategy", choices=["mimic", "block", "force", "honest"], default="mimic",
      help="mimic: identical consensus-like scores; block: sink good-work rounds; "
           "force: vote >= T on bad-work rounds; honest: behave honestly (control)")
    a("--lever", choices=["silent", "low", "abstain"], default="silent",
      help="block lever: commit then never reveal, vote T-1, or never commit")
    a("--attack-when", choices=["always", "win"], default="always",
      help="always: attack every eligible round; win: only when enough colluders are seated to win")
    a("--attack-frac", type=float, default=1.0, help="fraction of eligible rounds the cartel attacks")
    a("--force-vote", type=float, default=None, help="score colluders report when forcing (default T)")
    a("--col-speed", choices=["always", "attack", "never"], default="attack",
      help="when colluders answer near-instantly: always; attack = only in attack rounds, where the vote "
           "is fixed in advance (force, low) or the commit is junk (silent), so no inference is needed; "
           "never. Otherwise they have honest-like latency (one shared inference run)")
    # current-policy parameters (keeper / aggregator defaults)
    a("--alpha", type=int, default=500, help="timeliness weight in selection, 0..1000")
    a("--lock-hours", type=float, default=24.0)
    a("--mild", type=int, default=-300)
    a("--severe", type=int, default=-900)
    a("--history", type=int, default=25)
    # liveness parameters
    a("--live-random", type=int, default=30, help="random hash-chain calls per round")
    a("--live-jury", type=int, default=1, help="1 = every juror also gets a hash-chain call")
    a("--unfreeze-rounds", type=float, default=3.0, help="mean rounds from back-up to answered call")
    # v2 parameters
    a("--q-k", type=float, default=2.0, help="quality CUSUM: increment = min(z^2, cap) - k")
    a("--q-cap", type=float, default=9.0)
    a("--q-h", type=float, default=40.0, help="quality CUSUM alarm threshold")
    a("--e-tau", type=float, default=3.0, help="extreme CUSUM: a deviation counts when z > tau")
    a("--e-a", type=float, default=2.3, help="extreme CUSUM increment, ~ln(p1/p0) = ln(0.1/0.01)")
    a("--e-b", type=float, default=0.095, help="extreme CUSUM decrement, ~-ln(0.9/0.99)")
    a("--e-h", type=float, default=7.0)
    a("--scoring", choices=["two", "three"], default="two",
      help="v2 quality alarms. two: one CUSUM, increment (min(z^2,cap) - q_k)/q_div + extreme term, "
           "block at --qm-h (with silence this gives one timeliness and one quality alarm). "
           "three: separate quality (--q-h) and extreme (--e-h) CUSUMs (earlier runs)")
    a("--q-div", type=float, default=5.0, help="two-score: divisor putting the z^2 term in LLR-like units")
    a("--qm-h", type=float, default=8.0, help="two-score: merged quality alarm threshold")
    a("--flip", type=int, default=None, help="1 = the consumer (BountyEscrow) reports which counted arbiters "
                                         "voted on the other side of T from the median")
    a("--flip-min-gap", type=float, default=1.0, help="score flips only when |median - T| >= this many SDs")
    a("--flip-p0-floor", type=float, default=0.01)
    a("--flip-p1", type=float, default=0.5, help="flip rate the test is tuned to detect")
    a("--f-h", type=float, default=8.0)
    a("--f-decisive", type=float, default=5.0, help="extra flip increment when the flippers changed the outcome")
    a("--sink-rule", type=int, default=1, help="1 = penalise every live arbiter whose silence sank a round")
    a("--s-sink", type=float, default=30.0, help="sink penalty (default = --s-h: block on the first sink)")
    a("--sink-mode", choices=["fixed", "surprise"], default="surprise",
      help="fixed: every sinker gets --s-sink; surprise: --sink-per-decade x -log10 P(at least that many "
           "silent | honest miss rate), capped at --s-sink, so sinks honest transients could cause cost little")
    a("--sink-per-decade", type=float, default=5.0)
    a("--late-window", type=int, default=None, help="1 = record commits and reveals that arrive after the "
                                                     "race but before the timeout (needed to score silence)")
    a("--noise-df", type=float, default=0.0, help="Student-t degrees of freedom for arbiter noise (0 = normal)")
    a("--sigma-floor", type=float, default=3.0, help="floor on the round's robust SD for z")
    a("--s-silent", type=float, default=10.0, help="silence CUSUM increment: promoted, no reveal, round timed out")
    a("--s-miss", type=float, default=4.0, help="silence CUSUM increment: alive, no commit, round timed out")
    a("--s-b", type=float, default=1.0, help="silence CUSUM decrement per commit")
    a("--s-h", type=float, default=30.0)
    a("--max-offenses", type=int, default=3, help="v2: ban after this many blocks (durations double)")
    a("--ema", type=float, default=0.02)
    a("--agree-z", type=float, default=1.5)
    a("--w-ratio", type=float, default=2.0, help="v2: max / min selection weight")
    return ap


def resolve(args):
    p = dict(vars(args))
    pre = PRESETS[p["preset"]]
    for k, v in pre.items():
        if p.get(k) is None:
            p[k] = v
    for k in ("late_window", "flip"):
        if p[k] is None:
            p[k] = 0
    if p["commit_select"] is None:
        p["commit_select"] = "race"
    if p["commit_window"] is None:
        p["commit_window"] = p["on_time"]
    if p["mix"] is None:
        p["mix"] = "/".join(str(p[k]) for k in ("K", "M", "N", "P", "Q", "R")) + ":100"
    classes = []
    for part in p["mix"].split(","):
        cfg, share = part.split(":")
        K, M, N, P, Q, R = (int(x) for x in cfg.split("/"))
        assert 1 <= R <= Q <= N <= M <= K and P <= N, part
        classes.append(dict(name=cfg, K=K, M=M, N=N, P=P, Q=Q, R=R, share=float(share)))
    p["classes"] = classes
    if p["force_vote"] is None:
        p["force_vote"] = p["threshold"]
    return p


# ---------------------------------------------------------------------------------------------
#  helpers
# ---------------------------------------------------------------------------------------------
def greedy_cluster(s, P):
    """AggregatorLib.findBestCluster on 1-D scores: closest pair (first in scan order), then add
    the candidate with the smallest summed squared distance to the members until P. Returns the
    member positions."""
    n = len(s)
    if n < 2:
        return set()
    best, pair = None, None
    for i in range(n):
        si = s[i]
        for j in range(i + 1, n):
            d = (si - s[j]) ** 2
            if best is None or d < best:
                best, pair = d, (i, j)
    members = [pair[0], pair[1]]
    inm = set(members)
    tot = [(s[c] - s[pair[0]]) ** 2 + (s[c] - s[pair[1]]) ** 2 for c in range(n)]
    while len(members) < min(P, n):
        c_best, v_best = None, None
        for c in range(n):
            if c not in inm and (v_best is None or tot[c] < v_best):
                c_best, v_best = c, tot[c]
        members.append(c_best)
        inm.add(c_best)
        for c in range(n):
            tot[c] += (s[c] - s[c_best]) ** 2
    return inm


def median(xs):
    return statistics.median(xs)


def pctl(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


# ---------------------------------------------------------------------------------------------
#  simulation
# ---------------------------------------------------------------------------------------------
def run(p):
    rng = random.Random(p["seed"])
    E, T = p["eligible"], p["threshold"]
    classes = p["classes"]
    cw = [c["share"] for c in classes]
    rpd = p["rounds_per_day"]
    R_total = int(round(p["days"] * rpd))
    lock = p["lock_hours"] / 24.0 * rpd
    v2 = p["policy"] == "v2"
    live = p["liveness"] == "freeze"
    H = p["history"]

    # ---- population ----
    n_col = int(round(E * p["colluders"]))
    n_b, n_n, n_l = (int(round(E * p[k])) for k in ("biased", "noisy", "lazy"))
    types = [COL] * n_col + [BIAS] * n_b + [NOISY] * n_n + [LAZY] * n_l + [HON] * (E - n_col - n_b - n_n - n_l)
    rng.shuffle(types)
    sd = [p["noisy_sd"] if t == NOISY else p["sd"] for t in types]
    bias = [p["bias"] if t == BIAS else 0.0 for t in types]
    lat = [math.exp(rng.gauss(0, p["lat_spread"])) for _ in range(E)]
    slow = [t == HON and rng.random() < p["slow_frac"] for t in types]
    for i in range(E):
        if slow[i]:
            lat[i] *= p["slow_factor"]
        if p["col_speed"] == "always" and types[i] == COL:
            lat[i] = 0.02

    # ---- state ----
    up = [True] * E
    mode = [0] * E                    # 0 up, 1 node down, 2 AI backend down
    frozen = [False] * E
    banned = [False] * E
    blocked = [False] * E
    locked_until = [-1.0] * E
    Qs = [0] * E; Ts = [0] * E        # current policy
    hlen = [0] * E; run_w = [0] * E; pQ = [0] * E; pT = [0] * E
    cq = [0.0] * E; cs = [0.0] * E    # v2 CUSUMs: quality (z^2), silence
    ce = [0.0] * E; cf = [0.0] * E    # v2 CUSUMs: extreme deviation, consumer-reported flips
    qa = [0.5] * E; ta = [0.5] * E    # v2 EMAs
    offenses = [0] * E
    suspects = set()

    # ---- metrics ----
    slots = [0] * 5; slots_late = [0] * 5; clus_slots = [0] * 5; band_slots = [0] * 5
    nocommit = dict(down=0, transient=0, strategic=0)
    total_slots = 0
    outcomes = dict(complete=0, commit_to=0, reveal_to=0)
    good = dict(n=0, pass_=0, soft=0, hard=0, nores=0)
    bad = dict(n=0, pass_=0, soft=0, hard=0, nores=0)
    # per round class; bonus is accounted in units of B x fee: the cluster pays exactly P members one
    # unit each, the band rule splits the same pool of P units among everyone in the band
    cm = {c["name"]: dict(rounds=0, complete=0, commit_to=0, reveal_to=0, attacks=0, rt=[],
                          good=dict(n=0, pass_=0, soft=0, hard=0, nores=0),
                          bad=dict(n=0, pass_=0, soft=0, hard=0, nores=0),
                          slots=[0] * 5, clus=[0.0] * 5, band=[0.0] * 5) for c in classes}
    shortfall = 0
    first_block = [-1] * E
    sel_before_block = [-1] * E
    sel_count = [0] * E
    block_events = []                 # (round, arbiter, reason)
    false_freezes = 0
    hb_time = [0, 0]                  # honest blocked arbiter-rounds: [fast, slow]
    honest_frozen_up_time = 0
    attacks = 0
    round_time = []                   # complete rounds: promotion time + N-th reveal, latency units
    promote_time = []
    rnd = p["commit_select"] == "random"
    down_events = []
    open_ev = {}
    pf = 1.0 / (p["mtbf_days"] * rpd) if p["mtbf_days"] > 0 else 0.0
    pr = 1.0 / (p["mttr_hours"] / 24.0 * rpd)
    pu = 1.0 / max(p["unfreeze_rounds"], 1e-9)
    late_quarter = int(R_total * 0.75)
    hon_ids = [i for i in range(E) if types[i] == HON]
    a_w = p["alpha"] / 1000.0

    df = p["noise_df"]
    tscale = math.sqrt((df - 2) / df) if df > 2 else 1.0

    def noise_draw():
        """Unit-SD noise: normal, or Student t with --noise-df degrees of freedom."""
        g = rng.gauss(0, 1)
        if df <= 0:
            return g
        return g / math.sqrt(rng.gammavariate(df / 2.0, 2.0) / df) * tscale

    def is_blocked(i, r):
        return banned[i] or (blocked[i] and r < locked_until[i])

    def do_block(i, r, reason, dur):
        blocked[i] = True
        locked_until[i] = r + dur
        if first_block[i] < 0:
            first_block[i] = r
            sel_before_block[i] = sel_count[i]
        block_events.append((r, i, reason))

    def cur_update(i, dq, dt, r):
        """ReputationKeeper.updateScores, line by line."""
        Qs[i] += dq; Ts[i] += dt
        if hlen[i] > 0:
            worse = not (Qs[i] >= pQ[i] and Ts[i] >= pT[i])
            run_w[i] = run_w[i] + 1 if worse else 0
        else:
            run_w[i] = 0
        hlen[i] = min(hlen[i] + 1, H)
        pQ[i], pT[i] = Qs[i], Ts[i]
        if r >= locked_until[i]:
            if blocked[i]:
                blocked[i] = False
            if Qs[i] < p["severe"] or Ts[i] < p["severe"]:
                do_block(i, r, "severe", lock)
                if Qs[i] < p["severe"]:
                    Qs[i] = p["mild"]
                if Ts[i] < p["severe"]:
                    Ts[i] = p["mild"]
            elif Qs[i] < p["mild"] or Ts[i] < p["mild"]:
                locked_until[i] = r + lock          # mild lock: no selection effect
                blocked[i] = False
        if hlen[i] == H and run_w[i] >= H - 1:
            do_block(i, r, "worsening", lock)
            hlen[i] = 0; run_w[i] = 0

    def v2_block(i, r, reason):
        do_block(i, r, reason, lock * (2 ** offenses[i]))
        offenses[i] += 1
        if offenses[i] >= p["max_offenses"]:
            banned[i] = True

    def weight(i):
        if v2:
            rep = (1 - a_w) * qa[i] + a_w * ta[i]
            return 1.0 + (p["w_ratio"] - 1.0) * min(max(rep, 0.0), 1.0)
        ws = ((1000 - p["alpha"]) * Qs[i] + p["alpha"] * Ts[i]) // 1000
        return float(min(max(ws, 60), 6000))

    t0 = time.time()
    for r in range(R_total):
        # ---- failures and repairs ----
        if pf > 0:
            for i in range(E):
                if up[i]:
                    if types[i] != COL and rng.random() < pf:
                        up[i] = False
                        mode[i] = 2 if rng.random() < p["ai_down_frac"] else 1
                        open_ev[i] = dict(start=r, removed=None, slots=0, mode=mode[i])
                elif rng.random() < pr:
                    up[i] = True; mode[i] = 0
                    ev = open_ev.pop(i, None)
                    if ev:
                        down_events.append(ev)
        answerable = [up[i] or (mode[i] == 2 and not p["call_checks_ai"]) for i in range(E)]
        if live:
            for i in range(E):
                if frozen[i] and answerable[i] and rng.random() < pu:
                    frozen[i] = False

        elig = [i for i in range(E) if not (frozen[i] or is_blocked(i, r))]
        for i, ev in open_ev.items():
            if ev["removed"] is None and (frozen[i] or is_blocked(i, r)):
                ev["removed"] = r
        for i in hon_ids:
            if is_blocked(i, r):
                hb_time[1 if slow[i] else 0] += 1
            if frozen[i] and up[i]:
                honest_frozen_up_time += 1

        # ---- round class ----
        if not elig:
            continue
        cls = classes[0] if len(classes) == 1 else rng.choices(classes, weights=cw)[0]
        K, M, N, P, Qq, Rr = cls["K"], cls["M"], cls["N"], cls["P"], cls["Q"], cls["R"]
        cs_ = cm[cls["name"]]
        cs_["rounds"] += 1

        # ---- selection: uniform shortlist, then weighted picks without replacement ----
        sl = rng.sample(elig, p["shortlist"]) if len(elig) > p["shortlist"] else elig
        if len(sl) < K:
            shortfall += 1
            jury = list(sl) + [rng.choice(sl) for _ in range(K - len(sl))]
        else:
            keyed = sorted(sl, key=lambda i: -(rng.random() ** (1.0 / weight(i))))
            jury = keyed[:K]
        rng.shuffle(jury)
        jt = [types[i] for i in jury]
        for i, t in zip(jury, jt):
            sel_count[i] += 1
            slots[t] += 1
            cs_["slots"][t] += 1
            if r >= late_quarter:
                slots_late[t] += 1
            if i in open_ev:
                open_ev[i]["slots"] += 1
        total_slots += K

        # ---- task and cartel action ----
        u = rng.random()
        if u < p["good_frac"]:
            kind, tv = "good", p["good_true"]
        elif u < p["good_frac"] + p["bad_frac"]:
            kind, tv = "bad", p["bad_true"]
        else:
            kind, tv = "general", rng.uniform(p["general_lo"], p["general_hi"])
        msd = math.exp(rng.gauss(0, p["task_sd_spread"]))
        is_col = [t == COL for t in jt]
        c_jury = sum(is_col)
        # colluders needed for an attack to work: force / low count promoted colluders (they reveal
        # first, so all of them are counted); silent counts promoted colluders; abstain counts seats.
        need = {"force": Qq, "low": N - Qq + 1, "silent": M - N + 1, "abstain": K - M + 1}
        # what the cartel can count on before committing: under the race, every seated colluder is
        # promoted (they commit instantly); under random promotion about M/K of them are.
        exp_prom = c_jury * M / K if rnd else c_jury
        lever = p["lever"]
        act = "mimic"
        if p["strategy"] == "honest":
            act = "honest"
        elif p["strategy"] == "block" and kind == "good" and rng.random() < p["attack_frac"]:
            # race: decided now (every seated colluder will be promoted). Random promotion: silent
            # commits a real score and decides after promotion is known whether to withhold the
            # reveal, so it is tentatively on here and re-checked after promotion.
            if p["attack_when"] == "always" or (rnd and lever == "silent") or \
                    (exp_prom if lever == "low" else c_jury) >= need[lever]:
                act = "block"
        elif p["strategy"] == "force" and kind == "bad" and rng.random() < p["attack_frac"]:
            if p["attack_when"] == "always" or exp_prom >= need["force"]:
                act = "force"

        shared = tv + rng.gauss(0, 1.0)
        sc = []
        for j, i in enumerate(jury):
            if is_col[j] and act != "honest":
                v = shared
                if act == "block" and p["lever"] == "low":
                    v = T - 1
                elif act == "force":
                    v = p["force_vote"]
            elif jt[j] == LAZY:
                v = p["lazy_value"] + rng.gauss(0, 2)
            else:
                v = tv + bias[i] + noise_draw() * sd[i] * msd
            sc.append(min(max(round(v), 0), 100))

        # ---- commit phase ----
        # colluders answer near-instantly when they need no inference (--col-speed attack); a silent
        # blocker under random promotion still commits a real score, but on time
        quick = p["col_speed"] == "always" or (p["col_speed"] == "attack" and act in ("block", "force")
                                               and not (rnd and lever == "silent"))
        fast_now = [is_col[j] and quick for j in range(K)]
        committed = [False] * K
        clat = [0.0] * K
        for j, i in enumerate(jury):
            if not up[i]:
                nocommit["down"] += 1
                continue
            if is_col[j] and act == "block" and p["lever"] == "abstain":
                nocommit["strategic"] += 1
                continue
            if rng.random() < p["eps_commit"]:
                nocommit["transient"] += 1
                continue
            committed[j] = True
            clat[j] = (0.02 if fast_now[j] else lat[i]) * math.exp(rng.gauss(0, p["lat_noise"]))
        corder = sorted((j for j in range(K) if committed[j]), key=lambda j: clat[j])
        promoted = [False] * K
        if rnd:
            ontime = [j for j in corder if clat[j] <= p["commit_window"]]
            if len(ontime) >= M:
                chosen = rng.sample(ontime, M)
                t_prom = p["commit_window"]
            else:
                chosen = corder[:M]                   # all on-time, then the earliest late commits
                t_prom = max(p["commit_window"], clat[corder[M - 1]]) if len(corder) >= M else None
        else:
            chosen = corder[:M]
            t_prom = clat[corder[M - 1]] if len(corder) >= M else None
        for j in chosen:
            promoted[j] = True
        # silent lever: the cartel sees who was promoted before deciding to withhold its reveals
        if rnd and act == "block" and lever == "silent" and p["attack_when"] == "win":
            if sum(1 for j in chosen if is_col[j]) < need["silent"]:
                act = "mimic"
        if act in ("block", "force") and any(is_col):
            attacks += 1
            cs_["attacks"] += 1
        counted = [False] * K
        rlat = [0.0] * K
        rev = []
        if len(corder) < M:
            result = "commit_to"
        else:
            for j in chosen:
                if is_col[j] and act == "block" and p["lever"] == "silent":
                    continue
                if rng.random() < p["eps_reveal"]:
                    continue
                rlat[j] = (0.02 if fast_now[j] else lat[jury[j]]) * math.exp(rng.gauss(0, p["lat_noise"]))
                rev.append(j)
            if len(rev) < N:
                result = "reveal_to"
            else:
                rev.sort(key=lambda j: rlat[j])
                cidx = rev[:N]                       # reveal order
                promote_time.append(t_prom)
                round_time.append(t_prom + rlat[cidx[-1]])
                cs_["rt"].append(t_prom + rlat[cidx[-1]])
                for j in cidx:
                    counted[j] = True
                result = "complete"
        outcomes[result] += 1
        cs_[result] += 1

        # ---- clustering and the Q-of-N outcome ----
        cl = [False] * K
        oc = "nores"
        if result == "complete":
            inc = greedy_cluster([sc[j] for j in cidx], P)
            for pos in inc:
                cl[cidx[pos]] = True
                clus_slots[jt[cidx[pos]]] += 1
                cs_["clus"][jt[cidx[pos]]] += 1
            # alternative bonus rule for comparison: every counted reveal within --agree-z robust
            # SDs of the median earns the bonus (no fixed P, so identical votes gain nothing extra)
            bv = [sc[j] for j in cidx]
            bmed = median(bv)
            bsref = max(median([abs(v - bmed) for v in bv]) * 1.4826, p["sigma_floor"])
            inband = [j for j in cidx if abs(sc[j] - bmed) / bsref <= p["agree_z"]]
            for j in inband:
                band_slots[jt[j]] += P / len(inband)
                cs_["band"][jt[j]] += P / len(inband)
            npass = sum(1 for j in cidx if sc[j] >= T)
            oc = "pass_" if npass >= Qq else ("soft" if npass >= Rr else "hard")
        if kind != "general":
            for d in ((good, cs_["good"]) if kind == "good" else (bad, cs_["bad"])):
                d["n"] += 1
                d[oc] += 1

        # ---- reputation updates ----
        if not v2:
            for j, i in enumerate(jury):
                if result == "complete":
                    if counted[j]:
                        if cl[j]:
                            cur_update(i, 60, 60, r)
                        else:
                            cur_update(i, -60, 0, r)
                    else:
                        cur_update(i, 0, -20, r)
                elif result == "commit_to":
                    if not committed[j]:
                        cur_update(i, 0, -20, r)
                elif not counted[j]:                 # reveal timeout: every slot with no reveal
                    cur_update(i, 0, -20, r)
        else:
            # jurors that will be frozen at round end (liveness call unanswered) are not charged
            # for missing work: liveness handles them.
            frozen_end = [live and not answerable[i] for i in jury]
            if result == "complete":
                vals = [sc[j] for j in cidx]
                med = median(vals)
                mad = median([abs(v - med) for v in vals]) * 1.4826
                sref = max(mad, p["sigma_floor"])
                # with a late window, reveals after the N-th are recorded and scored too
                scored = rev if p["late_window"] else cidx
                bounty = kind != "general"
                ref = tv
                decisive = (ref >= T) != (oc == "pass_")
                for j in scored:
                    i = jury[j]
                    z = abs(sc[j] - med) / sref
                    dev = min(z * z, p["q_cap"]) - p["q_k"]
                    ext = p["e_a"] if z > p["e_tau"] else -p["e_b"]
                    if p["scoring"] == "two":
                        # one quality alarm in LLR-like units: persistent deviation (capped z^2,
                        # rescaled by --q-div) plus the rare-large-deviation term
                        cq[i] = max(0.0, cq[i] + dev / p["q_div"] + ext)
                    else:
                        # (a) persistent deviation: CUSUM on capped z^2 (wrong model, lazy)
                        cq[i] = max(0.0, cq[i] + dev)
                        # (b) rare large deviation: Bernoulli CUSUM on z > tau (intermittent forcing)
                        ce[i] = max(0.0, ce[i] + ext)
                    # (c) consumer feedback: voted on the other side of T from the median.
                    #     Exact Bernoulli LLR with the honest flip rate p0 = Phi(-|med - T| / sref).
                    # Reference side: the submission's eventual outcome, which BountyEscrow learns
                    # after its re-runs (approximated here by the side of the true value; good work
                    # is eventually paid 99.4% of the time, bad work 0.02%). The round's own median
                    # is not usable: a blocking bloc drags it toward T.
                    if p["flip"] and bounty:
                        gap = abs(ref - T) / sref
                        if gap >= p["flip_min_gap"]:
                            p0 = max(0.5 * math.erfc(gap / math.sqrt(2)), p["flip_p0_floor"])
                            p1 = p["flip_p1"]
                            flipped = (sc[j] >= T) != (ref >= T)
                            step = math.log(p1 / p0) if flipped else math.log((1 - p1) / (1 - p0))
                            # round-level: the outcome contradicts the median's side of T, so the
                            # flippers decided it. Honest flippers here are rare collateral.
                            if flipped and decisive:
                                step += p["f_decisive"]
                            cf[i] = max(0.0, cf[i] + step)
                    qa[i] += p["ema"] * ((1.0 if z <= p["agree_z"] else 0.0) - qa[i])
                    tests = (((cq, p["qm_h"], "quality"),) if p["scoring"] == "two" else
                             ((cq, p["q_h"], "quality"), (ce, p["e_h"], "extreme")))
                    for arr, h, why in tests + ((cf, p["f_h"], "flip"),):
                        if arr[i] >= h and not banned[i]:
                            v2_block(i, r, why)
                            arr[i] = 0.0
            revealed_set = set(rev)
            # round-level sink test: the round failed because more live arbiters than the slack
            # allows went silent (or never committed). Honest transients cannot plausibly do this,
            # and dead or AI-down arbiters are frozen by the liveness call instead.
            sink = set()
            if p["sink_rule"] and result == "reveal_to":
                sil = [j for j in range(K) if promoted[j] and j not in revealed_set and not frozen_end[j]]
                if len(sil) > M - N:
                    sink = set(sil)
                    sink_tail = (len(sil), sum(1 for j in range(K) if promoted[j] and not frozen_end[j]),
                                 p["eps_reveal"])
            elif p["sink_rule"] and result == "commit_to":
                miss = [j for j in range(K) if not committed[j] and not frozen_end[j]]
                if len(miss) > K - M:
                    sink = set(miss)
                    sink_tail = (len(miss), sum(1 for j in range(K) if not frozen_end[j]), p["eps_commit"])
            sink_inc = p["s_sink"]
            if sink and p["sink_mode"] == "surprise":
                k_, n_, e_ = sink_tail
                tail = sum(math.comb(n_, x) * e_ ** x * (1 - e_) ** (n_ - x) for x in range(k_, n_ + 1))
                sink_inc = min(p["s_sink"], p["sink_per_decade"] * -math.log10(max(tail, 1e-300)))
            for j, i in enumerate(jury):
                if committed[j]:
                    cs[i] = max(0.0, cs[i] - p["s_b"])
                    ta[i] += p["ema"] * ((1.0 if clat[j] <= p["on_time"] else 0.0) - ta[i])
                elif not frozen_end[j]:
                    ta[i] += p["ema"] * (0.0 - ta[i])
                if frozen_end[j]:
                    continue
                # Misses are unambiguous only when the arbiter had the whole timeout: in a timed-out
                # round, or in any round when late commits / reveals are recorded (--late-window).
                sure = result != "complete" or p["late_window"]
                if sure and promoted[j] and j not in revealed_set:
                    cs[i] += p["s_silent"]
                elif sure and not committed[j]:
                    cs[i] += p["s_miss"]
                if j in sink:
                    cs[i] += sink_inc
                if cs[i] >= p["s_h"] and not banned[i]:
                    v2_block(i, r, "silence")
                    cs[i] = 0.0

        # ---- liveness calls: jurors, last round's suspects, random arbiters ----
        if live:
            called = set(jury) if p["live_jury"] else set()
            called |= suspects
            if p["live_random"] > 0:
                cand = [i for i in elig]
                called |= set(rng.sample(cand, min(p["live_random"], len(cand))))
            suspects = set()
            for i in called:
                if frozen[i] or banned[i]:
                    continue
                if not answerable[i] or rng.random() < p["eps_call"]:
                    frozen[i] = True
                    if answerable[i] and types[i] == HON:
                        false_freezes += 1
            for j, i in enumerate(jury):
                if not committed[j] and not frozen[i]:
                    suspects.add(i)

    down_events.extend(open_ev.values())     # censored (still down at the end)

    # ---- summarise ----
    years = p["days"] / 365.0
    out = dict(params={k: p[k] for k in ("preset", "K", "M", "N", "P", "Q", "R", "shortlist", "policy",
                                         "liveness", "strategy", "lever", "attack_when", "days", "eligible",
                                         "commit_select", "col_speed", "mix",
                                         "colluders", "late_window", "flip", "noise_df")})
    n_by = [types.count(t) for t in range(5)]
    tot, totl, totc = max(sum(slots), 1), max(sum(slots_late), 1), max(sum(clus_slots), 1)
    out["pop_share"] = {TYPE_NAMES[t]: n_by[t] / E for t in range(5)}
    out["jury_share"] = {TYPE_NAMES[t]: slots[t] / tot for t in range(5)}
    out["jury_share_last_quarter"] = {TYPE_NAMES[t]: slots_late[t] / totl for t in range(5)}
    out["bonus_share"] = {TYPE_NAMES[t]: clus_slots[t] / totc for t in range(5)}
    out["band_bonus_share"] = {TYPE_NAMES[t]: band_slots[t] / max(sum(band_slots), 1) for t in range(5)}
    out["band_bonus_slots_per_round"] = sum(band_slots) / max(outcomes["complete"], 1)
    rate = lambda d: {k: (v / d["n"] if k != "n" and d["n"] else v) for k, v in d.items()}
    share = lambda xs: {TYPE_NAMES[t]: xs[t] / max(sum(xs), 1e-12) for t in range(5)}
    out["classes"] = {c["name"]: dict(
        share=c["share"], rounds=cm[c["name"]]["rounds"],
        complete=cm[c["name"]]["complete"] / max(cm[c["name"]]["rounds"], 1),
        good_work=rate(cm[c["name"]]["good"]), bad_work=rate(cm[c["name"]]["bad"]),
        attacks=cm[c["name"]]["attacks"],
        round_time_median=(median(cm[c["name"]]["rt"]) if cm[c["name"]]["rt"] else None),
        jury_share=share(cm[c["name"]]["slots"]), bonus_share=share(cm[c["name"]]["clus"]),
        band_bonus_share=share(cm[c["name"]]["band"])) for c in classes}
    out["rounds"] = dict(total=R_total, **outcomes, shortfall=shortfall)
    out["no_show_rate"] = sum(nocommit.values()) / max(total_slots, 1)
    out["no_show_breakdown"] = {k: v / max(total_slots, 1) for k, v in nocommit.items()}
    out["good_work"] = {k: (v / good["n"] if k != "n" and good["n"] else v) for k, v in good.items()}
    out["bad_work"] = {k: (v / bad["n"] if k != "n" and bad["n"] else v) for k, v in bad.items()}
    out["cartel_attack_rounds"] = attacks
    out["round_time"] = dict(promote_median=(median(promote_time) if promote_time else None),
                             median=(median(round_time) if round_time else None),
                             p90=(pctl(round_time, 90) if round_time else None))

    rem = {}
    for t in (COL, BIAS, NOISY, LAZY, HON):
        ids = [i for i in range(E) if types[i] == t]
        if not ids:
            continue
        hit = [first_block[i] for i in ids if first_block[i] >= 0]
        sb = [sel_before_block[i] for i in ids if first_block[i] >= 0]
        rem[TYPE_NAMES[t]] = dict(
            n=len(ids),
            ever_blocked=len(hit) / len(ids),
            blocked_or_banned_at_end=sum(1 for i in ids if is_blocked(i, R_total)) / len(ids),
            banned_at_end=sum(1 for i in ids if banned[i]) / len(ids),
            days_to_first_block_median=(median(hit) / rpd if hit else None),
            days_to_first_block_p90=(pctl(hit, 90) / rpd if hit else None),
            selections_before_block_median=(median(sb) if sb else None),
        )
    out["removal"] = rem
    nh = max(len(hon_ids), 1)
    n_slow = max(sum(1 for i in hon_ids if slow[i]), 1)
    hblocks = sum(1 for (_, i, _) in block_events if types[i] == HON)
    out["honest"] = dict(
        block_events_per_arbiter_year=hblocks / nh / years,
        frac_time_blocked=sum(hb_time) / (nh * R_total),
        frac_time_blocked_fast=hb_time[0] / (max(nh - n_slow, 1) * R_total),
        frac_time_blocked_slow=hb_time[1] / (n_slow * R_total),
        false_freezes_per_arbiter_year=false_freezes / nh / years,
        frac_time_frozen_while_up=honest_frozen_up_time / (nh * R_total),
    )
    reasons = {}
    for (_, i, why) in block_events:
        key = f"{TYPE_NAMES[types[i]]}:{why}"
        reasons[key] = reasons.get(key, 0) + 1
    out["block_reasons"] = reasons
    det = [e["removed"] - e["start"] for e in down_events if e["removed"] is not None]
    out["down"] = dict(
        events=len(down_events),
        removed_before_repair=(len(det) / len(down_events) if down_events else None),
        hours_to_removal_median=(median(det) * 24 / rpd if det else None),
        hours_to_removal_p90=(pctl(det, 90) * 24 / rpd if det else None),
        jury_slots_wasted_per_event=(sum(e["slots"] for e in down_events) / len(down_events) if down_events else None),
        node_down_events=sum(1 for e in down_events if e["mode"] == 1),
        ai_down_events=sum(1 for e in down_events if e["mode"] == 2),
    )
    out["runtime_s"] = round(time.time() - t0, 1)
    return out


# ---------------------------------------------------------------------------------------------
#  reporting
# ---------------------------------------------------------------------------------------------
def fmt(x, nd=2, pct=False):
    if x is None:
        return "-"
    return f"{100 * x:.{nd}f}%" if pct else f"{x:.{nd}f}"


def print_one(o):
    pr = o["params"]
    print(f"\n=== {pr['preset']}  rounds {pr['mix']} (K/M/N/P/Q/R:share) "
          f"shortlist {pr['shortlist']}  policy={pr['policy']} liveness={pr['liveness']}  "
          f"cartel={pr['strategy']}{'/' + pr['lever'] if pr['strategy'] == 'block' else ''}  "
          f"{pr['days']:.0f} days ({o['runtime_s']} s)")
    r = o["rounds"]
    print(f" rounds: {r['total']}  complete {r['complete'] / r['total']:.1%}  commit timeout "
          f"{r['commit_to'] / r['total']:.1%}  reveal timeout {r['reveal_to'] / r['total']:.1%}"
          f"  shortfall {r['shortfall']}")
    print(f" juror no-show {fmt(o['no_show_rate'], 2, True)} (down {fmt(o['no_show_breakdown']['down'], 2, True)}, "
          f"transient {fmt(o['no_show_breakdown']['transient'], 2, True)}, strategic "
          f"{fmt(o['no_show_breakdown']['strategic'], 2, True)})")
    rt = o["round_time"]
    print(f" commit selection {pr['commit_select']}, colluder speed {pr['col_speed']}: promotion at "
          f"{fmt(rt['promote_median'], 2)}, finalised at median {fmt(rt['median'], 2)} p90 {fmt(rt['p90'], 2)} "
          f"(median-latency units); cartel attack rounds {o['cartel_attack_rounds']}")
    g, b = o["good_work"], o["bad_work"]
    print(f" good work/round: pass {fmt(g['pass_'], 1, True)} soft {fmt(g['soft'], 1, True)} hard "
          f"{fmt(g['hard'], 2, True)} no-result {fmt(g['nores'], 1, True)}   bad work: pass "
          f"{fmt(b['pass_'], 2, True)} hard {fmt(b['hard'], 1, True)}")
    d = o["down"]
    print(f" 1) DOWN: {d['events']} events, removed before repair {fmt(d['removed_before_repair'], 0, True)}, "
          f"hours to removal median {fmt(d['hours_to_removal_median'], 1)} p90 {fmt(d['hours_to_removal_p90'], 1)}, "
          f"jury slots wasted/event {fmt(d['jury_slots_wasted_per_event'], 1)}")
    print("    type      pop   jury  jury(last¼) bonus  ever-blocked  blocked@end banned  days-to-block med/p90  sel-before-block")
    for t, v in o["removal"].items():
        print(f"    {t:<8} {o['pop_share'][t]:5.1%} {o['jury_share'][t]:6.1%} {o['jury_share_last_quarter'][t]:9.1%} "
              f"{o['bonus_share'][t]:7.1%} {v['ever_blocked']:10.0%} {v['blocked_or_banned_at_end']:11.0%} "
              f"{v['banned_at_end']:6.0%}   {fmt(v['days_to_first_block_median'], 1):>6}/"
              f"{fmt(v['days_to_first_block_p90'], 1):<6}       {fmt(v['selections_before_block_median'], 0)}")
    h = o["honest"]
    print(f" honest cost: block events/arbiter-year {h['block_events_per_arbiter_year']:.2f}, time blocked "
          f"{fmt(h['frac_time_blocked'], 2, True)} (fast {fmt(h['frac_time_blocked_fast'], 2, True)}, slow "
          f"{fmt(h['frac_time_blocked_slow'], 2, True)}), false freezes/arbiter-year "
          f"{h['false_freezes_per_arbiter_year']:.1f}, time frozen while up {fmt(h['frac_time_frozen_while_up'], 2, True)}")
    print(f" bonus share (value) if the same pool is split among everyone within --agree-z of the median: "
          f"colluder {o['band_bonus_share']['colluder']:.1%}, honest {o['band_bonus_share']['honest']:.1%}")
    if len(o["classes"]) > 1:
        print("    class (share)            rounds compl  good pass/no-result  bad pass  attacks  t-fin  "
              "colluder jury / cluster bonus / band bonus")
        for name, c in o["classes"].items():
            print(f"    {name:<16} ({c['share']:>3.0f}%) {c['rounds']:>7} {c['complete']:6.1%}  "
                  f"{fmt(c['good_work']['pass_'], 1, True):>7} / {fmt(c['good_work']['nores'], 1, True):<6}  "
                  f"{fmt(c['bad_work']['pass_'], 2, True):>7} {c['attacks']:>7}  {fmt(c['round_time_median'], 1):>5}  "
                  f"{c['jury_share']['colluder']:6.1%} / {c['bonus_share']['colluder']:5.1%} / "
                  f"{c['band_bonus_share']['colluder']:5.1%}")
    print(f" block reasons: {o['block_reasons']}")


def main():
    args = build_parser().parse_args()
    results = []
    if args.compare:
        strategies = [("mimic", "silent"), ("block", "silent"), ("block", "low"), ("block", "abstain"),
                      ("force", "silent")]
        for pre in (args.presets.split(",") if args.presets else PRESETS):
            for st, lv in strategies:
                a = build_parser().parse_args(sys.argv[1:])
                a.preset, a.strategy, a.lever = pre, st, lv
                o = run(resolve(a))
                print_one(o)
                results.append(o)
                sys.stdout.flush()
    else:
        o = run(resolve(args))
        print_one(o)
        results.append(o)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=1, default=float)


if __name__ == "__main__":
    main()
