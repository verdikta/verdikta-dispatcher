#!/usr/bin/env python3
"""
selection_randomness_risk.py - Monte Carlo risk model for manipulating a Verdikta decision through
arbiter selection, ordering and collusion, in ReputationAggregator / ReputationKeeper.

QUESTION ANSWERED
    "What is the maximum value that should hinge on one decision?"  Defined as the expected cost
    for a bad actor to obtain the outcome they want. If more than that rides on a decision, a
    rational attacker profits from manipulating it.

DECISION MODEL
    A two-outcome evaluation ("accept" likelihood 0..100) passes if the final score >= THRESHOLD.
    The attacker wants a PASS for a submission that fair arbiters usually reject. The reverse goal
    is symmetric: swap the roles of true_score and threshold.
      * Honest arbiter j reports  clip(TRUE_SCORE + b_j + eps, 0, 100)
            b_j  = persistent LEAN (bias) of arbiter j, ~ N(0, sigma_between)
            eps  = per-evaluation noise,                ~ N(0, sigma_within)
        The attacker knows each lean only approximately, as b_j + N(0, sigma_estimate), estimated
        from the arbiter's public history of scores and justifications.
      * Colluding arbiters (fraction X) report one identical score just above THRESHOLD, chosen
        for how many of them were drawn (C2).
        They need no LLM, so they commit and reveal within seconds.
    Final score = the mean of the best P-cluster (closest pair for P=2, squared distance as in
    AggregatorLib) among the first N=3 reveals. Those reveals come from the first M=4 commits among
    the K=6 polled arbiters.

    WHAT "BIAS" (LEAN) MEANS
        b_j is how far arbiter j's accept likelihood sits, on average, from the mean of all honest
        arbiters scoring the SAME submission, in points on the 0..100 scale. It is a stable
        property of the arbiter (its model, prompt, temperature, class config), not noise:
        re-running j on the same input moves its answer by eps (sd sigma_within) but not b_j.
        sigma_between is the spread of b_j across the arbiter population. To measure it from
        on-chain history: for each round, take each arbiter's residual against that round's mean;
        b_hat_j = mean residual of j; then sigma_between^2 ~= var(b_hat) - sigma_within^2 / n_j.
        The model assumes the lean is the same for every submission. It only needs to hold for the
        kind of submission under attack.

ATTACK LEVERS
    L1  Re-submit until it passes. Works under ANY randomness, including a perfect VRF.
    L2  Selection steering: choose a seed that polls colluders and/or lenient honest arbiters.
          S1 (current code): seed = keccak(entropyBuf, prevrandao, timestamp, selectionCounter, k).
              On Base these are all known before inclusion (prevrandao = L1-origin RANDAO,
              timestamp = parent + 2s, the rest public storage), so a submitter can predict the
              draw and wait for a good one. A builder can re-roll it (delay, reorder, perturb
              blockhash, which feeds rollingEntropy).
          S2 (hash-chain beacon): the 4 providers are picked with S1 randomness; the first
              responder's next chain value h, mixed with block entropy, seeds the K-arbiter draw.
              - colluding providers know their h: they answer only if favorable (otherwise stay
                silent and let an honest h win). With RESPONSE-block entropy they also get one
                re-roll per block until the first honest provider lands;
              - a submitter can grind stage 1 to pull colluding providers into the 4;
              - with REQUEST-block entropy, a submitter colluding with a provider can predict and
                grind the final seed outright;
              - a builder grinds stage 1 and, seeing pending beacon responses in the private
                mempool, picks which h lands first (re-rolling each if response-block entropy).
          S3 (two-phase request, TODO item 9): the request commits in block B; anyone draws the
              jury from block B+2 on, with seed = keccak(aggId, blockhash(B+1)) and selection
              state checkpointed at B. Nobody knows the seed when the request is signed, and who
              draws, or when, cannot change it. Only the sequencer, which builds B+1, can steer it.
          S4 (two-phase + first two of 4 beacons): as S3, but blockhash(B+1) also assigns the
              beacons, and the seed mixes the first two beacon values to land after B+1. Two
              colluding beacons can race in with a pair they computed in advance; one can pair
              with the first honest value once it is on-chain; the sequencer can pick which two
              of the pending reveals land first.
    L3  Ordering (builder only; identical in S1, S2 and S3). The builder holds fulfill txs to choose
        which 4 commits get reveal requests (colluders first, then most lenient), then sees the
        PLAINTEXT reveals and chooses which 3 land first, i.e. which cluster forms.
    L4  Denial (builder only): censor fulfill txs past responseTimeoutSeconds, so the round fails
        and refunds. This forces "no decision" with certainty in both scenarios.

METRICS
    Submitter (can retry):    E[cost to force] = cost per attempt / P(pass per attempt)
    Outsider vs one request:  break-even V* = bribe / (P_with_bribe - P_without_bribe).
                              Capture WITHOUT spending (colluders selected by luck) has no value
                              bound; only reducing X addresses it.
    Max safe value = the minimum over all applicable strategies.

Pure standard library.  Edit Params below, or override from the CLI:
    python3 selection_randomness_risk.py --x 0 --sigma-between 7 --sigma-within 5 --z 5000
Measured inputs: scripts/arbiter-stats.js (collect / poll / analyze) writes a JSON file of Params
values estimated from on-chain arbiter behavior; load it with --params-json FILE (explicit CLI
flags still override it).
"""

