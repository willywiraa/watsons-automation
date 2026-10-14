'use strict';
// The evidence of each run on the VM: <evidence dir>/<yyyy-mm-dd>/<run id>/ (runs grouped by day,
// 2026-10-08), as the test writes it (src/reporting/result-reporter.ts) plus the launcher's files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { RUN_ID } = require('../../launcher/launcher.cjs');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Files the evidence may hold, and how they are sent. Anything else is never served.
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
// Text files a secret could end up in (checked after every run).
const TEXT = new Set(['.txt', '.log', '.md', '.json', '.html', '.css', '.js', '.csv']);

const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] ?? null;

/** What a file of a run is, for the files list. */
function kindOf(relativePath) {
  const name = path.basename(relativePath);
  if (relativePath.startsWith('html-report/')) return 'html-report';
  if (/^screenshot-.*-failure\.png$/i.test(name)) return 'failure-screenshot';
  if (/^screenshot-.*\.png$/i.test(name)) return 'screenshot';
  if (name === 'error-report.txt') return 'error-report';
  if (name === 'trace.zip') return 'trace';
  if (name === 'result.json') return 'result';
  if (/\.(txt|log)$/i.test(name)) return 'log';
  return 'other';
}

/** The run's evidence folder, if the id is a run id. */
function runFolder(evidenceDir, runId) {
  return typeof runId === 'string' && RUN_ID.test(runId) ? path.join(evidenceDir, runId.slice(0, 10), runId) : null;
}

/** A file inside the folder, from the parts of a requested path, or null (never outside the folder). */
function fileInside(folder, parts) {
  if (!folder || !Array.isArray(parts) || parts.length === 0) return null;
  if (parts.some((part) => typeof part !== 'string' || !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) return null;
  const file = path.resolve(folder, ...parts);
  if (!file.startsWith(path.resolve(folder) + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() && typeOf(file) ? file : null;
  } catch {
    return null;
  }
}

/** Every file of a run: [{ path: 'html-report/index.html', kind, size }]. */
function listFiles(folder) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) files.push({ path: relative, kind: kindOf(relative), size: fs.statSync(path.join(dir, entry.name)).size });
    }
  };
  walk(folder, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Removes the given secrets from the run's text files (the tests never write them; this is the
 * second lock). Returns the files it changed.
 */
function removeSecrets(folder, secrets) {
  const values = [...new Set(secrets.filter((value) => typeof value === 'string' && value.length >= 4))];
  if (values.length === 0) return [];
  const changed = [];
  for (const file of listFiles(folder)) {
    if (!TEXT.has(path.extname(file.path).toLowerCase())) continue;
    const full = path.join(folder, ...file.path.split('/'));
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    let cleaned = text;
    for (const value of values) cleaned = cleaned.split(value).join('[removed]');
    if (cleaned !== text) {
      fs.writeFileSync(full, cleaned);
      changed.push(file.path);
    }
  }
  return changed;
}

/** The run's evidence as one zip file (Windows' own tar.exe makes it), in a temporary folder. */
function zipFolder(folder) {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watsons-evidence-')), `${path.basename(folder)}.zip`);
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-a', '-c', '-f', target, '-C', folder, '.'], { windowsHide: true }, (error) => (error ? reject(error) : resolve(target)));
  });
}

/** The day folders older than the given day (yyyy-mm-dd), with their runs: for retention. */
function daysBefore(evidenceDir, day) {
  let names;
  try {
    names = fs.readdirSync(evidenceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory() && DAY.test(entry.name) && entry.name < day)
    .map((entry) => {
      const dir = path.join(evidenceDir, entry.name);
      const runs = fs.readdirSync(dir, { withFileTypes: true }).filter((run) => run.isDirectory() && RUN_ID.test(run.name)).map((run) => run.name);
      return { day: entry.name, dir, runs };
    });
}

module.exports = { TYPES, typeOf, kindOf, runFolder, fileInside, listFiles, removeSecrets, zipFolder, daysBefore };
