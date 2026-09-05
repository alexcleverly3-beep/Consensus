"use strict";

const Database = require("better-sqlite3");
const { resolveDbPath } = require("./runtime-config");

function installEvidenceObservationIntegrity(db) {
  if (!db || typeof db.exec !== "function") {
    throw new Error("installEvidenceObservationIntegrity requires a SQLite database");
  }

  const evidenceTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_evidence'").get();
  const profileTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_profiles'").get();
  if (!evidenceTable || !profileTable) {
    throw new Error("wallet evidence schema is not initialized");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_evidence_observation_clock (
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      source TEXT NOT NULL,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      PRIMARY KEY(wallet_address, token_address, source)
    );

    INSERT INTO wallet_evidence_observation_clock(
      wallet_address, token_address, source, first_observed_at, last_observed_at
    )
    SELECT wallet_address, token_address, source, MIN(observed_at), MAX(observed_at)
    FROM wallet_evidence
    GROUP BY wallet_address, token_address, source
    ON CONFLICT(wallet_address, token_address, source) DO UPDATE SET
      first_observed_at = MIN(wallet_evidence_observation_clock.first_observed_at, excluded.first_observed_at),
      last_observed_at = MAX(wallet_evidence_observation_clock.last_observed_at, excluded.last_observed_at);

    DROP TRIGGER IF EXISTS trg_wallet_evidence_clock_insert;
    CREATE TRIGGER trg_wallet_evidence_clock_insert
    AFTER INSERT ON wallet_evidence
    BEGIN
      INSERT INTO wallet_evidence_observation_clock(
        wallet_address, token_address, source, first_observed_at, last_observed_at
      ) VALUES (
        NEW.wallet_address, NEW.token_address, NEW.source, NEW.observed_at, NEW.observed_at
      )
      ON CONFLICT(wallet_address, token_address, source) DO UPDATE SET
        first_observed_at = MIN(wallet_evidence_observation_clock.first_observed_at, excluded.first_observed_at),
        last_observed_at = MAX(wallet_evidence_observation_clock.last_observed_at, excluded.last_observed_at);
    END;

    DROP TRIGGER IF EXISTS trg_wallet_evidence_clock_update;
    CREATE TRIGGER trg_wallet_evidence_clock_update
    AFTER UPDATE OF observed_at ON wallet_evidence
    WHEN NEW.observed_at <> OLD.observed_at
    BEGIN
      INSERT INTO wallet_evidence_observation_clock(
        wallet_address, token_address, source, first_observed_at, last_observed_at
      ) VALUES (
        NEW.wallet_address,
        NEW.token_address,
        NEW.source,
        MIN(OLD.observed_at, NEW.observed_at),
        MAX(OLD.observed_at, NEW.observed_at)
      )
      ON CONFLICT(wallet_address, token_address, source) DO UPDATE SET
        first_observed_at = MIN(wallet_evidence_observation_clock.first_observed_at, excluded.first_observed_at),
        last_observed_at = MAX(wallet_evidence_observation_clock.last_observed_at, excluded.last_observed_at);

      UPDATE wallet_evidence
      SET observed_at = MIN(OLD.observed_at, NEW.observed_at)
      WHERE id = NEW.id;
    END;

    DROP TRIGGER IF EXISTS trg_wallet_profile_observation_clock_insert;
    CREATE TRIGGER trg_wallet_profile_observation_clock_insert
    AFTER INSERT ON wallet_profiles
    BEGIN
      UPDATE wallet_profiles
      SET first_seen_at = MIN(
            first_seen_at,
            COALESCE((
              SELECT MIN(first_observed_at)
              FROM wallet_evidence_observation_clock
              WHERE wallet_address = NEW.wallet_address
            ), first_seen_at)
          ),
          last_seen_at = MAX(
            last_seen_at,
            COALESCE((
              SELECT MAX(last_observed_at)
              FROM wallet_evidence_observation_clock
              WHERE wallet_address = NEW.wallet_address
            ), last_seen_at)
          )
      WHERE wallet_address = NEW.wallet_address;
    END;

    DROP TRIGGER IF EXISTS trg_wallet_profile_observation_clock_update;
    CREATE TRIGGER trg_wallet_profile_observation_clock_update
    AFTER UPDATE OF first_seen_at, last_seen_at ON wallet_profiles
    BEGIN
      UPDATE wallet_profiles
      SET first_seen_at = MIN(
            first_seen_at,
            COALESCE((
              SELECT MIN(first_observed_at)
              FROM wallet_evidence_observation_clock
              WHERE wallet_address = NEW.wallet_address
            ), first_seen_at)
          ),
          last_seen_at = MAX(
            last_seen_at,
            COALESCE((
              SELECT MAX(last_observed_at)
              FROM wallet_evidence_observation_clock
              WHERE wallet_address = NEW.wallet_address
            ), last_seen_at)
          )
      WHERE wallet_address = NEW.wallet_address;
    END;
  `);

  return {
    clockRows: Number(db.prepare("SELECT COUNT(*) AS count FROM wallet_evidence_observation_clock").get()?.count || 0),
  };
}

function installEvidenceObservationIntegrityAtPath(dbPath = resolveDbPath()) {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return installEvidenceObservationIntegrity(db);
  } finally {
    db.close();
  }
}

module.exports = {
  installEvidenceObservationIntegrity,
  installEvidenceObservationIntegrityAtPath,
};