# =====================================================================================
#                              MODEL ASSUMPTIONS (READ BEFORE EDITING)
# =====================================================================================
# This block lists everything the model assumes, so the script can be checked against
# the contracts and updated as they change. Each item names the code or Params field that
# implements it. Contract references are to reputationBasedAggregator/contracts/ as of
# Nov 2026: ReputationAggregator.sol (RA), ReputationKeeper.sol (RK), AggregatorLib.sol (AL).
#
# A. ATTACKER, GOAL AND OUTCOME
#   A1. One economically unified attacker. The submitter, the cartel of colluding arbiters /
#       beacon providers, and any bribed builder act as one party with one goal. Fees paid to
#       colluding arbiters or providers count as internal transfers, not costs.
#   A2. The goal is a PASS for one submission whose fair (all-honest) pass rate is low.
#       true_score < threshold sets this up. The reverse goal (force a FAIL) is symmetric and
#       is modelled by swapping the two. Forcing "no decision" is L4 (denial); it is described
#       but not simulated.
#   A3. Two-outcome decision only. The likelihood vector is [reject, accept] with
#       accept = s and reject = 100 - s, so AL.calculateDistance (sum of squared differences)
#       is 2*(ds)^2 and finding the closest pair in 1-D is equivalent. Vectors with more than
#       two outcomes are not modelled.
#   A4. Pass rule: cluster mean >= threshold, on a continuous scale. BountyEscrow._scoreVector
#       computes accept = scores[1] / SCORE_DIVISOR (integer division) and tests >= threshold;
#       integer truncation and the 1e18-ish fixed-point scale are ignored.
#   A5. "Success" means the final aggregated score passes. Partial influence (moving the score
#       without crossing the threshold) has no value to the attacker.
#   A6. Every result is for ONE submission, described by two inputs:
#         threshold  (Params.threshold, --threshold, default 90): the pass bar on the 0..100
#                    accept scale. In the bounty program this is the bounty's `threshold`;
#                    90 is the most common choice.
#         true_score (Params.true_score, --true, default 80): the NOMINAL value, i.e. the
#                    accept score the honest arbiter population typically gives this submission
#                    (each arbiter then adds its lean and per-round noise, B1). Under the model's
#                    normal noise the mean and the typical (median) answer coincide; on real data
#                    they do not, and the median is the one to use (see N3).
#       The defaults describe a submission that fair arbiters clearly but not overwhelmingly
#       reject (10 points below the bar). The results are driven mainly by the gap
#       (threshold - true_score) relative to the spreads: about sigma_within for re-submission
#       and ordering, and about sqrt(sigma_between^2 + sigma_within^2) for selection
#       steering. A small gap (a borderline submission) gives a much lower safe value; a large
#       gap gives a much higher one. Colluders' report is also tied to the threshold (C2).
#       To bound the risk for a class of decisions, run the gap that the attacker would
#       actually choose to contest, usually the closest-to-passing bad submissions, not the
#       average one.
#
# B. HONEST ARBITERS AND BIAS ("LEAN")
#   B1. Honest score = clip(true_score + lean_j + eps, 0, 100). Network.lean, Sim.play.
#   B2. lean_j ~ N(0, sigma_between) is drawn once per arbiter per simulated network and is
#       the SAME for every round and every submission (no dependence on submission type).
#   B3. eps ~ N(0, sigma_within) is independent per arbiter per round. No correlated noise:
#       in reality arbiters on the same model family may err together, which would make
#       honest clusters more predictable than modelled.
#   B4. Lean is defined relative to the honest-population mean on the same submission.
#       true_score is that mean, so the population of leans is centered at 0.
#   B5. The attacker knows every arbiter's lean with independent error N(0, sigma_estimate)
#       (Network.est), e.g. from public score history. The builder uses the same estimates.
#   B6. Honest arbiters never reveal invalid or malformed data, never collude, and do not
#       react to manipulation.
#   B7. Measuring B1-B5: scripts/arbiter-stats.js fits
#           score = mu_s + b_j + g_js + e_jsr     (g_js = lean that varies by submission)
#       and maps it onto this model as:
#           sigma_within   = sd(e)            (run-to-run noise on repeated identical requests)
#           sigma_between  = sqrt(sd(b)^2 + sd(g)^2)   (the lean that applies to ONE submission)
#           sigma_estimate = sqrt(sd(g)^2 + typical se(b_hat)^2)  (error predicting that lean)
#       Separating e from g needs repeated requests for the same submission ("poll"). Without
#       them, sigma_within = the residual sd, which also contains g.
#
# C. COLLUDING ARBITERS (X)
#   C1. n_c = round(x_colluding_oracles * eligible_oracles), clipped to [0, eligible]. Colluders
#       are indices < n_c. With the default 300 eligible, X = 3% gives 9 colluders. The rounding
#       matters for small pools: with 30 eligible, X = 3% gives 1 colluder and X = 5% gives 2,
#       and one colluder is far weaker than two (C2).
#   C2. Every colluder reports the same score, fixed at commit (RA.fulfill checks
#       sha256(sender, response, salt)). The draw is on-chain before anyone commits, so the
#       cartel knows how many of its members (c) were polled and picks the score by c.
#       colluder_report_rule = "best" (default): for each c < P, the margin over threshold
#       (0..10 in 0.5 steps) that maximises P(pass) against simulated honest scores
#       (best_colluder_margins). With c >= P any score >= threshold wins, and
#       threshold + colluder_report_margin is used. "fixed": always threshold +
#       colluder_report_margin. A lower score sits closer to the honest scores, so c < P
#       colluders plus the most lenient honest reveals can still form the best cluster and pass:
#       with P = 4, 3 colluders win when the 4 honest counted reveals happen to be spread out.
#       P colluders in the counted reveals are at distance 0 and always form the cluster.
#   C3. Colluders never no-show, always pass the hash check, and respond with the
#       colluder_* latencies (seconds), which are much faster than honest arbiters' because they
#       skip the LLM.
#   C4. Colluder selection weight = the same reputation distribution as honest arbiters, times
#       colluder_weight_multiplier. Colluders' own leans matter only in the "fair" reference,
#       where they behave honestly.
#   C5. Cartel setup cost, staking (RK.STAKE_REQUIREMENT, refundable; slashAmountConfig = 0),
#       and reputation gains or penalties from attacking are all ignored (treated as sunk / 0).
#   C6. Colluding beacon providers are the same population as arbiters (same X), selected by
#       the same weighted algorithm (Network.prov).
#
# D. ARBITER SELECTION (mirrors RK.selectOracles / _weightedSelect)
#   D1. select_oracles(): a uniform shortlist of shortlist_size when the eligible pool is
#       larger; then weighted draws WITHOUT replacement for min(k, shortlist) picks; then
#       weighted draws WITH replacement only if k exceeds the shortlist (RK duplicate pass).
#   D2. Weight = reputation drawn uniformly in [min_score_for_selection,
#       max_score_for_selection] (the clamp range in RK.getSelectionScore). Fee weighting
#       (feeWeightingFactor) is taken as 1 for everyone: all arbiters charge the same fee and
#       the selection parameters are agreed and fixed. Weight steering through request
#       parameters is deliberately out of scope.
#   D3. Weights stay fixed within a simulated network. Reputation dynamics across rounds are
#       not modelled (clustered +60, selected-but-not-clustered -60, blocking/slashing), even
#       though successful attacks would raise colluders' weight over time.
#   D4. A "seed" is an independent uniform draw of the selection. Every distinct seed (block,
#       timestamp, selectionCounter, entropyBuf, beacon value, blockhash perturbation) yields
#       an independent selection (keccak behaves as a random oracle).
#   D5. eligible_oracles means arbiters that are active, unblocked, fee-eligible and serve the
#       requested class. Other classes are irrelevant. The default, 300, is a PLANNING value for
#       a grown network (set 2026-11-06), not a measurement: the mainnet registry had 32
#       arbiters on 2026-11-03 (N6). Set it with --eligible. Above shortlist_size, each poll
#       slot draws from a uniform shortlist of 20, so a colluder's chance per slot is about X
#       regardless of the pool size; the pool size matters through the rounding in C1.
#
# E. COMMIT / REVEAL RACE AND CLUSTERING (mirrors RA)
#   E1. K arbiters are polled. Each honest arbiter no-shows independently with
#       honest_no_show_prob at commit, and again at reveal. Latencies are lognormal (median,
#       sigma) in seconds.
#   E2. The first M commits (by arrival time) get reveal requests, dispatched at the M-th
#       commit time (RA._dispatchRevealRequests). Fewer than M commits means the round fails
#       (commit-phase timeout).
#   E3. Reveal arrival = M-th commit time + reveal latency. The first N reveals are aggregated
#       (RA "selected" = first N). Fewer than N reveals means failure.
#   E4. One whole-round timeout (response_timeout_s) measured from the request; it is not
#       reset at commit->reveal (RA.startTimestamp). Anything later is lost.
#   E5. Clustering (cluster_rule). Default "best_subset" = TRUE clustering (TODO item 10): the
#       P-member subset of the counted reveals with the smallest total pairwise squared distance,
#       first in reveal order on ties. "greedy" = today's AL.findBestCluster: the closest pair,
#       then greedy addition up to P. For P = 2 the two are identical. Final = mean of the
#       cluster. best_cluster().
#   E6. Not modelled: modal-length normalization, invalid-format or hash-mismatch reveals,
#       MAX_ARBITER_RETURN_SCORE clamping, and late commits after the M-th (they are ignored,
#       as in RA).
#
# F. ATTACKER'S PREDICTOR (how every grinding / withholding decision is made)
#   F1. Network.predict(sel): if the selection has >= P colluders, predicted pass = 1 (if the
#       report >= threshold). Otherwise it assumes colluders are always among the counted N
#       reveals, takes the remaining counted reveals as a uniformly random subset of the polled
#       honest arbiters, uses estimated leans with no noise, and scores each subset as
#       Phi((cluster_mean - threshold) / pred_sd), where pred_sd = sqrt((sigma_within^2 +
#       sigma_estimate^2) / 2). No-shows are ignored. This is a heuristic: a smarter attacker
#       could do somewhat better, so results are a slight LOWER bound on attacker power.
#   F2. Grinding is "best of n seeds by predicted pass". It is implemented as an order statistic
#       (with replacement) over a finite per-network pool of selection_pool pre-drawn
#       selections (Network.best_of). For n much larger than the pool, the result saturates at
#       the pool's best. Raise selection_pool if you raise the grind counts.
#   F3. Withholding rule (beacon): a colluding provider uses its own value if the best of its
#       options has predicted pass > the pool-average predicted pass, or if no honest provider
#       responds. Otherwise it stays silent and the first honest value decides.
#
# G. SCENARIO S1: CURRENT CODE
#   G1. On Base (OP stack) every seed input is known before inclusion: prevrandao = the
#       L1-origin RANDAO, timestamp = parent + block_time_s, and entropyBuf / selectionCounter
#       are public storage. The shortlist seed (RK line ~504) uses only timestamp + prevrandao.
#   G2. Submitter: one fresh independent seed per block (~1 per block_time_s). It waits
#       through T draws (submitter_grind_options) and submits the best. It may verify in-tx
#       with a wrapper costing selection_check_gas per draw (conservative; simulating off-chain
#       costs nothing). Waiting time has no cost.
#   G3. Builder: builder_grind_options independent seeds per manipulated block (delaying,
#       reordering requests to shift selectionCounter, perturbing blockhash that feeds
#       rollingEntropy -> entropyBuf). One bribe Z covers it.
#
# H. SCENARIO S2: HASH-CHAIN BEACON
#   H1. The beacon_providers (4) providers are chosen with S1 randomness (so stage 1 is
#       predictable and grindable). The first valid response wins and is paid
#       beacon_fee_multiplier x base fee. Seed = H(h, block entropy).
#   H2. Hash chains: the next value is unknown to everyone but its holder and is fixed (it can't
#       be ground). Verification is assumed correct and free apart from beacon_gas.
#   H3. Not responding carries NO penalty (withholding is free). Adding a penalty changes F3.
#   H4. beacon_seed_uses_response_block = True: entropy comes from the block the response lands
#       in, so a responder or builder gets one independent re-roll per block it can choose.
#       False: entropy is fixed at the request block, so whoever knows h at request time (a
#       colluding provider and its submitter) can predict, and grind, the final seed.
#   H5. Honest provider latency is lognormal (honest_provider_*), converted to blocks
#       (ceil, minimum 1), with independent no-shows. A colluder can land in any block up to
#       and INCLUDING the first honest provider's block (it wins same-block ordering by priority
#       fee). If no honest provider answers, colluders have beacon_timeout_blocks of re-rolls.
#       If nobody answers, no round happens.
#   H6. Colluding providers coordinate: their options pool together (cp x re-rolls).
#   H7. Submitter stage-1 grind: redraw (cost selection_check_gas each) until >= t colluding
#       providers are among the 4, then they play F3. Expected draws = 1 / P(cp >= t).
#   H8. Joint grind (request-block seed only, X > 0): T draws give ~T x E[cp] favorable-seed
#       candidates, the best is used, and the colluding provider then answers first.
#   H9. Builder: grinds stage 1 (best of builder_grind_options provider draws, by colluder
#       count), knows colluders' h, and if builder_sees_pending_txs it sees honest providers'
#       h for responses arriving within builder_max_hold_s. Options = cp x G + visible x
#       (G if response-block entropy else 1). Colluder values get G re-rolls even with
#       request-block entropy, because the builder knows them at request time and can grind
#       the request block.
#   H10. Beacon cost to a submitter-attacker = fee x multiplier x (1 - X) (expected share
#       paid to an honest responder) + beacon_gas.
#
# H'. SCENARIO S3: TWO-PHASE REQUEST (TODO item 9)
#   H'1. Commit in block B, draw from B+2 on, seed = keccak(aggId, blockhash(B+1)). The draw
#       reads selection state checkpointed at B and no block.* values, so it is a pure function
#       of the seed. The submitter therefore faces an unbiased seed: its rounds are the s1_free
#       rounds (random selection, natural order).
#   H'2. Abandoning a bad draw buys nothing: the round never expires before it is drawn, and
#       anyone may draw it after 30 s for the 2 x fee reward. Not modelled as a row.
#   H'3. The 2 x fee trigger reward is escrowed and credited back to the requester when it draws
#       its own round (or when its colluders do), so it is not a cost to a submitter-attacker.
#   H'4. The sequencer builds B+1 after seeing the commit and can grind blockhash(B+1)
#       (reorder, include or exclude txs): builder_grind_options seeds for one bribe Z, the
#       same as the S1 builder grind. Ordering (L3) and denial (L4) are unchanged.
#   H'5. Extra cost per attempt: two_phase_extra_gas (second tx, seed seal, checkpoint lookups).
#       The selection gas itself moves from the request to the draw tx.
#
# H''. SCENARIO S4: TWO-PHASE + FIRST TWO OF beacon_providers BEACONS
#   H''1. Commit in block B. blockhash(B+1) assigns beacon_providers beacons (Network.prov, the
#       same pool as S2). seed = H(aggId, blockhash(B+1), v_first, v_second): the first two beacon
#       values included after B+1. No deadline or substitute; fewer than two values means no round.
#   H''2. Honest beacons reveal as soon as they can (provider_blocks). Colluders reveal at will
#       and win same-block ordering by priority fee (as H5). Their informed options
#       (first_two_options): every colluder-only pair (known before anyone reveals, raced in
#       first); a colluder paired with the first honest value, if that value lands at least one
#       block before the second honest one (or is the only honest one); and abstaining, which
#       leaves the first two honest values. The best option by predicted pass is used.
#   H''3. Not responding is indistinguishable from being slow, so no penalty is possible here.
#   H''4. Sequencer: tries builder_grind_options versions of B+1. Every version that assigns
#       cp >= 2 colluding beacons gives C(cp, 2) seeds it can compute before building (colluder-
#       only pairs, which it then orders first). If none of those passes, it builds the version
#       with the most colluding beacons (as in S2's H9), sees the pending honest reveals, and can
#       hold them up to builder_max_hold_s. It then picks any pair among the colluders and the
#       honest reveals that arrive within the hold window of the first one, knowing every value:
#       C(available, 2) more options (first_two_builder_options). Total options = the sum of both.
#   H''5. Cost per attempt = S3's + 2 x beacon_usd (only the first two beacons are paid).
#       Ordering (L3) and denial (L4) are unchanged.
#
# I. BUILDER / ORDERING (L3) AND DENIAL (L4)
#   I1. A bribed builder can delay any fulfill tx by up to builder_max_hold_s without being
#       noticed, and never past the round timeout. It cannot drop txs permanently, except in
#       L4.
#   I2. Commit ordering: among commits arriving by (M-th commit + hold) it promotes
#       colluders first, then the highest estimated leans. Commit contents are hidden, but the
#       sender is known.
#   I3. Reveal ordering: reveals are PLAINTEXT in the (private) mempool. Among reveals arriving
#       by (N-th reveal + hold) it chooses the N-subset with the highest cluster mean.
#   I4. single_sequencer = True (Base today): one builder builds every relevant block, one
#       bribe Z covers all of them, and availability = Y. False: S2 needs 2 blocks (provider
#       selection + beacon response), so the bribe is 2Z and availability is Y^2.
#   I5. Y does not affect the outsider break-even V* (the attacker only pays when a builder is
#       corruptible). It affects the "capture above break-even" probability only.
#   I6. L4 denial: a sequencer censoring the aggregator for response_timeout_s is assumed
#       feasible (OP-stack forced inclusion via L1 takes far longer). It is reported, not
#       simulated.
#
# J. COSTS
#   J1. Base fee per arbiter = oracle_fee_eth x eth_usd, the same for all. It is credited for
#       every HONEST polled slot at request time, even on no-shows (RA._pollOracle). The bonus,
#       B x fee per HONEST cluster member, is paid only if the round finalizes. Colluders' fees
#       are internal (A1). The unspent-escrow refund returns to the submitter and is not a cost.
#   J2. Gas = gas x gas_price_gwei x eth_usd. L1 data fees, gas spikes and priority fees are
#       ignored.
#   J3. Submitter cost per attempt = request fees + gas (+ beacon) (+ grind checks) (+ bribe).
#       Attempts are unlimited and independent. Each attempt is a fresh draw from the same
#       network, averaged over networks. No deposit or forfeiture beyond fees (add one here if
#       a bounty requires it).
#   J4. Outsider cost = bribe only. Capture without spending (colluders selected by luck) has
#       no value bound.
#
# K. METRICS
#   K1. Submitter: E[cost to force] = cost per attempt / P(pass per attempt) (geometric
#       retries).
#   K2. Outsider: V* = bribe / (P_with_bribe - P_free_in_that_scenario). The attack is
#       profitable when V > V*.
#   K3. Headline "max value that should hinge on the decision" = the minimum over every row of
#       that scenario (submitter and outsider).
#   K4. "fair" = everyone honest, unbiased seed, natural order. "norace" = colluders lose the
#       speed advantage (honest latencies). It approximates choosing the reveal set without
#       using arrival order; it does NOT implement a deadline-plus-random-subset protocol.
#   K5. Ideal RNG (VRF) is the S1 no-manipulation row (s1_free). With a perfect seed, only
#       re-submission and luck remain.
#   K6. S3 reuses the S1 rounds: s1_free for the submitter, s1_seed / s1_order / s1_all for the
#       builder. Its headline is min(ideal re-submit bound + extra gas, builder rows).
#   K7. S4 draws its rounds from a separate RNG stream (rng_seed + 5), so adding it leaves the
#       S1-S3 numbers unchanged.
#
# L. MONTE CARLO
#   L1. networks x evals_per_network rounds per strategy. A fixed rng_seed makes runs
#       reproducible. Every strategy shares the networks but draws its own rounds, so
#       differences between rows include sampling noise (about +/- 0.5 percentage points at
#       defaults). Pass rates under ~1% are noisy, especially in the reduced-size sweep. Use
#       --scale to trade runtime for precision.
#   L2. --scale multiplies networks, evals and selection_pool (with floors). sweep_scale
#       applies on top for the sweep.
#
# L'. BROAD THRESHOLD (pass_rule = "broad", TODO item 11)
#   L'1. Pass = at least Q (quota, default P) of the N counted reveals are >= threshold. The
#       cluster is still formed, but only decides the bonus. Consumers apply this with
#       getOutcomeScores; it does not exist on-chain yet.
#   L'2. Colluders report threshold + colluder_report_margin. Any score >= threshold counts the
#       same, so the "best" report rule (C2) does not apply.
#   L'3. Predictor (F1): 1 if c >= Q. Otherwise each polled honest arbiter is counted with
#       probability (N - c) / honest polled, and the chance of Q - c honest passes comes from a
#       Poisson-binomial over estimated leans.
#   L'4. A bribed builder choosing reveals (I3) keeps the N highest scores it can see.
#   L'5. --config-search does not use Monte Carlo: pass rates near 1e-5 are far below what
#       networks x evals can resolve, and F2's selection pool saturates. broad_config_eval is exact
#       under these simplifications:
#         - c ~ Hypergeometric(eligible, n_c, K). Exact when colluder_weight_multiplier = 1, because
#           the shortlist is uniform and weights do not depend on being a colluder (averaged over
#           networks). Other multipliers are not supported.
#         - Colluders always win the commit and reveal races (slightly favours the attacker).
#         - Honest scores are independent N(true_score, sigma_between^2 + sigma_within^2).
#         - Attacker's gas stays at request_gas (a floor for large K, favouring the attacker). The
#           honest requester's bill scales it by K / 6 (a ceiling).
#         - S3 only: a re-submit bound, and a bribed sequencer taking the best of
#           builder_grind_options seeds by colluder count. Ordering-only (L3) is ignored; at these
#           gaps it adds almost nothing, which the Monte Carlo cross-check confirms.
#   L'6. Blocking. Q above a majority makes a false FAIL easier: N - Q + 1 counted colluders block a
#       pass, and colluders can also withhold when K - c < M. "attacked pass" is a good
#       submission's pass rate when colluders do whichever is worse per draw. A block costs the
#       hunter a retry; it is not a theft by itself, so it is reported and only loosely constrained.
#       "hunter $" = total fee / attacked pass, the expected spend for a good submission to get through
#       a cartel that blocks every round (geometric retries). Deadlines and competing hunters are ignored.
#
# M. WHAT TO UPDATE WHEN THE CONTRACTS CHANGE
#   - Selection algorithm, shortlist, weights, fee factor -> select_oracles(), Network.__init__.
#   - K/M/N/P, bonus, timeout, fee accounting              -> Params, Sim.play cost lines.
#   - Clustering / aggregation                            -> best_cluster(), Sim.play, predict().
#   - Seed construction / entropy sources                 -> sections G/H and the grind counts.
#   - Reveal-set rule (e.g. deadline + random subset)     -> Sim.play ordering and builder logic.
#   - Beacon design (penalties, all-provider XOR, VRF)    -> beacon_withhold(), beacon_builder().
#   - Two-phase request (item 9)                          -> section H', S3 rows in build().
#   - Two-phase + first two beacons                       -> section H'', first_two_*options(), S4 rows.
#   - Pass rule in an integrating contract                -> A4 and the final comparison in play().
#   - Arbiter software / models change                    -> re-measure N2 and N3 (arbiter-noise.js).
#
# N. MEASURED INPUTS (PROVENANCE)
#   Defaults marked MEASURED in Params come from Verdikta's production history. Everything
#   else in Params is an assumption or a contract setting, as described in sections A-L.
#   N1. Source. Base mainnet ETH ReputationAggregator 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a,
#       blocks 47087827 (deployment) .. 53472663, collected 2026-11-03: 761 rounds, 3,044 reveal
#       requests, 3,027 reveals recovered (2,268 counted by the aggregator, plus the late 4th
#       reveals it rejected, recovered from operator calldata). All 3,027 matched their commit
#       hash. 755 rounds have 4 reveals. Tool: scripts/arbiter-noise.js (method in its header).
#   N2. sigma_between = 0.0. The 19 arbiters with >= 10 reveals show no persistent offset from
#       their peers: implied lean sd 0.00 points, 0 arbiters beyond 3 standard errors (0.1
#       expected by chance). This is consistent with every arbiter running the same code. Revisit
#       if arbiters diverge (different models, prompts or versions).
#   N3. sigma_within = 3.0 is a TARGET, not a measurement (set 2026-11-06): Verdikta's goal for
#       per-arbiter noise is round SD <= 4, and the planning default is 3. Over the 30 days to 2026-11-06 the bounty site's
#       "Pooled SD, outliers excluded" (the clustered pair plus the third counted reveal unless
#       it is more than 15 points from the pair's mean; example-bounty-program
#       server/utils/scoreSpread.js clusteredSpread) was 2.8, so 3 is within reach. That figure
#       is not the same quantity as this model's normal sd: real noise is heavy-tailed, which is
#       why the calibrated normal-sd equivalent below is 7.1. A target of 3 assumes the tail is
#       gone, i.e. the network behaves like normal noise with sd 3. With
#       --sigma-within 7.1 the script reproduces the calibrated measurement below.
#       Measured value (2026-11-03): sigma_within = 7.1 for nominal 80 / threshold 90. The 64 rounds whose MEDIAN accept share
#       was within 80 +/- 5 were re-centered on 80 and run through the aggregator's closest-pair
#       rule, giving an empirical honest pass rate of 3.9% (95% interval 1.2-11.8%). Normal
#       noise reproduces 3.9% at sd 7.1 (the interval maps to sd ~5.7-10.2). 7.1 is therefore a
#       CALIBRATED value, chosen so this model's normal noise gives the real pass rate at 80/90.
#       It is not the raw spread:
#         - pooled sd of those 64 rounds: 10.7; of all 758 rounds: 10.3 (robust, median-based: 1.8);
#         - the noise is heavy-tailed: most rounds agree within ~1-2 points, and ~23% disagree,
#           mostly as one outlier far from the other three, which the closest-pair rule
#           discards;
#         - noise depends on the score level (pooled sd by round mean: 0-10: 2.7, 10-30: 21.0,
#           30-70: 17.2, 70-90: 10.7, 90-100: 1.3).
#       For a different nominal/threshold, RECALIBRATE instead of reusing 7.1:
#           node scripts/arbiter-noise.js analyze --data <noise-data.json> --nominal N --threshold T
#       and use its "normal-sd equivalent" (median row) as --sigma-within.
#       Centering on the round MEAN instead gives 25.9% (sd-equivalent 16.5), because a low
#       outlier drags the mean below where the cluster lands. Do not use it as the nominal.
#   N4. Reproduce (read-only, about 4 minutes):
#           HARDHAT_NETWORK=base node scripts/arbiter-noise.js collect \
#               --aggregator 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a --from-block 47087827 \
#               --to-block 53472663 --chunk 50000 --out noise-data.json
#           node scripts/arbiter-noise.js analyze --data noise-data.json --nominal 80 --threshold 90
#       The raw data file is not committed; collecting again over the same blocks reproduces it.
#   N5. Not yet measured, still assumptions: latency and no-show parameters (E), eligible pool
#       size and weights (D), X / Y / Z, the builder parameters, and selection_check_gas /
#       beacon_gas. Use scripts/arbiter-stats.js (collect + analyze --params-out) for the race and
#       pool values.
#   N6. Economics (eth_usd, oracle_fee_eth, gas_price_gwei, request_gas), read 2026-11-03 from the
#       same aggregator over the same blocks (N1):
#         - The base fee charged is the ARBITER'S REGISTERED fee (ReputationKeeper.getOracleInfo
#           -> RA._pollOracle credits that amount). The caller's _maxOracleFee, clamped to
#           maxOracleFee = 0.0004 ETH, only filters eligibility and sizes the escrow; the unspent
#           remainder is refunded. There is no minimum payment today.
#         - Registry: 31 of 32 arbiters registered at 0.00002 ETH, 1 at 0.0001 ETH.
#         - BasePayment events: 5,003 at 0.00002 ETH and 37 at 0.0001 ETH (5,040 total).
#           BonusPayment events: 1,496 at 0.00006 ETH (3x) and 12 at 0.0003 ETH.
#         - Request tx, median of the last 60: 3.30M gas at 0.006 gwei = 0.00002 ETH; the OP-stack
#           L1 data fee is ~1e-9 ETH (negligible).
#         - ETH/USD 2,287.11 from the Chainlink feed 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70.
#       So one attempt costs the submitter about 6 x $0.046 base + 2 x $0.137 bonus + $0.046 gas
#       = $0.59. Re-submission bounds scale linearly with this. Update these four values when a
#       minimum payment is introduced, or when fees or the ETH price move.
# =====================================================================================

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass, replace
from itertools import combinations


