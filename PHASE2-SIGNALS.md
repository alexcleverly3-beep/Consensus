# Phase 2 live wallet signals

Phase 2 is an event-driven layer alongside the unchanged recurrence-first Phase 1 scanner. It monitors eligible trusted profiles and Phase 1 leaderboard wallets, subject to the private dashboard's entry settings and live credit budget.

## Railway configuration

Required for live Solana monitoring:

- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_AUTH_SECRET` — a long random value
- `PUBLIC_BASE_URL` — for example `https://consensus-production-b947.up.railway.app`

Required for alert delivery:

- Existing `DISCORD_TOKEN` or `DISCORD_BOT_TOKEN`
- `DISCORD_ALERT_CHANNEL_ID`, with `DISCORD_CHANNEL_ID` used as a fallback

The Discord bot needs View Channel, Send Messages and Embed Links in the alert channel.

## Discord scan evidence

Future token addresses posted by a human in `DISCORD_CHANNEL_ID` remain priority scans. A wallet appearing among the first 50 trader results for one of those completed scans receives a small Phase 2 reputation boost: +3 for one distinct posted token, +6 maximum for two or more. Signal points still use the usual reputation bands, so a boost changes alert points only when it crosses a band. It never bypasses the Phase 2 entry criteria. The Phase 1 wallet table shows the number of distinct qualifying tokens as **Your token hits**.

The submitted-token flag is captured on the pending scan and saved once per wallet/token pair. Reposts and rescans cannot stack the same token, dashboard-submitted tokens do not qualify, and past Discord messages cannot be safely attributed retroactively.

Optional tuning variables and defaults:

- `TRACKED_WALLET_LIMIT=100`
- `SIGNAL_WINDOW_MINUTES=60`
- `SIGNAL_MIN_DISTINCT_WALLETS=3`
- `SIGNAL_POINTS_THRESHOLD=6`
- `SIGNAL_REALERT_MIN_ADDITIONAL_POINTS=3`
- `TRACKED_WALLET_REFRESH_MINUTES=30`
- `HELIUS_RECONCILE_INTERVAL_MINUTES=60`
- `HELIUS_RECONCILE_MAX_PAGES=3`
- `HELIUS_MONTHLY_CREDIT_BUDGET=800000`
- `RECOVERY_DAILY_RPC_CALL_BUDGET=3000`
- `HELIUS_LIVE_DAILY_CREDIT_BUDGET=23166` (derived from the monthly budget, less recovery and a small buffer)
- `SOLANA_RECOVERY_RPC_URL` — optional private HTTPS Solana RPC endpoint from another provider; used only for recovery calls, never the live webhook
- `SIGNAL_MIN_BUY_LAMPORTS=10000000`
- `SIGNAL_MIN_STABLE_RAW=1000000`

The service creates or updates one enhanced Helius SWAP webhook only when its tracked address set or callback URL changes. Incoming events are authenticated and saved before processing. Recovery checks are capped daily and use the optional separate RPC endpoint when configured, so they need not spend Helius credits. If the external endpoint fails, recovery retries later; it does not silently switch back to Helius and consume that budget.

The dashboard wallet limit remains the user's maximum. For the current free-credit budget, live tracking starts at a cost-safe maximum of 40 wallets; after three hours of measured traffic it automatically adjusts the active set toward the daily live-credit target, at most every two hours. This changes only Phase 2 monitoring, not Phase 1 scanning or wallet labels. A lower active count means fewer wallet buys can contribute to alerts, so the dashboard shows both the requested and effective limits.

## Private status

Open `/phase2` on the existing authenticated dashboard. The page shows tracked-wallet count, provider state, genuine buys, duplicates, open accumulations and delivered signals. Its Discord test button sends a labelled test and does not create a fake signal.

If the tracked-wallet count is zero, Phase 2 is waiting for profiles to satisfy the configured entry criteria.
