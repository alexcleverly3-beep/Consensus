"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { initRecurrenceStore } = require("../src/recurrence-discovery");
const { findSolAddress, handlePriorityMessage } = require("../src/discord-priority-intake");

const TOKEN_A = "A".repeat(32);
const TOKEN_B = "B".repeat(32);

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Discord priority token jumps ahead of ordinary trending work and can requeue a scanned token", () => {
  const db = new Database(":memory:");
  const store = initRecurrenceStore(db);
  store.enqueueTrending({ data: { list: [{ address: TOKEN_A }, { address: TOKEN_B }] } }, 1000);

  const queued = store.enqueuePriorityToken(TOKEN_B, { observedAt: 2000, source: "discord" });
  assert.equal(queued.reprioritized, true);
  assert.equal(store.summary().priorityQueuedTokens, 1);
  assert.equal(store.nextToken().token_address, TOKEN_B);

  store.ingestTokenTraders({ tokenAddress: TOKEN_B, observedAt: 3000, traders: [] });
  assert.equal(store.summary().priorityQueuedTokens, 0);
  assert.equal(store.nextToken().token_address, TOKEN_A);

  store.enqueuePriorityToken(TOKEN_B, { observedAt: 4000, source: "discord" });
  assert.equal(store.nextToken().token_address, TOKEN_B);
  assert.equal(store.summary().priorityQueuedTokens, 1);
  db.close();
});

test("priority schema migration preserves an existing recurrence queue", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE recurrence_token_queue (
      token_address TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_scanned_at INTEGER,
      scan_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      trend_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO recurrence_token_queue(token_address, first_seen_at, last_seen_at)
    VALUES ('${TOKEN_A}', 1, 1);
  `);

  const store = initRecurrenceStore(db);
  const columns = db.prepare("PRAGMA table_info(recurrence_token_queue)").all().map((row) => row.name);
  assert.ok(columns.includes("priority"));
  assert.ok(columns.includes("source"));
  assert.ok(columns.includes("priority_queued_at"));
  assert.equal(store.summary().tokensSeen, 1);
  assert.equal(store.nextToken().token_address, TOKEN_A);
  db.close();
});

test("Discord message handler queues a CA and triggers an immediate recurrence cycle", async () => {
  const calls = [];
  let replies = 0;
  let triggered = 0;
  const store = {
    enqueuePriorityToken(address, options) {
      calls.push({ address, options });
      return { tokenAddress: address, added: true, reprioritized: false };
    },
  };
  const message = {
    author: { bot: false },
    channelId: "123",
    content: `scan this ${TOKEN_A} please`,
    async reply(text) {
      replies += 1;
      assert.match(text, /queued for priority trader scan/i);
    },
  };

  const result = await handlePriorityMessage(message, {
    store,
    env: { DISCORD_CHANNEL_ID: "123" },
    onQueued: async () => { triggered += 1; },
  });
  await tick();

  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, TOKEN_A);
  assert.equal(calls[0].options.source, "discord");
  assert.equal(replies, 1);
  assert.equal(triggered, 1);
});

test("Discord priority intake ignores bots, wrong channels and messages without a Solana address", async () => {
  let queued = 0;
  const store = { enqueuePriorityToken() { queued += 1; } };
  const env = { DISCORD_CHANNEL_ID: "allowed" };

  assert.equal((await handlePriorityMessage({ author: { bot: true }, channelId: "allowed", content: TOKEN_A }, { store, env })).handled, false);
  assert.equal((await handlePriorityMessage({ author: { bot: false }, channelId: "other", content: TOKEN_A }, { store, env })).handled, false);
  assert.equal((await handlePriorityMessage({ author: { bot: false }, channelId: "allowed", content: "hello" }, { store, env })).handled, false);
  assert.equal(queued, 0);
  assert.equal(findSolAddress(`token=${TOKEN_B}`), TOKEN_B);
});