# =====================================================================================
#                                     PARAMETERS
# =====================================================================================
@dataclass
class Params:
    # ---------------- Headline knobs ----------------
    x_colluding_oracles: float = 0.03     # X: fraction of ELIGIBLE arbiters in the cartel (300 x 3% = 9, C1)
    y_colluding_builders: float = 0.05    # Y: fraction of builders / sequencers that take bribes
    z_builder_bribe_usd: float = 1_000.0  # Z: bribe per manipulated block

    # ---------------- Decision & honest-arbiter heterogeneity ----------------
    # Defaults below are MEASURED on Base mainnet where noted; see section N for provenance.
    true_score: float = 80.0              # nominal: typical honest "accept" answer for this submission
    threshold: float = 90.0               # pass if final >= threshold (90 is the common bounty bar)
    sigma_between: float = 0.0            # sd of persistent per-arbiter lean b_j. MEASURED: 0.00 (N2)
    sigma_within: float = 3.0             # sd of run-to-run noise. TARGET (N3); calibrated measurement was 7.1
    sigma_estimate: float = 3.0           # attacker's error estimating each b_j (moot while sigma_between = 0)
    colluder_report_margin: float = 5.0   # colluders report threshold + this ("fixed", or c >= P)
    colluder_report_rule: str = "best"    # "best": margin chosen per colluder count to maximise P(pass) (C2)

    # ---------------- Arbiter pool ----------------
    eligible_oracles: int = 300           # active, unblocked, fee-eligible arbiters for the class. PLANNING value (D5)
    colluder_weight_multiplier: float = 1.0
    min_score_for_selection: float = 60   # selection weight = reputation clamped to [min, max],
    max_score_for_selection: float = 6000  # drawn uniformly per arbiter

    # ---------------- Protocol (contract defaults) ----------------
    k_commit_poll: int = 6
    m_reveal: int = 4
    n_required: int = 3
    p_cluster: int = 2
    cluster_rule: str = "best_subset"     # TRUE clustering (TODO item 10); "greedy" = current AggregatorLib
    pass_rule: str = "cluster_mean"       # "broad": at least quota of N counted reveals >= threshold (L')
    quota: int = 0                      # Q for pass_rule "broad"; 0 means Q = P
    bonus_multiplier: int = 3
    shortlist_size: int = 20
    response_timeout_s: float = 300.0

    # ---------------- Proposed beacon (S2) ----------------
    beacon_providers: int = 4
    beacon_fee_multiplier: float = 1.0
    beacon_seed_uses_response_block: bool = True  # False = entropy fixed at the request block
    beacon_timeout_blocks: int = 60

    # ---------------- Chain / builder ----------------
    block_time_s: float = 2.0
    single_sequencer: bool = True         # Base: one bribe covers every block involved
    builder_grind_options: int = 256      # seeds a colluding builder can try
    builder_max_hold_s: float = 20.0      # how long it holds a fulfill tx without looking suspicious
    builder_sees_pending_txs: bool = True  # private mempool visible to the sequencer

    # ---------------- Submitter ----------------
    submitter_grind_options: tuple = (1, 4, 16, 64, 256)  # draws it will wait through (~1 per block)

    # ---------------- Economics (MEASURED on Base mainnet, see N6) ----------------
    eth_usd: float = 2_287.0              # Chainlink ETH/USD on Base, 2026-11-03
    oracle_fee_eth: float = 0.00002       # registered fee of 31/32 arbiters = BasePayment amount actually credited
    gas_price_gwei: float = 0.006         # median effective gas price of recent request txs
    request_gas: int = 3_300_000          # median gasUsed of requestAIEvaluationWithApproval (L1 data fee ~0)
    two_phase_extra_gas: int = 150_000    # S3 estimate: 2nd tx + seed seal + checkpoint lookups
    selection_check_gas: int = 400_000    # in-tx selection recompute by a wrapper (0 if simulated off-chain)
    beacon_gas: int = 250_000

    # ---------------- Latency ----------------
    honest_commit_median_s: float = 30.0
    honest_reveal_median_s: float = 6.0
    honest_latency_sigma: float = 0.6
    honest_no_show_prob: float = 0.05
    colluder_commit_median_s: float = 3.0
    colluder_reveal_median_s: float = 3.0
    colluder_latency_sigma: float = 0.3
    honest_provider_median_s: float = 4.0
    honest_provider_sigma: float = 0.5
    honest_provider_no_show_prob: float = 0.05

    # ---------------- Monte Carlo ----------------
    networks: int = 250                   # independent arbiter populations (leans, weights)
    selection_pool: int = 800             # random K-selections pre-drawn per network
    evals_per_network: int = 40           # rounds simulated per network per strategy
    rng_seed: int = 12345
    sweep_x: tuple = (0.0, 0.03, 0.05, 0.10, 0.20)
    sweep_sigma_between: tuple = (0.0, 3.0, 7.0, 12.0)
    sweep_scale: float = 0.25


