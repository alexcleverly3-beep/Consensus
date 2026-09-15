"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initRecurrenceStore } = require("../src/recurrence-discovery");
const { initPhase2WalletLab, renderPhase2WalletLab, scoreWalletActivity } = require("../src/phase2-wallet-lab");
const { createRecurrenceDashboardStore } = require("../src/recurrence-dashboard");

const WALLET = "A".repeat(32);
const TOKEN_CHARS = ["B","C","D","E","F","G","H","J","K","L","M","N"];
const TOKENS = TOKEN_CHARS.map((char) => char.repeat(32));

function activity() {
  const list = [];
  let t = 1_700_000_000;
  TOKENS.forEach((token, i) => {
    list.push({ event_type: "buy", token_address: token, timestamp: t + i * 7200 });
    list.push({ event_type: "sell", token_address: token, timestamp: t + i * 7200 + 5400 });
  });
  return { data: { list } };
}

test("phase2 lab produces a bounded provisional score with evidence metrics", () => {
  const result = scoreWalletActivity(activity(), { distinctTokens: 4, top10Tokens: 3 });
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.equal(result.version, "phase2-lab-v0.1");
  assert.equal(result.metrics.distinctBoughtTokens, 12);
  assert.equal(result.metrics.pairedHoldTokens, 12);
  assert.equal(result.metrics.recurrenceDistinctTokens, 4);
  assert.equal(result.metrics.rapidFlipRate, 0);
});

test("phase2 lab stores analysis separately from human good/bad calibration", () => {
  const db = new Database(":memory:");
  initRecurrenceStore(db);
  const lab = initPhase2WalletLab(db, { now: () => 123456 });
  const first = lab.analyze(WALLET, activity());
  assert.equal(first.humanLabel, "unsure");
  lab.label(WALLET, "good");
  const stored = lab.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].humanLabel, "good");
  assert.equal(stored[0].analyzedAt, 123456);
  assert.equal(stored[0].analysis.version, "phase2-lab-v0.1");
  db.close();
});

test("known-good label survives re-analysis and is not used to inflate the score", () => {
  let now = 100;
  const db = new Database(":memory:");
  initRecurrenceStore(db);
  const lab = initPhase2WalletLab(db, { now: () => now });
  const before = lab.analyze(WALLET, activity()).score;
  lab.label(WALLET, "good");
  now = 200;
  const after = lab.analyze(WALLET, activity());
  assert.equal(after.score, before);
  assert.equal(after.humanLabel, "good");
  assert.equal(lab.list()[0].humanLabel, "good");
  db.close();
});

test("phase2 cards share the private checked marker without changing calibration", () => {
  const db = new Database(":memory:");
  initRecurrenceStore(db);
  const lab = initPhase2WalletLab(db, { now: () => 123456 });
  lab.analyze(WALLET, activity());
  createRecurrenceDashboardStore(db, { now: () => 123999 }).setWalletChecked(WALLET, true);

  const item = lab.list()[0];
  assert.equal(item.checked, true);
  assert.equal(item.checkedAt, 123999);
  assert.equal(item.humanLabel, "unsure");
  const html = renderPhase2WalletLab([item], "csrf-test");
  assert.match(html, /action="\/actions\/wallet\/checked"/);
  assert.match(html, /name="returnTo" value="\/phase2"/);
  assert.match(html, /name="checked" value="0"/);
  assert.match(html, /✓ Checked/);
  db.close();
});

test("phase2 dashboard shows the provider's safe configuration diagnostic", () => {
  const html = renderPhase2WalletLab([], "csrf-test", "", {
    status: {
      provider: {
        status: "needs-configuration",
        last_error: "Missing or invalid Railway variable: HELIUS_API_KEY",
      },
    },
  });
  assert.match(html, /Helius setup:/);
  assert.match(html, /HELIUS_API_KEY/);
});

test("phase2 dashboard displays refresh time, daily Helius usage, and the exact Phase 1 entry gate", () => {
  const html = renderPhase2WalletLab([], "csrf-test", "", {
    status: {
      lastWalletRefreshAt: Date.parse("2026-09-15T00:10:00Z"),
      estimatedHeliusCreditsToday: 321,
      config: {
        trackedWalletLimit: 100,
        minDistinctWallets: 3,
        pointsThreshold: 6,
        signalWindowMs: 3_600_000,
        phase1LeaderboardGate: {
          minDistinctTokens: 10,
          minTop10Tokens: 1,
          maxAverageRank: 50,
        },
      },
    },
  });
  assert.match(html, /Last wallet refresh/);
  assert.match(html, /15 Sept, 01:10:00 UK/);
  assert.match(html, /Helius credits today/);
  assert.match(html, />321</);
  assert.match(html, /10\+ distinct Phase 1 tokens/);
  assert.match(html, /1\+ top-10 appearances/);
  assert.match(html, /average rank 50 or better/);
  assert.match(html, /Creator and insider wallets are allowed/);
  assert.match(html, /top 100 qualifying wallets/);
  assert.match(html, /Phase 2 controls/);
  assert.match(html, /action="\/actions\/phase2\/settings"/);
  assert.match(html, /Alert at 3\+ wallets and 6\+ points/);
});

test("phase2 dashboard warns on excessive daily Helius usage and shows the source", () => {
  const html = renderPhase2WalletLab([], "csrf-test", "", {
    status: {
      estimatedHeliusCreditsToday: 52_000,
      monthlyCreditBudget: 800_000,
      dailyCreditAllowance: 26_666,
      heliusUsageTodayByKind: {
        "webhook-delivery": { calls: 40_000, credits: 40_000 },
        rpc: { calls: 12_000, credits: 12_000 },
      },
    },
  });
  assert.match(html, /Credit warning:/);
  assert.match(html, /40000 live events/);
  assert.match(html, /12000 recovery checks/);
  assert.match(html, /Live \/ recovery today/);
});
