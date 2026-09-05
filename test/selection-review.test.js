"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { POLICY, DAY, HOUR, parseBuy, cohortFromBuys, evaluateOpportunity, assess, initSelectionReview } = require("../src/selection-review");
const { renderReviewPage } = require("../src/selection-review-page");
const { selectionTokenInfo } = require("../src/selection-token-info");
const AT = Math.floor(1786000000000 / HOUR) * HOUR;
const address = (i) => "A".repeat(30) + String(i).replaceAll("0", "z").padStart(5, "B");
const buy = (i = 0) => ({ token: address(i), at: AT + i * DAY, tx: `tx${i}`, price: 1, cost: 100, symbol: "Test" });
function candles(b = buy(), multiple = 3) {
  const start = (Math.floor(b.at / HOUR) + 1) * HOUR;
  return { list: Array.from({ length: 167 }, (_, i) => ({ time: start + i * HOUR,
    open: "1", close: String(multiple), low: "0.8", high: String(multiple), volume: "6000" })) };
}
function cohort() { return Array.from({ length: 30 }, (_, i) => buy(i)); }
function outcomes(c = cohort(), multiple = 3) {
  return Object.fromEntries(c.map((b) => [b.token, evaluateOpportunity(b, candles(b, multiple), AT + 60 * DAY)]));
}