# =====================================================================================
#                                     PRIMITIVES
# =====================================================================================
def lognorm(rng, median, sigma):
    return rng.lognormvariate(math.log(median), sigma)


def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def select_oracles(weights, k, shortlist_size, rng):
    """Mirror of ReputationKeeper.selectOracles + _weightedSelect for one seed: a uniform shortlist,
    then weighted draws without replacement, then duplicates only if k exceeds the shortlist."""
    n = len(weights)
    idx = rng.sample(range(n), shortlist_size) if n > shortlist_size else list(range(n))
    w = [weights[i] for i in idx]
    total = sum(w)
    taken = [False] * len(idx)
    out = []
    for _ in range(min(k, len(idx))):
        pivot = rng.random() * total
        acc, pick = 0.0, None
        for j, wj in enumerate(w):
            if taken[j]:
                continue
            pick = j
            acc += wj
            if acc > pivot:
                break
        out.append(idx[pick])
        taken[pick] = True
        total -= w[pick]
    while len(out) < k:
        out.append(rng.choices(idx, weights=w)[0])
    return out


def best_cluster(vals, P, rule="best_subset"):
    """Cluster of P members among 1-D scores; returns indices.
    best_subset (default, TODO item 10): the P-subset with the smallest total pairwise squared
        distance; the first subset in reveal order wins ties.
    greedy (AggregatorLib.findBestCluster today): closest pair (first found wins ties), then add the
        point with the smallest summed distance until the cluster has P members.
    For P = 2 both return the closest pair."""
    P = min(P, len(vals))
    if rule == "best_subset":
        best, members = None, None
        for sub in combinations(range(len(vals)), P):
            d = sum((vals[i] - vals[j]) ** 2 for i, j in combinations(sub, 2))
            if best is None or d < best:
                best, members = d, list(sub)
        return members
    if rule != "greedy":
        raise ValueError(f"unknown cluster_rule {rule!r}")
    best, pair = None, (0, 1)
    for i in range(len(vals) - 1):
        for j in range(i + 1, len(vals)):
            d = (vals[i] - vals[j]) ** 2
            if best is None or d < best:
                best, pair = d, (i, j)
    members = list(pair)
    while len(members) < P:
        cand = min((i for i in range(len(vals)) if i not in members),
                   key=lambda i: sum((vals[i] - vals[k]) ** 2 for k in members))
        members.append(cand)
    return members


