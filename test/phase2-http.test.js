"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { initRecurrenceStore } = require("../src/recurrence-discovery");
const { startRecurrenceApp } = require("../src/recurrence-app");

const TOKEN = "9YttLkHDo4yisJ9fsgFj6aNfA7SKz3JcM1wQh2Ve8XrR";

test("live HTTP integration authenticates Helius while keeping Phase 2 details out of public health", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "consensus-phase2-http-"));
  const dbPath = path.join(directory, "consensus.db");
  const seedDb = new Database(dbPath);
  const recurrence = initRecurrenceStore(seedDb);
  recurrence.enqueueTrending({ data: { list: [{ address: TOKEN }] } }, 1_000);
  recurrence.ingestTokenTraders({ tokenAddress: TOKEN, traders: [], observedAt: 1_001 });
  seedDb.close();

  const app = startRecurrenceApp({ env: {
    DB_PATH: dbPath,
    PORT: "0",
    DASHBOARD_HOST: "127.0.0.1",
    DASHBOARD_PASSWORD: "private-password",
    HELIUS_WEBHOOK_AUTH_SECRET: "hook-secret",
  } });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (!app.server.listening) await new Promise((resolve) => app.server.once("listening", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const event = { type: "SWAP", signature: "private-signature", timestamp: 2, feePayer: "not-tracked", events: { swap: {} } };

  const denied = await fetch(`${base}/webhooks/helius`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "wrong" }, body: JSON.stringify([event]),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${base}/webhooks/helius`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "hook-secret" }, body: JSON.stringify([event]),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { received: 1, inserted: 1 });

  const healthText = await (await fetch(`${base}/health`)).text();
  assert.doesNotMatch(healthText, /private-signature|phase2|tokenMint|walletAddress/i);

  const auth = `Basic ${Buffer.from("consensus:private-password").toString("base64")}`;
  const phase2 = await fetch(`${base}/phase2`, { headers: { authorization: auth } });
  assert.equal(phase2.status, 200);
  assert.match(await phase2.text(), /Live wallet signals/);
});
