'use strict';
// Brings runs made with the desktop launcher (a project's reports\ folder, copied to the VM) into
// the shared history: each run's evidence goes to <evidence dir>/<yyyy-mm-dd>/<run id>/ and its row
// into the database. Runs already there are skipped, so running it twice changes nothing.
//
//   node server/scripts/import-reports.cjs <reports folder> --operator <user name>
// --operator: who made those runs (a name from users.json). Uses the service's settings
// (server/lib/config.cjs); can run while the service runs. The desktop tests never write a
// password into their evidence, and the server keeps no account to check it for.

const fs = require('node:fs');
const path = require('node:path');
const launcher = require('../../launcher/launcher.cjs');
const { readConfig } = require('../lib/config.cjs');
const { Store } = require('../lib/store.cjs');
const { UserDirectory } = require('../lib/auth.cjs');
const { listFiles } = require('../lib/evidence.cjs');

function importReports(source, operator, config = readConfig()) {
  const user = new UserDirectory(path.join(config.configDir, 'users.json')).active(operator);
  if (!user) throw new Error(`There is no active user "${operator}" in users.json.`);
  const store = new Store(config.dataDir);
  const done = { imported: [], skipped: [] };
  try {
    const runIds = fs
      .readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && launcher.RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const runId of runIds) {
      const target = launcher.runFolderPath(null, runId, config.evidenceDir);
      if (store.getRun(runId) || fs.existsSync(target)) {
        done.skipped.push(runId);
        continue;
      }
      const row = launcher.rowFromFolder(path.join(source, runId), runId, { folder: path.relative(config.evidenceDir, target) });
      if (!row || row.status === 'running') {
        done.skipped.push(runId);
        continue;
      }
      fs.cpSync(path.join(source, runId), target, { recursive: true });
      store.finishRun({ ...row, operator: row.operator ?? user.displayName ?? user.username }, listFiles(target), {
        username: user.username,
        displayName: user.displayName ?? user.username,
      });
      store.audit({ username: user.username, action: 'run-import', runId });
      done.imported.push(runId);
    }
  } finally {
    store.close();
  }
  return done;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const source = args[0];
  const operator = args[args.indexOf('--operator') + 1];
  if (!source || args.indexOf('--operator') < 0 || !operator) {
    console.error('Use: node server/scripts/import-reports.cjs <reports folder> --operator <user name>');
    process.exitCode = 1;
  } else {
    try {
      const { imported, skipped } = importReports(path.resolve(source), operator);
      console.log(`Imported ${imported.length} run(s)${imported.length ? `: ${imported.join(', ')}` : ''}. Skipped ${skipped.length} (already there, or not finished).`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { importReports };
