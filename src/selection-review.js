"use strict";

// An additive, versioned research experiment. Never reads legacy P&L scores to
// qualify a wallet, and never changes the existing alert/learning decisions.
const { createHash } = require("node:crypto");
const { defaultTraderFilter } = require("./discovery-engine");
const { nextCursor } = require("./seed-history");
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE_TOKENS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const POLICY = Object.freeze({ version: "selection-review-v1", groupSize: 100,
  target: 10, minTokens: 20, historyTarget: 30, minSpanDays: 14,
  maxHistoryPages: 10, maxCohortTokens: 200, horizonDays: 7,
  minBuyUsd: 25, minCoverage: 0.80, minTwoXRate: 0.40,
  minThreeX: 3, minMedian: 1.5, minWilson: 0.25,
  minCandleVolumeUsd: 5000, minCandleCoverage: 0.90 });

function number(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function timestamp(value) {
  const n = number(value);
  return n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
}
function rows(response, keys) {
  const payload = response?.data ?? response;
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  throw new Error("Unrecognized GMGN response shape; evidence not advanced");
}
function parseBuy(row, cutoff) {
  const kind = String(row.event_type ?? row.type ?? "").toLowerCase();
  if (kind !== "buy") return null;
  const token = row.token?.address;
  const at = timestamp(row.timestamp);
  const tx = row.tx_hash ?? row.transaction_hash;
  if (!ADDRESS.test(token || "") || !at || at > cutoff || typeof tx !== "string" || !tx) return null;
  if (BASE_TOKENS.has(token)) return null;
  const cost = number(row.cost_usd);
  // Dust is excluded by a documented size floor, never by its later result.
  // Unknown cost stays in the denominator instead of silently disappearing.
  if (cost != null && cost < POLICY.minBuyUsd) return null;
  const amount = number(row.token_amount);
  const explicitPrice = number(row.price_usd);
  const derivedPrice = cost > 0 && amount > 0 ? cost / amount : null;
  const price = explicitPrice > 0 ? explicitPrice : derivedPrice;
  const mismatch = explicitPrice > 0 && derivedPrice > 0 &&
    Math.abs(explicitPrice / derivedPrice - 1) > 0.20;
  return { token, at, tx, cost, price: price > 0 && !mismatch && cost != null ? price : null,
    symbol: String(row.token?.symbol || "").slice(0, 40),
    quote: row.quote_address ?? row.quote_token?.token_address ?? null };
}
function cohortFromBuys(buys) {
  const byToken = new Map();
  const byTx = new Map();
  for (const buy of buys) {
    if (!byTx.has(buy.tx)) byTx.set(buy.tx, new Set());
    byTx.get(buy.tx).add(buy.token);
    if (!byToken.has(buy.token) || buy.at < byToken.get(buy.token).at) byToken.set(buy.token, buy);
  }
  return [...byToken.values()].map((buy) => ({ ...buy,
    // Multi-token routes can masquerade as multiple independent selections.
    price: byTx.get(buy.tx).size > 1 ? null : buy.price,
  })).sort((a, b) => a.at - b.at || a.token.localeCompare(b.token));
}
function evaluateOpportunity(buy, response, now = Date.now()) {
  const end = buy.at + POLICY.horizonDays * DAY;
  if (now < end) return { status: "pending", reason: "horizon-not-complete" };
  if (!(buy.price > 0)) return { status: "unknown", reason: "unverified-entry-price" };
  // Exclude the entry candle: its high/low/close may precede the purchase.
  const start = (Math.floor(buy.at / HOUR) + 1) * HOUR;
  const expected = Math.floor((end - start) / HOUR);
  const unique = new Map();
  for (const row of rows(response, ["list"])) {
    const time = timestamp(row.time);
    const close = number(row.close), low = number(row.low), high = number(row.high);
    const volume = number(row.volume);
    if (!time || time % HOUR !== 0 || time < start || time + HOUR > end) continue;
    if (!(close > 0 && low > 0 && high >= close && low <= close && volume >= 0)) continue;
    unique.set(time, { time, close, low, high, volume });
  }
  const candles = [...unique.values()].sort((a, b) => a.time - b.time);
  const coverage = expected > 0 ? candles.length / expected : 0;
  if (coverage < POLICY.minCandleCoverage || candles[0]?.time !== start ||
      candles.at(-1)?.time + HOUR < end - HOUR) {
    return { status: "unknown", reason: "incomplete-candle-history", coverage };
  }
  let sustained = 0, peak = 0, trough = 1, troughBeforeTwoX = 1, timeToTwoXHours = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], previous = candles[i - 1];
    peak = Math.max(peak, c.high / buy.price);
    trough = Math.min(trough, c.low / buy.price);
    if (timeToTwoXHours == null) troughBeforeTwoX = Math.min(troughBeforeTwoX, c.low / buy.price);
    if (!previous || c.time - previous.time !== HOUR) continue;
    if (Math.min(c.volume, previous.volume) < POLICY.minCandleVolumeUsd) continue;
    const opportunity = Math.min(c.close, previous.close) / buy.price;
    sustained = Math.max(sustained, opportunity);
    if (opportunity >= 2 && timeToTwoXHours == null) timeToTwoXHours = (c.time + HOUR - buy.at) / HOUR;
  }
  return { status: "measured", sustainedMultiple: sustained, peakMultiple: peak,
    endMultiple: candles.at(-1).close / buy.price, worstMultiple: trough,
    troughBeforeTwoX, timeToTwoXHours, coverage,
    // Volume is an observable screen, NOT a reconstruction of historical liquidity.
    liquidityEvidence: "two consecutive hourly closes with >=$5k volume each; historical depth unknown" };
}
function median(values) {
  const v = [...values].sort((a, b) => a - b), i = Math.floor(v.length / 2);
  return v.length ? (v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2) : 0;
}
function wilson(wins, total) {
  if (!total) return 0;
  const z = 1.96, p = wins / total;
  return (p + z * z / (2 * total) - z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)) / (1 + z * z / total);
}
function assess(cohort, evaluations, now = Date.now()) {
  const due = cohort.filter((b) => b.at + POLICY.horizonDays * DAY <= now);
  const measured = due.map((b) => evaluations[b.token]).filter((e) => e?.status === "measured");
  const twoX = measured.filter((e) => e.sustainedMultiple >= 2).length;
  const threeX = measured.filter((e) => e.sustainedMultiple >= 3).length;
  // Unknown outcomes remain in the hit-rate and median denominator.
  const multiples = due.map((b) => Math.min(20, evaluations[b.token]?.sustainedMultiple || 0));
  const spanDays = cohort.length ? (cohort.at(-1).at - cohort[0].at) / DAY : 0;
  const coverage = due.length ? measured.length / due.length : 0;
  const hitRate = due.length ? twoX / due.length : 0;
  const lowerBound = wilson(twoX, due.length);
  const medianMultiple = median(multiples);
  const reasons = [];
  if (cohort.length < POLICY.minTokens) reasons.push("fewer-than-20-independent-selections");
  if (spanDays < POLICY.minSpanDays) reasons.push("less-than-14-days-of-entry-breadth");
  if (due.length !== cohort.length) reasons.push("waiting-for-seven-day-outcomes");
  if (coverage < POLICY.minCoverage) reasons.push("insufficient-price-history-coverage");
  if (hitRate < POLICY.minTwoXRate) reasons.push("too-few-sustained-2x-opportunities");
  if (threeX < POLICY.minThreeX) reasons.push("fewer-than-three-sustained-3x-opportunities");
  if (medianMultiple < POLICY.minMedian) reasons.push("weak-typical-selection");
  if (lowerBound < POLICY.minWilson) reasons.push("insufficient-repeatability-evidence");
  return { eligible: reasons.length === 0, reasons, tokens: cohort.length, measured: measured.length,
    unknown: due.length - measured.length, pending: cohort.length - due.length,
    spanDays, coverage, twoX, threeX, hitRate, lowerBound, medianMultiple,
    score: Math.round(100 * (0.7 * lowerBound + 0.3 * Math.min(1, medianMultiple / 3))),
    policyVersion: POLICY.version };
}

