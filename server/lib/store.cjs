'use strict';
// The shared reports database on the VM (decision 2026-10-08): SQLite, built into Node 24, in one
// file, <data dir>/automation.db. This service is its only writer. It holds every run (one row per
// run, in the shape Logs / History shows), the files of each run's evidence, the audit trail and
// each person's last order. Never a password or an account in readable form: the accounts a person
// has remembered are sealed with a key only their portal password opens (vault.cjs).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  automation TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  order_number TEXT,
  delivery_method TEXT,
  delivery_mode TEXT,
  add_delay_seconds INTEGER,
  error_code TEXT,
  error_step TEXT,
  detail_json TEXT NOT NULL,
  evidence_state TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS runs_username ON runs (username);
CREATE INDEX IF NOT EXISTS runs_order_number ON runs (order_number);
CREATE TABLE IF NOT EXISTS run_files (
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (run_id, path)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  username TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  run_id TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at);
CREATE TABLE IF NOT EXISTS user_prefs (
  username TEXT PRIMARY KEY,
  last_order TEXT,
  add_delay_seconds INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_accounts (
  username TEXT PRIMARY KEY,
  salt BLOB NOT NULL,
  sealed BLOB,
  updated_at TEXT NOT NULL
);`;

const nullable = (value) => (value === undefined ? null : value);
const now = () => new Date().toISOString();

class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'automation.db');
    this.db = new sqlite.DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  /** The columns Logs / History filters on, from a history row (launcher.cjs, rowFromFolder). */
  static columns(row) {
    return {
      automation: row.automation,
      status: row.status,
      outcome: nullable(row.outcome),
      started_at: row.startedAt,
      finished_at: nullable(row.finishedAt),
      duration_ms: Number.isFinite(row.durationMs) ? Math.round(row.durationMs) : null,
      order_number: nullable(row.orderNumber),
      delivery_method: nullable(row.delivery?.method),
      delivery_mode: nullable(row.delivery?.mode),
      add_delay_seconds: Number.isFinite(row.addDelaySeconds) ? row.addDelaySeconds : null,
      error_code: nullable(row.error?.code),
      error_step: nullable(row.error?.step),
      detail_json: JSON.stringify(row),
    };
  }

  /** A run that has just started (status "running"). */
  startRun(row, { username, displayName }) {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, username, display_name, automation, status, outcome, started_at, finished_at, duration_ms,
           order_number, delivery_method, delivery_mode, add_delay_seconds, error_code, error_step, detail_json, evidence_state, updated_at)
         VALUES (:run_id, :username, :display_name, :automation, :status, :outcome, :started_at, :finished_at, :duration_ms,
           :order_number, :delivery_method, :delivery_mode, :add_delay_seconds, :error_code, :error_step, :detail_json, 'pending', :updated_at)`,
      )
      .run({ run_id: row.runId, username, display_name: displayName, ...Store.columns(row), updated_at: now() });
  }

  /** A run that has ended: its final row, and the files of its evidence. */
  finishRun(row, files, { username, displayName } = {}) {
    const exists = this.db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(row.runId);
    if (!exists) this.startRun(row, { username, displayName });
    this.db
      .prepare(
        `UPDATE runs SET automation = :automation, status = :status, outcome = :outcome, started_at = :started_at,
           finished_at = :finished_at, duration_ms = :duration_ms, order_number = :order_number,
           delivery_method = :delivery_method, delivery_mode = :delivery_mode, add_delay_seconds = :add_delay_seconds,
           error_code = :error_code, error_step = :error_step, detail_json = :detail_json,
           evidence_state = 'complete', updated_at = :updated_at
         WHERE run_id = :run_id`,
      )
      .run({ run_id: row.runId, ...Store.columns(row), updated_at: now() });
    this.db.prepare('DELETE FROM run_files WHERE run_id = ?').run(row.runId);
    const insert = this.db.prepare('INSERT INTO run_files (run_id, path, kind, size) VALUES (?, ?, ?, ?)');
    for (const file of files) insert.run(row.runId, file.path, file.kind, file.size);
  }

  /** Every run, newest first, as Logs / History rows, with who ran it. */
  listRuns(limit = 500) {
    return this.db
      .prepare('SELECT username, display_name, evidence_state, detail_json FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?')
      .all(limit)
      .map((record) => Store.rowOf(record));
  }

  getRun(runId) {
    const record = this.db.prepare('SELECT username, display_name, evidence_state, detail_json FROM runs WHERE run_id = ?').get(runId);
    return record ? Store.rowOf(record) : null;
  }

  static rowOf(record) {
    const row = JSON.parse(record.detail_json);
    return { ...row, username: record.username, operator: row.operator ?? record.display_name, evidenceState: record.evidence_state };
  }

  deleteRun(runId) {
    this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
  }

  /** Runs this service was following when it stopped: their result is unknown. */
  markInterrupted() {
    return this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted',
           detail_json = json_set(detail_json, '$.status', 'interrupted', '$.statusLabel', 'Interrupted'), updated_at = ?
         WHERE status = 'running'`,
      )
      .run(now()).changes;
  }

  markEvidenceDeleted(runId) {
    this.db.prepare("UPDATE runs SET evidence_state = 'deleted', updated_at = ? WHERE run_id = ?").run(now(), runId);
    this.db.prepare('DELETE FROM run_files WHERE run_id = ?').run(runId);
  }

  files(runId) {
    return this.db.prepare('SELECT path, kind, size FROM run_files WHERE run_id = ? ORDER BY path').all(runId);
  }

  audit({ username = null, ip = null, action, runId = null, success = true, detail = null }) {
    this.db
      .prepare('INSERT INTO audit_events (at, username, ip, action, run_id, success, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now(), username, ip, action, runId, success ? 1 : 0, detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  auditEvents(limit = 200) {
    return this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit);
  }

  prefs(username) {
    return this.db.prepare('SELECT last_order, add_delay_seconds FROM user_prefs WHERE username = ?').get(username) ?? null;
  }

  savePrefs(username, { lastOrder, addDelaySeconds }) {
    this.db
      .prepare(
        `INSERT INTO user_prefs (username, last_order, add_delay_seconds, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (username) DO UPDATE SET last_order = excluded.last_order, add_delay_seconds = excluded.add_delay_seconds, updated_at = excluded.updated_at`,
      )
      .run(username, lastOrder, addDelaySeconds, now());
  }

  /** The salt of a person's key to their remembered accounts: made at their first sign-in, then kept. */
  accountsSalt(username) {
    this.db.prepare('INSERT OR IGNORE INTO saved_accounts (username, salt, updated_at) VALUES (?, ?, ?)').run(username, crypto.randomBytes(16), now());
    return Buffer.from(this.db.prepare('SELECT salt FROM saved_accounts WHERE username = ?').get(username).salt);
  }

  /** A person's remembered accounts, sealed (vault.cjs), or null. */
  savedAccounts(username) {
    const record = this.db.prepare('SELECT sealed FROM saved_accounts WHERE username = ?').get(username);
    return record?.sealed ? Buffer.from(record.sealed) : null;
  }

  /** sealed: from vault.seal(), or null to remember nothing. */
  saveAccounts(username, sealed) {
    this.db.prepare('UPDATE saved_accounts SET sealed = ?, updated_at = ? WHERE username = ?').run(sealed, now(), username);
  }

  /** A consistent copy of the database (while it is in use). */
  backup(file) {
    return sqlite.backup(this.db, file);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
