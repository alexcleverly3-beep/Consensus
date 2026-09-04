"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createGmgnGuardStateStore } = require("../src/gmgn-guard-state");

test("GMGN limiter state survives a database-backed store round trip", () => {
  const db = new Database(":memory:");
  const store = createGmgnGuardStateStore(db);
  store.save({
    windowStartedAt: 1000,
    freshCalls: 3,
    effectiveMaxFreshCalls: 4,
    rateLimitEvents: 2,
    cleanWindows: 1,
    windowRateLimits: 0,
    blockedUntil: 5000,
    ignored: "not persisted",
  });

  assert.deepEqual(store.load(), {
    windowStartedAt: 1000,
    freshCalls: 3,
    effectiveMaxFreshCalls: 4,
    rateLimitEvents: 2,
    cleanWindows: 1,
    windowRateLimits: 0,
    blockedUntil: 5000,
  });
  db.close();
});

test("invalid persisted limiter state fails closed to an empty state", () => {
  const db = new Database(":memory:");
  const store = createGmgnGuardStateStore(db);
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)")
    .run("gmgn_guard_state_v1", "not-json");
  assert.deepEqual(store.load(), {});
  db.close();
});

