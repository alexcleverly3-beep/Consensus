"use strict";

const path = require("path");

function resolveDbPath(env = process.env, cwd = process.cwd()) {
  const configured = String(env.DB_PATH || "").trim();
  if (configured) return path.resolve(cwd, configured);

  const railwayVolume = String(env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  const dataDirectory = railwayVolume
    ? path.resolve(cwd, railwayVolume)
    : path.join(cwd, "data");
  return path.join(dataDirectory, "wallets.db");
}

module.exports = { resolveDbPath };

