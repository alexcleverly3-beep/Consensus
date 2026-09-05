# Selection-first manual review pilot

This is an additive experiment, not a replacement for Consensus V1. Existing
wallet scores, discovery, seed feedback, alerts and `/wallets` remain unchanged.
New tables use the `selection_` prefix. No old evidence is backfilled as verified
selection evidence and no existing wallets are automatically promoted.

## User workflow

- Open `/review` from the existing dashboard. Use the same private credentials.
- `/api/review-wallets` downloads frozen reports including every cohort token,
  purchase transaction, entry price, measured failures and unknown outcomes.
- `/api/review-progress` exposes aggregate counts only, without wallet identities.
- Every 100 unique new review candidates form a discovery group. Once all 100
  have been assessed or declared insufficient, rank the qualifying candidates.
- Save up to ten across completed groups, excluding repeated known funding
  addresses. Fewer than ten is valid; zero is valid. Never pad the queue.
- At ten saved candidates, pause this experiment. The normal scanner continues.
  Reports remain frozen for manual checking. A second review campaign requires
  an explicit follow-up after the owner reviews the first queue; do not delete
  or overwrite the first batch to free slots automatically.

## Evidence and provisional qualification

Discover candidates using buy-volume-ranked traders, including sold-out and
unprofitable traders, on quality-screened tokens already found by normal scans.
This improves on profit-only discovery but is still a bounded top-trader sample,
not an exhaustive earliest-buyer search. Existing identity/risk exclusions apply.

Retrieve wallet activity one page per available work slot. Freeze the cutoff at
the first history request and persist pagination across restarts. Keep all
distinct non-base-token selections in retrieved pages, including failures.
Require at least 20 purchases of at least $25 (unknown sizes remain unverified),
with entries spanning at least 14 days. Aim for 30 tokens and stop at a page
boundary; at most ten pages or 200 distinct tokens. Incomplete bounded histories
are insufficient, not hand-picked winners. Repeated token buys count once using
the earliest qualifying entry in the retrieved history. Ambiguous multi-token
transactions and conflicting/missing USD prices cannot earn credit.

For this first manually reviewed pilot, measure a fixed seven-day horizon after
each entry. Do not call this lifetime skill or exclude the existence of slower
selection skill. A later version should compare 24h/7d/28d horizons and matched
market cohorts, then forward-test frozen ratings. Those are not implemented yet.

Use hourly historical candles, excluding the purchase's own candle. Require at
least 90% candle coverage and both ends of the requested range. Missing candles
are unknown, not a flat price or a known loss. Retry missing history at most
three times, at least a day apart. Transient request failures retain their cursor
and retry no sooner than an hour; API cooldowns and shared guard take precedence.

An opportunity requires two consecutive hourly closes, each with at least
$5,000 traded volume. Use the smaller close, not a single high wick. Historical
liquidity depth is unknown: volume is only a screen, not proof of executability.
Keep peak, end price, worst price and time to 2x separate. A losing sale does not
erase later selection credit. Wallet P&L and holding time are not qualification
inputs.

Qualify only after all entries have completed the horizon, with >=80% measurable
histories, >=40% sustained 2x rate, >=3 sustained 3x tokens, median screened
opportunity >=1.5x and Wilson lower bound >=0.25. Unknown outcomes remain in the
hit-rate and median denominator. Cap individual multiples at 20 for aggregation.
These are explicitly provisional research floors, not calibrated probabilities.
Shared funding can indicate related wallets but does not establish ownership;
unknown funding does not prove independence.

## Operations and containment

The new job runs only after normal work and only if the installed shared guard
reports at least four fresh calls remaining and no cooldown. It uses at most one
request in that slot, leaving three reserved. Existing budget/spacing settings
are not increased. Candidate discovery gets occasional slots; history and candle
validation use the others. Pending candidates are capped at three groups.
Queues, evidence, outcomes and selected reports survive Railway volume restarts.

Set `SELECTION_REVIEW_ENABLED=0` to stop new experiment work without deleting
reports or affecting V1. Aggregate progress shows the enabled state. Review
errors are contained; they must not stop normal scanning or the public dashboard.
The private section uses the existing authentication and no-store/security headers.

Tests include loss-exit selection credit, wick exclusion, missing data, timestamp
normalization, duplicate histories, frozen cohorts, 100-wallet batch boundaries,
ten-wallet cap, funding deduplication, safe migration and authenticated routes.