_MARGIN_CACHE = {}


def best_colluder_margins(p, trials=2000):
    """C2: for each colluder count c < P among the counted reveals, the report margin over the
    threshold (0..10 in 0.5 steps) that maximises P(pass). Honest scores are drawn as in Sim.play
    (lean + noise, clipped; no-shows ignored), with the same draws for every margin. Cached."""
    key = (p.true_score, p.threshold, p.sigma_within, p.sigma_between, p.n_required, p.p_cluster,
           p.cluster_rule, p.rng_seed)
    if key in _MARGIN_CACHE:
        return _MARGIN_CACHE[key]
    rng = random.Random(p.rng_seed + 99)
    grid = [0.5 * i for i in range(21)]
    out = {}
    for c in range(1, min(p.p_cluster, p.n_required + 1)):
        draws = [[min(100.0, max(0.0, p.true_score + rng.gauss(0, p.sigma_between) + rng.gauss(0, p.sigma_within)))
                  for _ in range(p.n_required - c)] for _ in range(trials)]
        best_m, best_w = p.colluder_report_margin, -1
        for m in grid:
            rep = min(100.0, p.threshold + m)
            wins = 0
            for h in draws:
                vals = [rep] * c + h
                mem = best_cluster(vals, p.p_cluster, p.cluster_rule)
                wins += sum(vals[i] for i in mem) / len(mem) >= p.threshold
            if wins > best_w:
                best_m, best_w = m, wins
        out[c] = best_m
    _MARGIN_CACHE[key] = out
    return out


def order_stat_index(rng, n, length):
    """Index of the best of n uniform draws (with replacement) from a pool sorted best-first."""
    x = 1.0 - (1.0 - rng.random()) ** (1.0 / n)
    return min(int(x * length), length - 1)


# =====================================================================================
#                                     NETWORK
# =====================================================================================
class Network:
    """One arbiter population, plus a pre-drawn pool of selections ranked by the attacker's
    PREDICTED pass probability (from estimated leans, colluders fast, no-shows ignored)."""

    def __init__(self, sim, rng):
        p = sim.p
        n = p.eligible_oracles
        self.col = [i < sim.n_c for i in range(n)]
        self.lean = [rng.gauss(0, p.sigma_between) for _ in range(n)]  # colluders' lean used only in the fair reference
        self.est = [b + rng.gauss(0, p.sigma_estimate) for b in self.lean]
        lo, hi = p.min_score_for_selection, p.max_score_for_selection
        self.weights = [rng.uniform(lo, hi) * (p.colluder_weight_multiplier if c else 1) for c in self.col]
        self.sim = sim
        pool = []
        for _ in range(sim.pool_n):
            sel = select_oracles(self.weights, p.k_commit_poll, p.shortlist_size, rng)
            pool.append((self.predict(sel), sel))
        pool.sort(key=lambda x: -x[0])
        self.pool = pool
        self.pp_mean = sum(x[0] for x in pool) / len(pool)
        prov = [sum(self.col[j] for j in select_oracles(self.weights, p.beacon_providers, p.shortlist_size, rng))
                for _ in range(sim.pool_n)]
        prov.sort(reverse=True)
        self.prov = prov
        self.mean_cp = sum(prov) / len(prov)

    def predict(self, sel):
        p, s = self.sim.p, self.sim
        c = sum(self.col[j] for j in sel)
        rep = s.report_for(c)
        if s.broad:
            return self.predict_broad(sel, c, rep)
        if c >= p.p_cluster:
            return 1.0 if rep >= p.threshold else 0.0
        honest = [p.true_score + self.est[j] for j in sel if not self.col[j]]
        need = p.n_required - c
        tot, cnt = 0.0, 0
        for combo in combinations(honest, need):
            vals = [rep] * c + list(combo)
            mem = best_cluster(vals, p.p_cluster, p.cluster_rule)
            m = sum(vals[i] for i in mem) / len(mem)
            tot += phi((m - p.threshold) / s.pred_sd)
            cnt += 1
        return tot / cnt if cnt else 0.0

    def predict_broad(self, sel, c, rep):
        """L'3: predicted pass under the broad rule."""
        p, s = self.sim.p, self.sim
        if rep < p.threshold:
            return 0.0
        if c >= s.quota:
            return 1.0
        honest = [j for j in sel if not self.col[j]]
        need = p.n_required - c
        if not honest or need <= 0:
            return 0.0
        share = min(1.0, need / len(honest))
        dist = [1.0]
        for j in honest:
            q = share * phi((p.true_score + self.est[j] - p.threshold) / s.pred_sd)
            nxt = [0.0] * (len(dist) + 1)
            for i, v in enumerate(dist):
                nxt[i] += v * (1 - q)
                nxt[i + 1] += v * q
            dist = nxt
        return sum(dist[s.quota - c:])

    def best_of(self, rng, n):
        return self.pool[order_stat_index(rng, max(1, n), len(self.pool))]

    def random_cp(self, rng):
        return self.prov[rng.randrange(len(self.prov))]

    def best_cp(self, rng, n):
        return self.prov[order_stat_index(rng, max(1, n), len(self.prov))]

    def p_cp_at_least(self, t):
        return sum(1 for x in self.prov if x >= t) / len(self.prov)

    def cp_at_least(self, rng, t):
        k = sum(1 for x in self.prov if x >= t)
        return self.prov[rng.randrange(k)] if k else None


