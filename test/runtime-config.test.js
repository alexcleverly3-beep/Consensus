"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { resolveDbPath } = require("../src/runtime-config");
const railway = require("../railway.json");

test("Railway uses its supported Railpack builder and health endpoint", () => {
  assert.equal(railway.build.builder, "RAILPACK");
  assert.equal(railway.deploy.startCommand, "npm start");
  assert.equal(railway.deploy.healthcheckPath, "/health");
});

test("database defaults to the Railway volume when one is attached", () => {
  const cwd = path.resolve("service-root");
  assert.equal(
    resolveDbPath({ RAILWAY_VOLUME_MOUNT_PATH: "persistent-data" }, cwd),
    path.join(cwd, "persistent-data", "wallets.db")
  );
});

test("explicit DB_PATH wins over Railway and local defaults", () => {
  const cwd = path.resolve("service-root");
  assert.equal(
    resolveDbPath({ DB_PATH: "custom/consensus.db", RAILWAY_VOLUME_MOUNT_PATH: "volume" }, cwd),
    path.join(cwd, "custom", "consensus.db")
  );
});
