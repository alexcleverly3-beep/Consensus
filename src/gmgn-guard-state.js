"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { resolveDbPath } = require("./runtime-config");

const STATE_KEY = "gmgn_guard_state_v1";
const STATE_FIELDS = [
  "windowStartedAt",
  "freshCalls",
  "effectiveMaxFreshCalls",
  "rateLimitEvents",
  "cleanWindows",
  "windowRateLimits",
  "blockedUntil",
];

function cleanState(value = {}) {
  const state = {};
  for (const field of STATE_FIELDS) {
    const n = Number(value[field]);
    if (Number.isFinite(n) && n >= 0) state[field] = Math.floor(n);
  }
  return state;
}

function createGmgnGuardStateStore(db) {
  if (!db?.prepare || !db?.exec) throw new Error("a sqlite database is required");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const getStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const putStmt = db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  return {
    load() {
      const raw = getStmt.get(STATE_KEY)?.value;
      if (!raw) return {};
      try {
        return cleanState(JSON.parse(raw));
      } catch {
        return {};
      }
    },
    save(state) {
      const cleaned = cleanState(state);
      putStmt.run(STATE_KEY, JSON.stringify(cleaned));
      return cleaned;
    },
  };
}

function openGmgnGuardState({ dbPath = resolveDbPath() } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return { db, ...createGmgnGuardStateStore(db) };
}

module.exports = {
  STATE_KEY,
  cleanState,
  createGmgnGuardStateStore,
  openGmgnGuardState,
};