# =====================================================================================
#                                     SIMULATOR
# =====================================================================================
class Sim:
    def __init__(self, p: Params, scale=1.0):
        self.p = p
        self.r = random.Random(p.rng_seed)
        self.r4 = random.Random(p.rng_seed + 5)  # S4 stream, so S1-S3 results are unchanged
        n = p.eligible_oracles
        self.n_c = min(n, max(0, round(p.x_colluding_oracles * n)))
        self.networks = max(20, int(p.networks * scale))
        self.evals = max(10, int(p.evals_per_network * scale))
        self.pool_n = max(150, int(p.selection_pool * scale))
        self.report = min(100.0, p.threshold + p.colluder_report_margin)
        if p.pass_rule not in ("cluster_mean", "broad"):
            raise ValueError(f"unknown pass_rule {p.pass_rule!r}")
        self.broad = p.pass_rule == "broad"
        self.quota = p.quota or p.p_cluster
        if self.broad and not 1 <= self.quota <= p.n_required:
            raise ValueError(f"quota {self.quota} must be in 1..N ({p.n_required})")
        if self.broad and p.colluder_report_rule in ("best", "fixed"):
            self.margins = {}  # L'2: any score >= threshold counts the same
        elif p.colluder_report_rule == "best":
            self.margins = best_colluder_margins(p)
        elif p.colluder_report_rule == "fixed":
            self.margins = {}
        else:
            raise ValueError(f"unknown colluder_report_rule {p.colluder_report_rule!r}")
        self.pred_sd = math.sqrt((p.sigma_within ** 2 + p.sigma_estimate ** 2) / 2) or 1e-9
        self.fee = p.oracle_fee_eth * p.eth_usd
        g = lambda gas: gas * p.gas_price_gwei * 1e-9 * p.eth_usd
        self.req_gas_usd = g(p.request_gas)
        self.check_usd = g(p.selection_check_gas)
        self.beacon_usd = self.fee * p.beacon_fee_multiplier * (1 - p.x_colluding_oracles) + g(p.beacon_gas)
        self.two_phase_usd = g(p.two_phase_extra_gas)
        self.hold_blocks = max(1, int(p.builder_max_hold_s / p.block_time_s))

    def report_for(self, c):
        """Colluders' shared score when c of them were polled (C2)."""
        m = self.margins.get(min(c, self.p.n_required))
        return self.report if m is None else min(100.0, self.p.threshold + m)

    # ---------- one aggregation round ----------
    def play(self, net, sel, builder=False, fast=True, fair=False):
        """Returns (passed, requester's net fee outlay in USD). builder=True: the builder controls
        commit/reveal ordering (L3). fair=True: everyone honest (the reference outcome)."""
        p, r = self.p, self.r
        if sel is None:
            return False, 0.0  # beacon never answered: no round
        is_col = lambda j: net.col[j] and not fair
        cost = self.fee * sum(1 for j in sel if not is_col(j)) + self.req_gas_usd
        rep = self.report_for(sum(1 for j in sel if is_col(j)))
        commits = []
        for j in sel:
            c = is_col(j)
            if c and fast:
                t = lognorm(r, p.colluder_commit_median_s, p.colluder_latency_sigma)
            else:
                if not c and r.random() < p.honest_no_show_prob:
                    continue
                t = lognorm(r, p.honest_commit_median_s, p.honest_latency_sigma)
            commits.append((t, j, c))
        if len(commits) < p.m_reveal:
            return False, cost
        commits.sort()
        if builder:
            cutoff = min(commits[p.m_reveal - 1][0] + p.builder_max_hold_s, p.response_timeout_s)
            cand = [x for x in commits if x[0] <= cutoff]
            chosen = sorted(cand, key=lambda x: (not x[2], -net.est[x[1]]))[:p.m_reveal]
            t0 = max(x[0] for x in chosen)
        else:
            chosen = commits[:p.m_reveal]
            t0 = chosen[-1][0]
        reveals = []
        for _, j, c in chosen:
            if c and fast:
                d = lognorm(r, p.colluder_reveal_median_s, p.colluder_latency_sigma)
            else:
                if not c and r.random() < p.honest_no_show_prob:
                    continue
                d = lognorm(r, p.honest_reveal_median_s, p.honest_latency_sigma)
            if t0 + d <= p.response_timeout_s:
                s = rep if c else min(100.0, max(0.0, p.true_score + net.lean[j] + r.gauss(0, p.sigma_within)))
                reveals.append((t0 + d, s, c))
        if len(reveals) < p.n_required:
            return False, cost
        reveals.sort()
        if builder:
            cutoff = min(reveals[p.n_required - 1][0] + p.builder_max_hold_s, p.response_timeout_s)
            cand = [x for x in reveals if x[0] <= cutoff]
            if self.broad:  # L'4: the N highest scores maximise the count
                subsets = [sorted(cand, key=lambda x: -x[1])[:p.n_required]]
            else:
                subsets = combinations(cand, p.n_required)
        else:
            subsets = [reveals[:p.n_required]]
        best = None
        for sub in subsets:
            vals = [x[1] for x in sub]
            mem = best_cluster(vals, p.p_cluster, p.cluster_rule)
            m = sum(vals[i] for i in mem) / len(mem)
            if self.broad:
                m = sum(1 for v in vals if v >= p.threshold)  # L'1: the count replaces the mean
            honest_in = sum(1 for i in mem if not sub[i][2])
            if best is None or m > best[0]:
                best = (m, honest_in)
        cost += p.bonus_multiplier * self.fee * best[1]
        return best[0] >= (self.quota if self.broad else p.threshold), cost

    # ---------- beacon helpers ----------
    def first_two_options(self, cp, blocks):
        """S4: informed candidate seeds for cp colluding beacons when the first two values count."""
        blocks = sorted(blocks)
        n = cp * (cp - 1) // 2                      # colluder-only pairs, computed in advance
        if cp and blocks and (len(blocks) == 1 or blocks[1] > blocks[0]):
            n += cp                                 # pair with the first honest value once it lands
        if len(blocks) >= 2:
            n += 1                                  # abstain: the first two honest values decide
        return n

    def first_two_builder_options(self, cp, blocks):
        """S4: a bribed sequencer picks any pair among colluders and the honest reveals pending
        within its hold window, knowing every value."""
        if not self.p.builder_sees_pending_txs:
            return self.first_two_options(cp, blocks)
        blocks = sorted(blocks)
        vis = sum(1 for b in blocks if b <= blocks[0] + self.hold_blocks) if blocks else 0
        avail = cp + vis
        return avail * (avail - 1) // 2

    def provider_blocks(self, n_honest):
        p, r = self.p, self.r
        out = []
        for _ in range(n_honest):
            if r.random() < p.honest_provider_no_show_prob:
                continue
            out.append(max(1, math.ceil(lognorm(r, p.honest_provider_median_s, p.honest_provider_sigma) / p.block_time_s)))
        return out

    def beacon_withhold(self, net, cp):
        """Selection that results when cp colluding providers play withhold/timing (no builder)."""
        p, r = self.p, self.r
        blocks = self.provider_blocks(p.beacon_providers - cp)
        rand = net.best_of(r, 1)[1]
        if cp == 0:
            return rand if blocks else None
        reroll = (min(blocks) if blocks else p.beacon_timeout_blocks) if p.beacon_seed_uses_response_block else 1
        pp, sel = net.best_of(r, cp * reroll)
        if pp > net.pp_mean or not blocks:
            return sel
        return rand

    def beacon_builder(self, net):
        p, r = self.p, self.r
        G = p.builder_grind_options
        cp = net.best_cp(r, G)
        blocks = self.provider_blocks(p.beacon_providers - cp)
        visible = sum(1 for b in blocks if b <= self.hold_blocks) if p.builder_sees_pending_txs else 0
        n = cp * G + visible * (G if p.beacon_seed_uses_response_block else 1)
        if n:
            return net.best_of(r, n)[1]
        return net.best_of(r, 1)[1] if blocks else None

    # ---------- run every strategy ----------
    def run(self):
        p, r = self.p, self.r
        acc = {}

        def add(key, res):
            a = acc.setdefault(key, [0.0, 0.0, 0])
            a[0] += res[0]
            a[1] += res[1]
            a[2] += 1

        G = p.builder_grind_options
        self.p_cp = {}
        for _ in range(self.networks):
            net = Network(self, r)
            for t in range(1, p.beacon_providers + 1):
                self.p_cp.setdefault(t, []).append(net.p_cp_at_least(t))
            for _ in range(self.evals):
                rand = net.best_of(r, 1)[1]
                add("fair", self.play(net, rand, fair=True))
                add("norace", self.play(net, rand, fast=False))
                # ----- S1 -----
                add("s1_free", self.play(net, rand))
                for T in p.submitter_grind_options:
                    if T > 1:
                        add(f"s1_g{T}", self.play(net, net.best_of(r, T)[1]))
                g = net.best_of(r, G)[1]
                add("s1_seed", self.play(net, g))
                add("s1_order", self.play(net, rand, builder=True))
                add("s1_all", self.play(net, g, builder=True))
                # ----- S2 -----
                w = self.beacon_withhold(net, net.random_cp(r))
                add("s2_free", self.play(net, w))
                add("s2_order", self.play(net, w, builder=True))
                for t in range(1, min(self.n_c, p.beacon_providers) + 1):
                    cp = net.cp_at_least(r, t)
                    if cp is not None:
                        add(f"s2_g{t}", self.play(net, self.beacon_withhold(net, cp)))
                if not p.beacon_seed_uses_response_block and self.n_c:
                    for T in p.submitter_grind_options:
                        n = round(T * net.mean_cp)
                        if n:
                            pp, sel = net.best_of(r, n)
                            add(f"s2_j{T}", self.play(net, sel if pp > net.pp_mean else rand))
                b = self.beacon_builder(net)
                add("s2_seed", self.play(net, b))
                add("s2_all", self.play(net, b, builder=True))
                # ----- S4 (own RNG stream; play() reads self.r) -----
                main_r, self.r = self.r, self.r4
                r4 = self.r4
                cp = net.random_cp(r4)
                n = self.first_two_options(cp, self.provider_blocks(p.beacon_providers - cp))
                free = net.best_of(r4, n)[1] if n else None
                add("s4_free", self.play(net, free))
                add("s4_order", self.play(net, free, builder=True))
                pre = 0  # seeds known before building: colluder-only pairs in each B+1 version (H''4)
                for _ in range(G):
                    v = net.random_cp(r4)
                    pre += v * (v - 1) // 2
                cp = net.best_cp(r4, G)
                n = pre + self.first_two_builder_options(cp, self.provider_blocks(p.beacon_providers - cp))
                ground = net.best_of(r4, n)[1] if n else None
                add("s4_seed", self.play(net, ground))
                add("s4_all", self.play(net, ground, builder=True))
                self.r = main_r
        self.p_cp = {t: sum(v) / len(v) for t, v in self.p_cp.items()}
        return {k: (a[0] / a[2], a[1] / a[2]) for k, a in acc.items()}


# =====================================================================================
#                                     STRATEGY TABLES
# =====================================================================================
INF = float("inf")


def ratio(c, x):
    return c / x if x > 0 else INF


