'use strict';
// Who may sign in to the hosted WatsonsTester: <config dir>/users.json, with bcrypt hashes of the
// passwords (the PRD's "account creation via bcrypt scripts"). Passwords are typed hidden and are
// never shown, logged or kept anywhere else. The running service picks up changes by itself; a
// person removed or disabled is signed out at their next click.
//
//   node server/scripts/users.cjs add <name> [--display "Full Name"] [--admin]
//   node server/scripts/users.cjs reset <name>      (new password)
//   node server/scripts/users.cjs disable <name>  |  enable <name>  |  remove <name>
//   node server/scripts/users.cjs list
// The config folder is WATSONS_CONFIG_DIR (default C:\CentralAuth\config), as for the service.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const { readConfig } = require('../lib/config.cjs');
const { BCRYPT_COST, USERNAME, normalizeUsername } = require('../lib/auth.cjs');

const MIN_PASSWORD = 10;

function loadUsers(file) {
  try {
    const users = JSON.parse(fs.readFileSync(file, 'utf8')).users;
    return Array.isArray(users) ? users : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

/** Writes the whole list at once (the service never reads half a file). */
function saveUsers(file, users) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ users }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

/** Asks for a password without showing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    if (process.stdin.isTTY) {
      // Show the question, but not what is typed.
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askNewPassword(name) {
  const first = await askHidden(`New password for ${name} (${MIN_PASSWORD}+ characters): `);
  if (first.length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters. Nothing was changed.`);
  const second = await askHidden('Type it again: ');
  if (first !== second) throw new Error('The two passwords differ. Nothing was changed.');
  return first;
}

async function main(argv) {
  const [command, rawName, ...rest] = argv;
  const file = path.join(readConfig().configDir, 'users.json');
  const users = loadUsers(file);
  const name = normalizeUsername(rawName);
  const find = () => users.find((user) => user.username === name);
  const option = (flag) => {
    const at = rest.indexOf(flag);
    return at >= 0 ? rest[at + 1] : undefined;
  };

  if (command === 'list') {
    if (users.length === 0) return console.log(`No users yet (${file}).`);
    for (const user of users) {
      console.log(`${user.username.padEnd(20)} ${String(user.displayName ?? '').padEnd(28)} ${user.role === 'admin' ? 'admin' : 'user '}  ${user.active === false ? 'DISABLED' : 'active'}`);
    }
    return;
  }
  if (!['add', 'reset', 'disable', 'enable', 'remove'].includes(command) || !rawName) {
    throw new Error('Use: add <name> [--display "Full Name"] [--admin] | reset <name> | disable <name> | enable <name> | remove <name> | list');
  }
  if (command === 'add') {
    if (!USERNAME.test(name)) throw new Error('A user name has 2 to 40 characters: a-z, 0-9, dot, dash or underscore.');
    if (find()) throw new Error(`${name} already exists. Use "reset ${name}" for a new password.`);
    const passwordHash = await hashPassword(await askNewPassword(name));
    users.push({ username: name, displayName: option('--display') ?? name, passwordHash, active: true, role: rest.includes('--admin') ? 'admin' : 'user' });
    saveUsers(file, users);
    return console.log(`Added ${name}.`);
  }
  const user = find();
  if (!user) throw new Error(`There is no user ${name}.`);
  if (command === 'reset') user.passwordHash = await hashPassword(await askNewPassword(name));
  if (command === 'disable') user.active = false;
  if (command === 'enable') user.active = true;
  saveUsers(file, command === 'remove' ? users.filter((other) => other !== user) : users);
  console.log(`${command === 'remove' ? 'Removed' : command === 'reset' ? 'New password set for' : command === 'disable' ? 'Disabled' : 'Enabled'} ${name}.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { loadUsers, saveUsers, hashPassword, MIN_PASSWORD };
