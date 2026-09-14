# Phase 2 live wallet signals

Phase 2 is an event-driven layer alongside the unchanged recurrence-first Phase 1 scanner. It monitors only profiles that pass `trustedProfileQuality`; recurring-wallet rank alone never enables tracking.

## Railway configuration

Required for live Solana monitoring:

- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_AUTH_SECRET` — a long random value
- `PUBLIC_BASE_URL` — for example `https://consensus-production-b947.up.railway.app`

Required for alert delivery:

- Existing `DISCORD_TOKEN` or `DISCORD_BOT_TOKEN`
- `DISCORD_ALERT_CHANNEL_ID`, with `DISCORD_CHANNEL_ID` used as a fallback

The Discord bot needs View Channel, Send Messages and Embed Links in the alert channel.

Optional tuning variables and defaults:

- `TRACKED_WALLET_LIMIT=100`
- `SIGNAL_WINDOW_MINUTES=60`
- `SIGNAL_MIN_DISTINCT_WALLETS=2`
- `SIGNAL_POINTS_THRESHOLD=5`
- `SIGNAL_REALERT_MIN_ADDITIONAL_POINTS=3`
- `TRACKED_WALLET_REFRESH_MINUTES=360`
- `HELIUS_RECONCILE_INTERVAL_MINUTES=30`
- `HELIUS_RECONCILE_MAX_PAGES=3`
- `HELIUS_MONTHLY_CREDIT_BUDGET=800000`
- `SIGNAL_MIN_BUY_LAMPORTS=10000000`
- `SIGNAL_MIN_STABLE_RAW=1000000`

The service creates or updates one enhanced Helius SWAP webhook only when its tracked address set or callback URL changes. Incoming events are authenticated and saved before processing. A separate bounded RPC reconciliation cursor recovers missed deliveries without using the GMGN budget.

## Private status

Open `/phase2` on the existing authenticated dashboard. The page shows tracked-wallet count, provider state, genuine buys, duplicates, open accumulations and delivered signals. Its Discord test button sends a labelled test and does not create a fake signal.

If the tracked-wallet count is zero, Phase 2 is intentionally waiting for profiles to satisfy the existing strong-wallet criteria. Do not lower the quality gate simply to make alerts appear.