def build(p: Params, scale=1.0):
    sim = Sim(p, scale)
    R = sim.run()
    Z = p.z_builder_bribe_usd
    bribe_s2 = Z * (1 if p.single_sequencer else 2)
    avail_s2 = p.y_colluding_builders if p.single_sequencer else p.y_colluding_builders ** 2

    def vstar(key, free_key, bribe):
        d = R[key][0] - R[free_key][0]
        return bribe / d if d > 0 else INF

    # S1
    s1 = [("submitter", "L1 re-submit until it passes", R["s1_free"][0], R["s1_free"][1],
           ratio(R["s1_free"][1], R["s1_free"][0]))]
    best = None
    for T in p.submitter_grind_options:
        if T > 1:
            pr, c = R[f"s1_g{T}"]
            c += sim.check_usd * T
            v = ratio(c, pr)
            if best is None or v < best[4]:
                best = ("submitter", f"L2 predict seed, wait through {T} draws for the best", pr, c, v)
    s1.append(best)
    pr, c = R["s1_all"]
    s1.append(("submitter", "L2+L3 submitter bribes builder", pr, c + Z, ratio(c + Z, pr)))
    s1 += [
        ("outsider", "L2 bribe builder: grind seed", R["s1_seed"][0], Z, vstar("s1_seed", "s1_free", Z)),
        ("outsider", "L3 bribe builder: ordering only", R["s1_order"][0], Z, vstar("s1_order", "s1_free", Z)),
        ("outsider", "L2+L3 bribe builder: grind seed + ordering", R["s1_all"][0], Z, vstar("s1_all", "s1_free", Z)),
    ]

    # S2
    pr, c = R["s2_free"]
    c += sim.beacon_usd
    s2 = [("submitter", "L1 re-submit (colluding providers withhold/time)", pr, c, ratio(c, pr))]
    best = None
    for t in range(1, min(sim.n_c, p.beacon_providers) + 1):
        if f"s2_g{t}" in R and sim.p_cp.get(t, 0) > 0:
            pr, c = R[f"s2_g{t}"]
            c += sim.beacon_usd + sim.check_usd / sim.p_cp[t]
            v = ratio(c, pr)
            if best is None or v < best[4]:
                best = ("submitter", f"L2 grind stage 1 for >={t} colluding providers (~{1 / sim.p_cp[t]:.0f} draws)",
                        pr, c, v)
    if best:
        s2.append(best)
    best = None
    for T in p.submitter_grind_options:
        if f"s2_j{T}" in R:
            pr, c = R[f"s2_j{T}"]
            c += sim.beacon_usd + sim.check_usd * T
            v = ratio(c, pr)
            if best is None or v < best[4]:
                best = ("submitter", f"L2 joint grind w/ colluding provider's h, request-block seed ({T} draws)",
                        pr, c, v)
    if best:
        s2.append(best)
    pr, c = R["s2_all"]
    c += sim.beacon_usd + bribe_s2
    s2.append(("submitter", "L2+L3 submitter bribes builder", pr, c, ratio(c, pr)))
    s2 += [
        ("outsider", "L2 bribe builder: choose/grind beacon value", R["s2_seed"][0], bribe_s2,
         vstar("s2_seed", "s2_free", bribe_s2)),
        ("outsider", "L3 bribe builder: ordering only", R["s2_order"][0], bribe_s2, vstar("s2_order", "s2_free", bribe_s2)),
        ("outsider", "L2+L3 bribe builder: beacon + ordering", R["s2_all"][0], bribe_s2,
         vstar("s2_all", "s2_free", bribe_s2)),
    ]

    # S3: two-phase request (section H'). Same rounds as S1 without submitter prediction.
    e = sim.two_phase_usd
    pr, c = R["s1_free"]
    s3 = [("submitter", "L1 re-submit (seed unknown at commit)", pr, c + e, ratio(c + e, pr))]
    pr, c = R["s1_all"]
    s3.append(("submitter", "L2+L3 submitter bribes builder", pr, c + e + Z, ratio(c + e + Z, pr)))
    s3 += [
        ("outsider", "L2 bribe builder: grind blockhash(B+1)", R["s1_seed"][0], Z, vstar("s1_seed", "s1_free", Z)),
        ("outsider", "L3 bribe builder: ordering only", R["s1_order"][0], Z, vstar("s1_order", "s1_free", Z)),
        ("outsider", "L2+L3 bribe builder: grind B+1 + ordering", R["s1_all"][0], Z, vstar("s1_all", "s1_free", Z)),
    ]

    # S4: two-phase + first two of the beacons (section H'').
    e4 = e + 2 * sim.beacon_usd
    pr, c = R["s4_free"]
    s4 = [("submitter", "L1 re-submit (colluding beacons race / pair / abstain)", pr, c + e4, ratio(c + e4, pr))]
    pr, c = R["s4_all"]
    s4.append(("submitter", "L2+L3 submitter bribes builder", pr, c + e4 + Z, ratio(c + e4 + Z, pr)))
    s4 += [
        ("outsider", "L2 bribe builder: grind B+1 + pick first two reveals", R["s4_seed"][0], Z,
         vstar("s4_seed", "s4_free", Z)),
        ("outsider", "L3 bribe builder: ordering only", R["s4_order"][0], Z, vstar("s4_order", "s4_free", Z)),
        ("outsider", "L2+L3 bribe builder: beacons + ordering", R["s4_all"][0], Z, vstar("s4_all", "s4_free", Z)),
    ]
    return sim, R, s1, s2, s3, s4, avail_s2


def headline(rows):
    return min(r[4] for r in rows)


# =====================================================================================
#                                     REPORTING
# =====================================================================================
def usd(v):
    if v == INF or v != v:
        return "unbounded"
    return f"${v:,.2f}" if v < 100 else f"${v:,.0f}"


def pct(x):
    return f"{100 * x:.2f}%"


def print_table(title, rows, free, fair, avail):
    print(f"\n{title}")
    print(f"  {'role':<10} {'strategy':<70} {'P(pass)':>8} {'cost/try':>10} {'max safe V':>12}")
    for role, name, pr, c, v in rows:
        print(f"  {role:<10} {name:<70} {pct(pr):>8} {usd(c):>10} {usd(v):>12}")
    best = min(rows, key=lambda r: r[4])
    worst = max(r[2] for r in rows if r[0] == "outsider")
    print(f"  -> MAX VALUE THAT SHOULD HINGE ON THE DECISION: {usd(best[4])}   (binding: {best[1]})")
    print(f"  -> with no attacker spend: P(pass) {pct(free)} vs fair {pct(fair)}; "
          f"above the builder break-even it rises to {pct(free + avail * max(0, worst - free))} "
          f"(builder availability {avail:.0%})")


def margins_text(sim):
    p = sim.p
    if not sim.margins:
        return f"{sim.report:g}"
    parts = [f"{c}:{min(100.0, p.threshold + m):g}" for c, m in sorted(sim.margins.items())]
    return "by count " + ", ".join(parts) + f", >={p.p_cluster}:{sim.report:g}"


def run(p: Params, scale=1.0):
    sim, R, s1, s2, s3, s4, avail2 = build(p, scale)
    print("=" * 120)
    print("Verdikta decision-manipulation risk (Monte Carlo): collusion + arbiter lean + selection + ordering")
    print("=" * 120)
    print(f"X = {p.x_colluding_oracles:.0%} of {p.eligible_oracles} eligible -> {sim.n_c} colluders | "
          f"Y = {p.y_colluding_builders:.0%} | Z = {usd(p.z_builder_bribe_usd)} | base fee {usd(sim.fee)} | "
          f"K,M,N,P = {p.k_commit_poll},{p.m_reveal},{p.n_required},{p.p_cluster} ({p.cluster_rule} clustering)"
          + (f" | broad threshold: {sim.quota} of {p.n_required}" if sim.broad else ""))
    print(f"true score {p.true_score:.0f}, threshold {p.threshold:.0f}, lean sd {p.sigma_between}, "
          f"noise sd {p.sigma_within}, estimate error sd {p.sigma_estimate}, colluders report {margins_text(sim)} | "
          f"beacon seed from response block: {p.beacon_seed_uses_response_block}")
    print(f"\nFair pass rate (everyone honest, unbiased seed): {pct(R['fair'][0])}")
    print_table("S1  CURRENT CODE", s1, R["s1_free"][0], R["fair"][0], p.y_colluding_builders)
    print_table("S2  HASH-CHAIN BEACON (first of 4 providers)", s2, R["s2_free"][0], R["fair"][0], avail2)
    print_table("S3  TWO-PHASE REQUEST (TODO item 9: seed = blockhash(B+1), state checkpointed at B)", s3,
                R["s1_free"][0], R["fair"][0], p.y_colluding_builders)
    print_table(f"S4  TWO-PHASE + FIRST 2 OF {p.beacon_providers} BEACONS (seed = H(aggId, blockhash(B+1), v_first, v_second))",
                s4, R["s4_free"][0], R["fair"][0], p.y_colluding_builders)
    print("\nREFERENCE")
    pr, c = R["s1_free"]
    print(f"  ideal unbiasable RNG (VRF), submitter re-submits:     P(pass) {pct(pr)}   max safe V {usd(ratio(c, pr))}")
    pr, c = R["norace"]
    print(f"  ... and reveal set not chosen by arrival order:       P(pass) {pct(pr)}   max safe V {usd(ratio(c, pr))}")
    print(f"  L4 denial (all scenarios): censor fulfill txs past {p.response_timeout_s:.0f}s -> round fails with "
          f"certainty for one bribe ({usd(p.z_builder_bribe_usd)}).")


def sweep(p: Params):
    res = {}
    for x in p.sweep_x:
        for sb in p.sweep_sigma_between:
            _, _, *rows, _ = build(replace(p, x_colluding_oracles=x, sigma_between=sb), p.sweep_scale)
            res[(x, sb)] = [headline(r) for r in rows]
    for title, idx in (("S1 current / S2 beacon / S3 two-phase", (0, 1, 2)),
                       ("S3 two-phase / S4 + first 2 of 4 beacons", (2, 3))):
        print("\n" + "=" * 120)
        print(f"SWEEP: max value that should hinge on one decision,  {title}")
        print("=" * 120)
        print(f"{'X \\ lean sd':>12} | " + " | ".join(f"{s:^32.1f}" for s in p.sweep_sigma_between))
        for x in p.sweep_x:
            cells = [" /".join(f"{usd(res[(x, sb)][i]):>9}" for i in idx) for sb in p.sweep_sigma_between]
            print(f"{x:>12.0%} | " + " | ".join(f"{c:^32}" for c in cells))


# =====================================================================================
#                          BROAD THRESHOLD: EXACT CONFIG SEARCH (L'5)
# =====================================================================================
def upper_tail(mean, threshold, sd):
    """P(score >= threshold) for N(mean, sd^2), accurate far into the tail."""
    if sd <= 0:
        return 1.0 if mean >= threshold else 0.0
    return 0.5 * math.erfc((threshold - mean) / (sd * math.sqrt(2)))


def binom_tail(n, q, k):
    """P(Binomial(n, q) >= k)."""
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    return sum(math.comb(n, i) * q ** i * (1 - q) ** (n - i) for i in range(k, n + 1))