test("selection: a losing seller can qualify from subsequent repeatable token opportunities", () => {
  const c = cohort().map((b) => ({ ...b, realizedProfit: -100, holdSec: 1 }));
  assert.equal(assess(c, outcomes(c), AT + 60 * DAY).eligible, true);
});
test("selection: price_usd, not quote price, anchors a purchase", () => {
  const b = parseBuy({ event_type: "buy", token: { address: address(1) }, timestamp: AT / 1000,
    tx_hash: "tx", cost_usd: "100", token_amount: "50", price_usd: "2", price: "0.00002" }, AT + DAY);
  assert.equal(b.price, 2);
});
test("selection: missing, conflicting and dust entry data cannot earn credit", () => {
  const row = { event_type: "buy", token: { address: address(1) }, timestamp: AT, tx_hash: "tx", cost_usd: 100, token_amount: 100 };
  assert.equal(parseBuy({ ...row, price_usd: 10 }, AT).price, null);
  assert.equal(parseBuy({ ...row, cost_usd: null }, AT).price, null);
  assert.equal(parseBuy({ ...row, cost_usd: 2 }, AT), null);
  assert.equal(parseBuy({ ...row, timestamp: AT + DAY }, AT), null);
});
test("selection: repeated purchases and multi-token routes cannot inflate independent wins", () => {
  const b = buy();
  assert.equal(cohortFromBuys([b, { ...b, at: AT + HOUR, tx: "later" }]).length, 1);
  const ambiguous = cohortFromBuys([b, { ...buy(1), tx: b.tx }]);
  assert.ok(ambiguous.every((x) => x.price === null));
});
test("selection: entry candle and isolated high wick do not create an opportunity", () => {
  const b = buy(), data = candles(b, 1);
  data.list.unshift({ time: AT, close: 10000, low: 1, high: 10000, volume: 1e9 });
  data.list[2].high = "10000";
  const result = evaluateOpportunity(b, data, AT + 8 * DAY);
  assert.equal(result.sustainedMultiple, 1);
  assert.equal(result.peakMultiple, 10000);
});
test("selection: sustained upside remains selection evidence after collapse", () => {
  const data = candles();
  data.list.at(-1).close = "0.1";
  data.list.at(-1).low = "0.1";
  const result = evaluateOpportunity(buy(), data, AT + 8 * DAY);
  assert.equal(result.sustainedMultiple, 3);
  assert.equal(result.endMultiple, 0.1);
});
test("selection: thin volume and nonconsecutive candles do not establish sustained upside", () => {
  const thin = candles(); thin.list.forEach((c) => { c.volume = 1; });
  assert.equal(evaluateOpportunity(buy(), thin, AT + 8 * DAY).sustainedMultiple, 0);
  const single = candles(buy(), 1); single.list[10].close = 3; single.list[10].high = 3;
  single.list[12].close = 3; single.list[12].high = 3;
  assert.equal(evaluateOpportunity(buy(), single, AT + 8 * DAY).sustainedMultiple, 1);
});
test("selection: incomplete, duplicated or future histories cannot mature a result", () => {
  const data = candles(); data.list = data.list.slice(0, 30);
  data.list.push(...data.list, ...data.list);
  assert.equal(evaluateOpportunity(buy(), data, AT + 8 * DAY).status, "unknown");
  assert.equal(evaluateOpportunity(buy(), candles(), AT + DAY).status, "pending");
  assert.throws(() => evaluateOpportunity(buy(), { unexpected: [] }, AT + 8 * DAY), /shape/);
});
test("selection: jackpots, broad failures and missing histories cannot qualify", () => {
  const c = cohort(), e = outcomes(c, 0.4);
  e[c[0].token] = { status: "measured", sustainedMultiple: 10000 };
  assert.equal(assess(c, e, AT + 60 * DAY).eligible, false);
  const good = outcomes(c);
  c.slice(0, 10).forEach((b) => { delete good[b.token]; });
  const a = assess(c, good, AT + 60 * DAY);
  assert.equal(a.unknown, 10);
  assert.equal(a.eligible, false);
  assert.equal(a.hitRate, 20 / 30);
});
test("selection: history paging persists, freezes before outcomes, and detects repeated pages", async () => {
  const db = new Database(":memory:"), clock = AT + 60 * DAY;
  let store = initSelectionReview(db, { now: () => clock });
  store.ingest([{ address: address(100), buy_tx_count_cur: 1 }], address(999));
  const page = { activities: cohort().slice(0, 5).map((b) => ({ event_type: "buy", token: { address: b.token },
    timestamp: b.at, tx_hash: b.tx, cost_usd: b.cost, price_usd: b.price })), next: "cursor-next" };
  await store.tick({ fetchActivity: async (_, cursor) => { assert.equal(cursor, null); return page; } });
  store = initSelectionReview(db, { now: () => clock });
  await store.tick({ fetchActivity: async (_, cursor) => { assert.equal(cursor, "cursor-next"); return page; } });
  assert.equal(store.diagnostics()[0].state, "insufficient");
  db.close();
});
test("selection: request failures leave history cursor and evidence untouched", async () => {
  const db = new Database(":memory:"), store = initSelectionReview(db, { now: () => AT });
  store.ingest([{ address: address(100), buy_tx_count_cur: 1 }], address(999));
  await assert.rejects(store.tick({ fetchActivity: async () => { throw new Error("429 cooldown"); } }), /429/);
  assert.equal(store.diagnostics()[0].pages, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM selection_buys").get().n, 0);
  db.close();
});
test("selection: complete history advances through bounded candle jobs to evaluation", async () => {
  const db = new Database(":memory:"), clock = AT + 60 * DAY;
  const store = initSelectionReview(db, { now: () => clock });
  store.ingest([{ address: address(100), buy_tx_count_cur: 1 }], address(999));
  let calls = 0;
  const fetchActivity = async () => { calls++; return { activities: cohort().map((b) => ({
    event_type: "buy", token: { address: b.token }, timestamp: b.at, tx_hash: b.tx,
    cost_usd: b.cost, price_usd: b.price })), next: null }; };
  const fetchCandles = async (b) => { calls++; return candles(b); };
  await store.tick({ fetchActivity, fetchCandles });
  assert.equal(store.diagnostics()[0].state, "evaluating");
  for (let i = 0; i < 31; i++) {
    const before = calls;
    await store.tick({ fetchActivity, fetchCandles });
    assert.ok(calls - before <= 1);
  }
  assert.equal(calls, 31);
  assert.equal(store.diagnostics()[0].state, "evaluated");
  assert.equal(JSON.parse(store.diagnostics()[0].assessment_json).eligible, true);
  // A single good candidate still cannot prematurely close a 100-wallet group.
  assert.equal(store.shortlist().length, 0); db.close();
});
test("selection: unknown histories retry daily, then finish as unknown not as wins", async () => {
  const db = new Database(":memory:"); let clock = AT + 60 * DAY;
  const store = initSelectionReview(db, { now: () => clock }), b = buy();
  store.ingest([{ address: address(100), buy_tx_count_cur: 1 }], address(999));
  db.prepare("UPDATE selection_candidates SET state='evaluating',cohort_json=?").run(JSON.stringify([b]));
  let requests = 0;
  const fetchCandles = async () => { requests++; return { list: [] }; };
  for (let i = 0; i < 3; i++) {
    await store.tick({ fetchCandles }); await store.tick({ fetchCandles }); clock += DAY;
  }
  await store.tick({ fetchCandles });
  assert.equal(requests, 3);
  assert.equal(store.diagnostics()[0].state, "evaluated");
  const a = JSON.parse(store.diagnostics()[0].assessment_json);
  assert.equal(a.unknown, 1); assert.equal(a.eligible, false); db.close();
});
test("selection: additive migration preserves legacy data and is restart safe", () => {
  const db = new Database(":memory:"); db.exec("CREATE TABLE wallet_profiles(wallet TEXT); INSERT INTO wallet_profiles VALUES ('legacy')");
  initSelectionReview(db); initSelectionReview(db);
  assert.equal(db.prepare("SELECT wallet FROM wallet_profiles").get().wallet, "legacy"); db.close();
});
test("selection: only completed 100-wallet groups freeze ranked qualified reports; cap ten", () => {
  const db = new Database(":memory:"), store = initSelectionReview(db, { now: () => AT + 60 * DAY });
  const c = cohort(), e = outcomes(c);
  for (let i = 0; i < 100; i++) {
    const wallet = address(1000 + i);
    store.ingest([{ address: wallet, buy_tx_count_cur: 1 }], address(999));
    db.prepare("UPDATE selection_candidates SET state='evaluated',cohort_json=? WHERE wallet=?").run(JSON.stringify(c), wallet);
    for (const b of c) db.prepare("INSERT INTO selection_evaluations(wallet,token,json) VALUES (?,?,?)").run(wallet, b.token, JSON.stringify(e[b.token]));
    if (i === 98) { store.closeGroups(); assert.equal(store.shortlist().length, 0); }
  }
  // Known shared funding is not ten independent entities.
  for (const c of db.prepare("SELECT id,wallet FROM selection_candidates").all()) {
    db.prepare("UPDATE selection_candidates SET funding_address=? WHERE wallet=?").run(address(800 + c.id % 20), c.wallet);
  }
  store.closeGroups();
  assert.equal(store.shortlist().length, 10);
  assert.equal(new Set(store.shortlist().map((r) => r.fundingAddress)).size, 10);
  const before = JSON.stringify(store.shortlist());
  db.prepare("UPDATE selection_evaluations SET json=?").run(JSON.stringify({ status: "unknown" }));
  store.closeGroups();
  assert.equal(JSON.stringify(store.shortlist()), before);
  assert.equal(store.ingest([{ address: address(55555) }], address(999)), 0);
  db.close();
});
test("selection: a completed group with weak evidence is not padded", () => {
  const db = new Database(":memory:"), store = initSelectionReview(db);
  for (let i = 0; i < 100; i++) store.ingest([{ address: address(1000 + i) }], address(999));
  db.exec("UPDATE selection_candidates SET state='insufficient'");
  store.closeGroups(); assert.equal(store.shortlist().length, 0);
  assert.equal(store.progress().completedGroups, 1); db.close();
});
test("selection: nested current GMGN token info is normalized without mutating input", () => {
  const raw = { price: { price: "2", volume_24h: "50000" }, circulating_supply: "100000", stat: { holder_count: 900 }, liquidity: "50000" };
  assert.equal(selectionTokenInfo(raw).market_cap, 200000);
  assert.equal(selectionTokenInfo(raw).holder_count, 900);
  assert.equal(raw.price.price, "2");
  assert.equal(selectionTokenInfo({ price: null, circulating_supply: 10 }).market_cap, null);
});
test("selection: private page escapes external metadata and labels the experiment honestly", () => {
  const html = renderReviewPage({ saved: 0, target: 10, discovered: 100, completedGroups: 1, groupSize: 100 }, [],
    [{ wallet: '<script>alert(1)</script>', state: "insufficient", pages: 1, last_error: "<svg>" }]);
  assert.doesNotMatch(html, /<script>|<svg>/);
  assert.match(html, /existing scanner, scores and alerts are unchanged/);
  assert.match(html, /No candidates saved yet/);
});
