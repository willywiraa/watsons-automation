'use strict';
// The hosted server's settings, from environment variables (set on the Windows service, see
// docs/server-deployment.md). Nothing here is secret: each person's staging accounts (testing and
// backoffice) are only in this process's memory.

const path = require('node:path');

function readConfig(env = process.env) {
  const text = (name, fallback) => String(env[name] ?? '').trim() || fallback;
  const positive = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    host: text('WATSONS_SERVER_HOST', '127.0.0.1'), // IIS forwards to it; never reachable from other PCs
    port: Number(text('WATSONS_SERVER_PORT', '3000')),
    // The test project the runs use (this repository): playwright.config.ts, tests/, node_modules/.
    projectDir: path.resolve(text('WATSONS_PROJECT_DIR', path.join(__dirname, '..', '..'))),
    // users.json: readable only by the service account and administrators.
    configDir: path.resolve(text('WATSONS_CONFIG_DIR', 'C:\\CentralAuth\\config')),
    // automation.db (the shared reports) and its backups.
    dataDir: path.resolve(text('WATSONS_DATA_DIR', 'C:\\WatsonsAutomation\\data')),
    // Each run's evidence: <evidence dir>/<yyyy-mm-dd>/<run id>/.
    evidenceDir: path.resolve(text('WATSONS_EVIDENCE_DIR', 'C:\\WatsonsAutomation\\evidence')),
    stagingUrl: text('WATSONS_STAGING_URL', ''),
    maxParallelRuns: positive('WATSONS_MAX_PARALLEL_RUNS', 3),
    sessionIdleHours: positive('WATSONS_SESSION_IDLE_HOURS', 2),
    sessionMaxHours: positive('WATSONS_SESSION_MAX_HOURS', 10),
    retentionDays: positive('WATSONS_RETENTION_DAYS', 180),
    backupsKept: positive('WATSONS_BACKUPS_KEPT', 14),
    // The address people open, e.g. https://watsons-automation.example.local: requests that change
    // something must come from a page of this address. Not set: the request's own host.
    publicOrigin: text('WATSONS_PUBLIC_ORIGIN', '').replace(/\/+$/, '') || null,
    // Cookies only over HTTPS (IIS). Only for trying the server out on http://127.0.0.1: "false".
    cookieSecure: text('WATSONS_COOKIE_SECURE', 'true') !== 'false',
    loginLimitPerMinute: positive('WATSONS_LOGIN_LIMIT_PER_MINUTE', 5), // per address (the PRD)
    loginFailuresPerUser: positive('WATSONS_LOGIN_FAILURES_PER_USER', 10), // per user name, per 15 minutes
  };
}

module.exports = { readConfig };