def broad_config_eval(p: Params, K, M, N, Q, P, target, good_true, fee_floor_usd):
    """L'5: exact pass rates, fee needed for `target`, and liveness for one configuration."""
    n_c = min(p.eligible_oracles, max(0, round(p.x_colluding_oracles * p.eligible_oracles)))
    pop = math.comb(p.eligible_oracles, K)
    pmf = [math.comb(n_c, c) * math.comb(p.eligible_oracles - n_c, K - c) / pop for c in range(K + 1)]
    show = 1 - p.honest_no_show_prob
    sd = math.hypot(p.sigma_between, p.sigma_within)
    q_bad, q_good = upper_tail(p.true_score, p.threshold, sd), upper_tail(good_true, p.threshold, sd)

    free, fee_units, attacked = 0.0, 0.0, 0.0
    win = [0.0] * (K + 1)
    for c, w in enumerate(pmf):
        promoted = min(c, M)
        ok = binom_tail(K - c, show, M - c) * binom_tail(M - promoted, show, N - promoted)
        counted = min(promoted, N)
        win[c] = ok * binom_tail(N - counted, q_bad, Q - counted)
        free += w * win[c]
        if counted >= P:
            honest_in = 0
        elif p.cluster_rule == "greedy" and counted >= 2:
            honest_in = P - counted  # identical colluders seed the cluster, and all of them join it
        else:
            honest_in = min(P, N - counted)
        fee_units += w * ((K - c) + ok * p.bonus_multiplier * honest_in)
        vote_no = ok * binom_tail(N - counted, q_good, Q)
        withhold = binom_tail(K - c, show, M) * binom_tail(M, show, N) * binom_tail(N, q_good, Q)
        attacked += w * min(vote_no, withhold)

    # A sequencer tries G seeds and keeps the one with the most colluders.
    G, ground, tail, above = p.builder_grind_options, 0.0, 0.0, 0.0
    for c in range(K, -1, -1):
        tail += pmf[c]
        at_least = -math.expm1(G * math.log1p(-tail)) if tail < 1 else 1.0
        ground += (at_least - above) * win[c]
        above = at_least

    gas = lambda units: units * p.gas_price_gwei * 1e-9 * p.eth_usd
    attack_gas = gas(p.request_gas + p.two_phase_extra_gas)
    fee_needed = max(0.0, (target * free - attack_gas) / fee_units)
    fee = max(fee_needed, fee_floor_usd)
    complete = binom_tail(K, show, M) * binom_tail(M, show, N)
    Z = p.z_builder_bribe_usd
    delta = ground - free
    return {
        "K": K, "M": M, "N": N, "Q": Q, "P": P, "free": free, "ground": ground, "fee": fee,
        "total": fee * (K + p.bonus_multiplier * P) + gas(p.request_gas * K / 6 + p.two_phase_extra_gas),
        "resubmit": ratio(fee * fee_units + attack_gas, free),
        "sequencer": min(Z / delta if delta > 0 else INF, ratio(fee * fee_units + attack_gas + Z, ground)),
        "complete": complete, "good": complete * binom_tail(N, q_good, Q), "attacked": attacked,
    }


def print_configs(rows):
    print(f"  {'K/M/N/P':<12} {'Q':>3} {'fee each':>9} {'total fee':>10} {'P(pass)/try':>12} {'re-submit V':>12} "
          f"{'sequencer V':>12} {'complete':>9} {'good pass':>10} {'attacked':>9} {'hunter $':>10}")
    for r in rows:
        print(f"  {str(r['K']) + '/' + str(r['M']) + '/' + str(r['N']) + '/' + str(r['P']):<12} {r['Q']:>3} "
              f"{usd(r['fee']):>9} {usd(r['total']):>10} {r['free']:>12.2e} {usd(r['resubmit']):>12} "
              f"{usd(r['sequencer']):>12} {pct(r['complete']):>9} {pct(r['good']):>10} {pct(r['attacked']):>9} "
              f"{usd(ratio(r['total'], r['attacked'])):>10}")


def config_search(p: Params, target, k_max, good_true, fee_floor_usd, min_good=0.98, min_attacked=0.5, min_complete=0.99):
    """Cheapest configurations meeting `target` under the broad rule, by K. P is fixed at 2 (cheapest)
    and at a majority of N (keeps the bonus odds of a typical arbiter near today's)."""
    if p.colluder_weight_multiplier != 1.0:
        raise ValueError("--config-search requires colluder_weight_multiplier = 1 (L'5)")
    print("=" * 120)
    print(f"BROAD THRESHOLD CONFIG SEARCH (S3 two-phase): target ${target:,.0f}, X = {p.x_colluding_oracles:.0%}, "
          f"noise sd {p.sigma_within}, true {p.true_score:g}, threshold {p.threshold:g}, good submission {good_true:g}")
    print(f"Constraints: complete >= {min_complete:.0%}, good pass >= {min_good:.0%}, attacked pass >= {min_attacked:.0%}, "
          f"fee floor {usd(fee_floor_usd)}, bonus {p.bonus_multiplier}x, sequencer bribe {usd(p.z_builder_bribe_usd)}")
    print("=" * 120)
    found = {"either": {}, "sequencer": {}}
    for K in range(4, k_max + 1):
        for M in range(2, K + 1):
            for N in range(2, M + 1):
                for Q in range((N + 2) // 2, N + 1):
                    for P in sorted({2, (N + 1) // 2 + (N % 2 == 0)}):
                        if P > N:
                            continue
                        r = broad_config_eval(p, K, M, N, Q, P, target, good_true, fee_floor_usd)
                        if r["complete"] < min_complete or r["good"] < min_good or r["attacked"] < min_attacked:
                            continue
                        if r["resubmit"] < target * (1 - 1e-9):  # the fee is solved to land exactly on target
                            continue
                        key = (K, P == 2)
                        if key not in found["either"] or r["total"] < found["either"][key]["total"]:
                            found["either"][key] = r
                        if r["sequencer"] >= target and (
                                key not in found["sequencer"] or r["total"] < found["sequencer"][key]["total"]):
                            found["sequencer"][key] = r
    for title, key in (("Re-submission only (sequencer trusted), cheapest per K", "either"),
                       ("Also safe against the bribed sequencer, cheapest per K", "sequencer")):
        print(f"\n{title}")
        rows = sorted(found[key].values(), key=lambda r: r["total"])
        if rows:
            print_configs(rows[:16])
        else:
            print("  none found")
    print("\nCluster-mean rule with true clustering, for comparison (K = 2P + 2, M = 2P, N = 2P - 1, Q = P):")
    print_configs([broad_config_eval(p, min(2 * P + 2, k_max), 2 * P, 2 * P - 1, P, P, target, good_true, fee_floor_usd)
                   for P in range(2, (k_max - 2) // 2 + 1)])


def load_params_json(p: Params, path: str):
    """Apply a {"params": {field: value}} file (or a flat {field: value} object) onto p. Keys
    starting with '_' are metadata and ignored; unknown keys are reported, not applied."""
    with open(path) as fh:
        doc = json.load(fh)
    values = doc.get("params", doc)
    applied, unknown = [], []
    for k, v in values.items():
        if k.startswith("_"):
            continue
        if k not in Params.__dataclass_fields__:
            unknown.append(k)
            continue
        cur = getattr(p, k)
        setattr(p, k, type(cur)(v) if isinstance(cur, (int, float)) and not isinstance(cur, bool) else v)
        applied.append(k)
    print(f"loaded {len(applied)} params from {path}: {', '.join(applied)}")
    if unknown:
        print(f"  ignored unknown keys: {', '.join(unknown)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--x", type=float, help="fraction of eligible arbiters colluding")
    ap.add_argument("--y", type=float, help="fraction of builders that take bribes")
    ap.add_argument("--z", type=float, help="bribe per manipulated block, USD")
    ap.add_argument("--sigma-between", type=float, help="sd of persistent arbiter lean")
    ap.add_argument("--sigma-within", type=float, help="sd of one arbiter's run-to-run noise")
    ap.add_argument("--params-json", type=str, help="JSON from arbiter-stats.js analyze --params-out "
                    "(its 'params' object, keyed by Params field); CLI flags override it")
    ap.add_argument("--true", type=float, help="mean honest accept likelihood")
    ap.add_argument("--threshold", type=float, help="pass threshold")
    ap.add_argument("--eligible", type=int, help="eligible arbiters for the class (default 300, a planning value)")
    ap.add_argument("--request-block-seed", action="store_true", help="beacon mixes REQUEST-block entropy")
    ap.add_argument("--cluster-rule", choices=("best_subset", "greedy"),
                    help="best_subset (default, TODO item 10) or greedy (current AggregatorLib)")
    ap.add_argument("--colluder-report", choices=("best", "fixed"),
                    help="best (default): colluders pick their score by how many were drawn; fixed: threshold + margin")
    ap.add_argument("--pass-rule", choices=("cluster_mean", "broad"),
                    help="cluster_mean (default) or broad: at least Q of the N counted reveals >= threshold")
    ap.add_argument("--quota", type=int, help="Q for the broad rule (default P)")
    ap.add_argument("--knmp", type=str, help="K,M,N,P as four comma-separated integers")
    ap.add_argument("--config-search", action="store_true", help="exact search for the cheapest broad-threshold configs (L'5)")
    ap.add_argument("--target", type=float, default=100_000.0, help="config search: value to protect, USD")
    ap.add_argument("--k-max", type=int, default=20, help="config search: largest K (shortlist_size 20 unless raised)")
    ap.add_argument("--good-true", type=float, default=95.0, help="config search: honest score of a good submission")
    ap.add_argument("--fee-floor", type=float, default=0.046, help="config search: lowest fee per arbiter, USD")
    ap.add_argument("--min-attacked", type=float, default=0.5, help="config search: lowest good-submission pass rate while colluders block")
    ap.add_argument("--min-good", type=float, default=0.98, help="config search: lowest good-submission pass rate with no attack")
    ap.add_argument("--scale", type=float, default=1.0, help="scale Monte Carlo sizes")
    ap.add_argument("--no-sweep", action="store_true")
    a = ap.parse_args()
    p = Params()
    if a.params_json:
        load_params_json(p, a.params_json)
    for k, attr in (("x", "x_colluding_oracles"), ("y", "y_colluding_builders"), ("z", "z_builder_bribe_usd"),
                    ("sigma_between", "sigma_between"), ("sigma_within", "sigma_within"),
                    ("true", "true_score"), ("threshold", "threshold"), ("eligible", "eligible_oracles")):
        if getattr(a, k) is not None:
            setattr(p, attr, getattr(a, k))
    if a.cluster_rule:
        p.cluster_rule = a.cluster_rule
    if a.colluder_report:
        p.colluder_report_rule = a.colluder_report
    if a.request_block_seed:
        p.beacon_seed_uses_response_block = False
    if a.pass_rule:
        p.pass_rule = a.pass_rule
    if a.quota is not None:
        p.quota = a.quota
    if a.knmp:
        p.k_commit_poll, p.m_reveal, p.n_required, p.p_cluster = (int(v) for v in a.knmp.split(","))
    if a.config_search:
        config_search(p, a.target, a.k_max, a.good_true, a.fee_floor, min_good=a.min_good, min_attacked=a.min_attacked)
        return
    run(p, a.scale)
    if not a.no_sweep:
        sweep(p)


if __name__ == "__main__":
    main()
