"use strict";

const path = require("path");

function resolveDbPath(env = process.env, cwd = process.cwd()) {
  const configured = String(env.DB_PATH || "").trim();
  if (configured) return path.resolve(cwd, configured);

  const railwayVolume = String(env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  const isRailwayDeployment = Boolean(
    String(env.RAILWAY_DEPLOYMENT_ID || "").trim() ||
      String(env.RAILWAY_PROJECT_ID || "").trim()
  );
  if (isRailwayDeployment && !railwayVolume) {
    throw new Error(
      "Persistent database storage is required on Railway: attach a volume or set DB_PATH"
    );
  }

  const dataDirectory = railwayVolume
    ? path.resolve(cwd, railwayVolume)
    : path.join(cwd, "data");
  return path.join(dataDirectory, "wallets.db");
}

module.exports = { resolveDbPath };