function initSelectionReview(db, { now = Date.now } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS selection_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL UNIQUE,
      discovered_at INTEGER NOT NULL, source_token TEXT, funding_address TEXT,
      state TEXT NOT NULL DEFAULT 'queued', cutoff INTEGER, cursor TEXT,
      pages INTEGER NOT NULL DEFAULT 0, fingerprints TEXT NOT NULL DEFAULT '[]',
      cohort_json TEXT, assessment_json TEXT, next_attempt INTEGER NOT NULL DEFAULT 0,
      last_attempt INTEGER, last_success INTEGER, last_error TEXT);
    CREATE TABLE IF NOT EXISTS selection_buys (
      wallet TEXT NOT NULL, token TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL,
      json TEXT NOT NULL, PRIMARY KEY(wallet, token, tx));
    CREATE TABLE IF NOT EXISTS selection_evaluations (
      wallet TEXT NOT NULL, token TEXT NOT NULL, json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1, next_attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(wallet, token));
    CREATE TABLE IF NOT EXISTS selection_review_batches (
      group_id INTEGER PRIMARY KEY, completed_at INTEGER NOT NULL, candidate_count INTEGER NOT NULL,
      eligible_count INTEGER NOT NULL, selected_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS selection_manual_queue (
      wallet TEXT PRIMARY KEY, group_id INTEGER NOT NULL, saved_at INTEGER NOT NULL,
      report_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS selection_work ON selection_candidates(state, next_attempt, last_attempt);
    CREATE TABLE IF NOT EXISTS selection_discovery_tokens (
      token TEXT PRIMARY KEY, info_json TEXT NOT NULL, last_scan INTEGER NOT NULL DEFAULT 0);
  `);
  const insertCandidate = db.prepare(`INSERT OR IGNORE INTO selection_candidates
    (wallet, discovered_at, source_token, funding_address) VALUES (?, ?, ?, ?)`);
  const getCandidate = db.prepare("SELECT * FROM selection_candidates WHERE wallet = ?");
  const buyStmt = db.prepare("INSERT OR IGNORE INTO selection_buys VALUES (?, ?, ?, ?, ?)");
  const getBuys = (wallet) => db.prepare("SELECT json FROM selection_buys WHERE wallet = ? ORDER BY at").all(wallet).map((b) => JSON.parse(b.json));
  const evals = (wallet) => Object.fromEntries(db.prepare("SELECT token, json FROM selection_evaluations WHERE wallet = ?").all(wallet).map((e) => [e.token, JSON.parse(e.json)]));
  const queuedCount = () => db.prepare("SELECT COUNT(*) n FROM selection_manual_queue").get().n;

  function ingest(traders, token, tokenInfo = {}) {
    if (queuedCount() >= POLICY.target) return 0;
    const total = db.prepare("SELECT COUNT(*) n FROM selection_candidates").get().n;
    const complete = db.prepare("SELECT COUNT(*) n FROM selection_review_batches").get().n * POLICY.groupSize;
    let added = 0;
    // Bound pending work to three groups; keep the existing scanner unaffected.
    for (const trader of traders) {
      if (total + added >= complete + 300) break;
      if (defaultTraderFilter(trader, tokenInfo.dev?.creator_address)) continue;
      const wallet = trader.address || trader.wallet_address || trader.wallet;
      const funding = trader.native_transfer?.address;
      added += insertCandidate.run(wallet, now(), token,
        ADDRESS.test(funding || "") ? funding : null).changes;
    }
    return added;
  }
  const savePage = db.transaction((wallet, response) => {
    const candidate = getCandidate.get(wallet);
    const cutoff = candidate.cutoff || now();
    const activity = rows(response, ["activities", "list"]);
    const fingerprint = createHash("sha256").update(JSON.stringify(activity)).digest("hex");
    const fingerprints = JSON.parse(candidate.fingerprints);
    const cursor = nextCursor(response);
    if (fingerprints.includes(fingerprint) || (cursor && cursor === candidate.cursor)) {
      db.prepare("UPDATE selection_candidates SET state='insufficient', last_error=? WHERE wallet=?")
        .run("Duplicate history page/cursor; incomplete history is not qualified", wallet);
      return;
    }
    for (const row of activity) {
      const buy = parseBuy(row, cutoff);
      if (buy) buyStmt.run(wallet, buy.token, buy.tx, buy.at, JSON.stringify(buy));
    }
    const cohort = cohortFromBuys(getBuys(wallet));
    const pages = candidate.pages + 1;
    const span = cohort.length ? cohort.at(-1).at - cohort[0].at : 0;
    const enough = cohort.length >= POLICY.historyTarget && span >= POLICY.minSpanDays * DAY;
    const overflow = cohort.length > POLICY.maxCohortTokens;
    const exhausted = !cursor;
    const capped = pages >= POLICY.maxHistoryPages && !enough && !exhausted;
    const state = overflow || capped ? "insufficient" : enough || exhausted ? "evaluating" : "history";
    fingerprints.push(fingerprint);
    db.prepare(`UPDATE selection_candidates SET cutoff=?, cursor=?, pages=?, fingerprints=?, state=?,
      cohort_json=?, last_success=?, last_error=?, next_attempt=0 WHERE wallet=?`).run(cutoff, cursor,
      pages, JSON.stringify(fingerprints), state, state === "history" ? null : JSON.stringify(cohort), now(),
      overflow || capped ? "Bounded history incomplete or excessively broad; no promotion" : null, wallet);
    if (state === "evaluating" && (cohort.length < POLICY.minTokens || span < POLICY.minSpanDays * DAY)) {
      db.prepare("UPDATE selection_candidates SET state='insufficient', assessment_json=? WHERE wallet=?")
        .run(JSON.stringify(assess(cohort, {}, now())), wallet);
    }
  });

  function report(candidate) {
    const cohort = JSON.parse(candidate.cohort_json || "[]"), evaluations = evals(candidate.wallet);
    return { wallet: candidate.wallet, sourceToken: candidate.source_token,
      fundingAddress: candidate.funding_address, assessedAt: now(),
      assessment: assess(cohort, evaluations, now()),
      evidence: cohort.map((buy) => ({ ...buy, outcome: evaluations[buy.token] || { status: "pending" } })),
      limitations: ["Seven-day historical selection screen, not a prediction or trade recommendation",
        "Entries are earliest qualifying buys within a bounded retrieved history, not necessarily lifetime first buys",
        "Historical liquidity and beneficial ownership are not verified; candle volume is only a screen",
        "No matched-market baseline or forward-performance validation yet"] };
  }
  const closeGroups = db.transaction(() => {
    const all = db.prepare("SELECT * FROM selection_candidates ORDER BY id").all();
    for (let offset = 0; offset + POLICY.groupSize <= all.length; offset += POLICY.groupSize) {
      const groupId = offset / POLICY.groupSize + 1;
      if (db.prepare("SELECT 1 FROM selection_review_batches WHERE group_id=?").get(groupId)) continue;
      const group = all.slice(offset, offset + POLICY.groupSize);
      if (group.some((c) => !["evaluated", "insufficient"].includes(c.state))) continue;
      const eligible = group.filter((c) => c.state === "evaluated").map(report).filter((r) => r.assessment.eligible)
        .sort((a, b) => b.assessment.score - a.assessment.score || a.wallet.localeCompare(b.wallet));
      const existing = db.prepare("SELECT report_json FROM selection_manual_queue").all().map((r) => JSON.parse(r.report_json));
      const funders = new Set(existing.map((r) => r.fundingAddress).filter(Boolean));
      let selected = 0;
      for (const r of eligible) {
        if (queuedCount() >= POLICY.target) break;
        if (r.fundingAddress && funders.has(r.fundingAddress)) continue;
        db.prepare("INSERT OR IGNORE INTO selection_manual_queue VALUES (?, ?, ?, ?)")
          .run(r.wallet, groupId, now(), JSON.stringify(r));
        if (r.fundingAddress) funders.add(r.fundingAddress);
        selected++;
      }
      db.prepare("INSERT INTO selection_review_batches VALUES (?, ?, ?, ?, ?)")
        .run(groupId, now(), group.length, eligible.length, selected);
    }
  });

  async function tick({ fetchActivity, fetchCandles }) {
    closeGroups();
    if (queuedCount() >= POLICY.target) return { kind: "complete" };
    const candidates = db.prepare(`SELECT * FROM selection_candidates
      WHERE state IN ('queued','history','evaluating') AND next_attempt<=?
      ORDER BY CAST((id-1)/100 AS INTEGER), COALESCE(last_attempt,0), id LIMIT 100`).all(now());
    for (const c of candidates) {
      let task;
      if (c.state === "queued" || c.state === "history") task = { kind: "history" };
      else {
        const cohort = JSON.parse(c.cohort_json), evaluations = evals(c.wallet);
        for (const b of cohort) {
          if (b.at + POLICY.horizonDays * DAY > now()) continue;
          const row = db.prepare("SELECT * FROM selection_evaluations WHERE wallet=? AND token=?").get(c.wallet, b.token);
          if (!row || (evaluations[b.token]?.status === "unknown" && row.attempts < 3 && row.next_attempt <= now())) {
            task = { kind: "candles", buy: b, attempts: row?.attempts || 0 }; break;
          }
        }
        if (!task) {
          const pending = cohort.some((b) => b.at + POLICY.horizonDays * DAY > now());
          const retry = db.prepare("SELECT MIN(next_attempt) at FROM selection_evaluations WHERE wallet=? AND attempts<3 AND json_extract(json,'$.status')='unknown'").get(c.wallet).at;
          if (!pending && !retry) {
            db.prepare("UPDATE selection_candidates SET state='evaluated', assessment_json=? WHERE wallet=?")
              .run(JSON.stringify(assess(cohort, evaluations, now())), c.wallet);
          } else {
            const next = Math.min(retry || Infinity, ...cohort.filter((b) => b.at + POLICY.horizonDays * DAY > now()).map((b) => b.at + POLICY.horizonDays * DAY));
            db.prepare("UPDATE selection_candidates SET next_attempt=? WHERE wallet=?").run(next, c.wallet);
          }
          continue;
        }
      }
      db.prepare("UPDATE selection_candidates SET last_attempt=?, cutoff=COALESCE(cutoff,?) WHERE wallet=?").run(now(), now(), c.wallet);
      try {
        if (task.kind === "history") savePage(c.wallet, await fetchActivity(c.wallet, c.cursor));
        else {
          const b = task.buy;
          const result = b.price > 0 ? evaluateOpportunity(b, await fetchCandles(b), now())
            : { status: "unknown", reason: "unverified-entry-price" };
          db.prepare(`INSERT INTO selection_evaluations VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(wallet,token) DO UPDATE SET json=excluded.json, attempts=excluded.attempts,next_attempt=excluded.next_attempt`)
            .run(c.wallet, b.token, JSON.stringify(result), b.price > 0 ? task.attempts + 1 : 3, now() + DAY);
          db.prepare("UPDATE selection_candidates SET last_success=?,last_error=NULL WHERE wallet=?").run(now(), c.wallet);
        }
        closeGroups();
        return { kind: task.kind, wallet: c.wallet };
      } catch (error) {
        // Do not advance a cursor or treat request failures as failed selections.
        db.prepare("UPDATE selection_candidates SET last_error=?,next_attempt=? WHERE wallet=?")
          .run(String(error.message || error).slice(0, 500), now() + HOUR, c.wallet);
        throw error;
      }
    }
    closeGroups();
    return { kind: "waiting" };
  }
  function progress() {
    const counts = db.prepare("SELECT state, COUNT(*) n FROM selection_candidates GROUP BY state").all();
    const total = counts.reduce((n, r) => n + r.n, 0);
    return { policy: POLICY.version, target: POLICY.target, saved: queuedCount(), discovered: total,
      groupSize: POLICY.groupSize, states: Object.fromEntries(counts.map((r) => [r.state, r.n])),
      completedGroups: db.prepare("SELECT COUNT(*) n FROM selection_review_batches").get().n,
      lastSuccess: db.prepare("SELECT MAX(last_success) at FROM selection_candidates").get().at,
      errored: db.prepare("SELECT COUNT(*) n FROM selection_candidates WHERE last_error IS NOT NULL AND state NOT IN ('insufficient','evaluated')").get().n };
  }
  return { ingest, tick, savePage, progress, closeGroups,
    recordToken: (token, info) => db.prepare(`INSERT INTO selection_discovery_tokens(token,info_json) VALUES (?,?)
      ON CONFLICT(token) DO UPDATE SET info_json=excluded.info_json`).run(token, JSON.stringify(info)),
    nextToken: () => db.prepare("SELECT * FROM selection_discovery_tokens WHERE last_scan<? ORDER BY last_scan,token LIMIT 1").get(now() - DAY),
    markToken: (token) => db.prepare("UPDATE selection_discovery_tokens SET last_scan=? WHERE token=?").run(now(), token),
    shortlist: () => db.prepare("SELECT group_id, saved_at, report_json FROM selection_manual_queue ORDER BY saved_at, wallet").all()
      .map((r) => ({ groupId: r.group_id, savedAt: r.saved_at, ...JSON.parse(r.report_json) })),
    // Candidate addresses are only exposed through the authenticated route.
    diagnostics: () => db.prepare("SELECT wallet,state,pages,last_error,assessment_json FROM selection_candidates ORDER BY id LIMIT 300").all(),
  };
}
module.exports = { POLICY, DAY, HOUR, parseBuy, cohortFromBuys, evaluateOpportunity, assess, initSelectionReview };
