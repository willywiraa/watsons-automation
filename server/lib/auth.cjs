'use strict';
// Who may use the hosted WatsonsTester, and their sessions (PRD "Central Auth", decisions 2026-10-08):
// - the people in <config dir>/users.json (bcrypt hashes; managed with scripts/users.cjs). Re-read
//   when it changes: a person removed or disabled is signed out at their next request.
// - sessions, and each session's two staging accounts, which that person's runs use: the testing
//   account (the shop) and the backoffice account (decisions 2026-10-08 and 2026-10-09). Sessions
//   live only in this process's memory: an account is never sent back to the browser, and a restart
//   of the service signs everyone out. An account the person asks to be remembered is also stored,
//   sealed with a key made from their portal password at sign-in (vault.cjs, server.cjs).

const crypto = require('node:crypto');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 12;
const USERNAME = /^[a-z0-9._-]{2,40}$/;
// Checked instead when a name doesn't exist, so a wrong name takes as long as a wrong password.
const UNKNOWN_USER_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

const normalizeUsername = (username) => String(username ?? '').trim().toLowerCase();

/** The staging accounts a person enters for their runs, and where their session keeps each. */
const ACCOUNT_KINDS = {
  testing: { field: 'testingAccount', missing: 'Enter the testing account’s email (or user name) and password.', tooLong: 'That email or password is too long.' },
  backoffice: { field: 'backofficeAccount', missing: 'Enter the backoffice user name and password.', tooLong: 'That user name or password is too long.' },
};

/** The people in users.json: { users: [{ username, displayName, passwordHash, active, role }] }. */
class UserDirectory {
  constructor(file) {
    this.file = file;
    this.users = [];
    this.loadedFor = null;
  }

  all() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.users = [];
      this.loadedFor = null;
      return this.users;
    }
    const version = `${stat.mtimeMs}:${stat.size}`;
    if (version !== this.loadedFor) {
      try {
        const users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users;
        this.users = Array.isArray(users) ? users : [];
        this.loadedFor = version;
      } catch {
        // Being written right now, or broken: keep the last good list.
      }
    }
    return this.users;
  }

  /** The person, if they may sign in now. */
  active(username) {
    const name = normalizeUsername(username);
    const user = this.all().find((candidate) => candidate.username === name);
    return user && user.active !== false ? user : null;
  }

  /** The person whose name and password these are, or null (as slowly either way). */
  async verify(username, password) {
    const user = this.active(username);
    const matches = await bcrypt.compare(String(password ?? ''), user?.passwordHash || UNKNOWN_USER_HASH);
    return matches && user ? user : null;
  }
}

/** "willy.test@gmail.com" → "wi•••@g•••.com"; "tester01" → "te•••". Shown only to the account's owner. */
function maskAccount(name) {
  const text = String(name);
  const [local, domain] = text.split('@');
  const start = (part, n) => `${part.slice(0, n)}•••`;
  if (!domain) return start(local, 2);
  const dot = domain.lastIndexOf('.');
  return `${start(local, 2)}@${dot > 0 ? `${start(domain, 1)}${domain.slice(dot)}` : start(domain, 1)}`;
}

class Sessions {
  constructor({ users, idleHours, maxHours }) {
    this.users = users;
    this.idleMs = idleHours * 3600_000;
    this.maxMs = maxHours * 3600_000;
    this.byId = new Map();
    // Keyed hash of account names, to see that two runs use the same account without keeping it.
    this.accountKey = crypto.randomBytes(32);
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  create(user) {
    const session = {
      id: crypto.randomBytes(32).toString('base64url'),
      csrf: crypto.randomBytes(24).toString('base64url'),
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role === 'admin' ? 'admin' : 'user',
      createdAt: Date.now(),
      lastSeen: Date.now(),
      testingAccount: null,
      backofficeAccount: null,
      vaultKey: null, // the key to the person's remembered accounts, made at sign-in (vault.cjs)
    };
    this.byId.set(session.id, session);
    return session;
  }

  /** The session, while it is valid and its person may still sign in; else ends it. */
  get(id, now = Date.now()) {
    const session = typeof id === 'string' ? this.byId.get(id) : undefined;
    if (!session) return null;
    const user = this.users.active(session.username);
    if (!user || now - session.lastSeen > this.idleMs || now - session.createdAt > this.maxMs) {
      this.destroy(session.id);
      return null;
    }
    session.lastSeen = now;
    session.displayName = user.displayName || user.username;
    session.role = user.role === 'admin' ? 'admin' : 'user';
    return session;
  }

  /** Whether the session is still valid, without counting this as activity (open windows ask it). */
  peek(id, now = Date.now()) {
    const session = this.byId.get(id);
    return Boolean(session && this.users.active(session.username) && now - session.lastSeen <= this.idleMs && now - session.createdAt <= this.maxMs);
  }

  destroy(id) {
    const session = this.byId.get(id);
    if (session) {
      // Dropped with the session (the remembered copies stay sealed for the next sign-in).
      for (const { field } of Object.values(ACCOUNT_KINDS)) session[field] = null;
      session.vaultKey = null;
    }
    this.byId.delete(id);
  }

  sweep(now = Date.now()) {
    for (const id of [...this.byId.keys()]) this.get(id, now);
  }

  /**
   * Keeps one of a person's accounts (a kind of ACCOUNT_KINDS) for their session, to be remembered
   * for their next sign-in too unless body.remember is false. Returns what's wrong, or null.
   */
  setAccount(session, kind, body) {
    const { field, missing, tooLong } = ACCOUNT_KINDS[kind];
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    if (!username || !password) return missing;
    if (username.length > 200 || password.length > 200) return tooLong;
    session[field] = { username, password, masked: maskAccount(username), fingerprint: this.fingerprint(username), remember: body?.remember !== false };
    return null;
  }

  clearAccount(session, kind) {
    session[ACCOUNT_KINDS[kind].field] = null;
  }

  fingerprint(accountName) {
    return crypto.createHmac('sha256', this.accountKey).update(normalizeUsername(accountName)).digest('hex');
  }

  close() {
    clearInterval(this.sweeper);
    for (const id of [...this.byId.keys()]) this.destroy(id);
  }
}

/** What the browser may know about a person: never the password hash or their accounts. */
const publicUser = (session) => ({ username: session.username, displayName: session.displayName, role: session.role });

/** "Cookie: a=1; wt_session=…" → { a: '1', wt_session: '…' } */
function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) cookies[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return cookies;
}

module.exports = { ACCOUNT_KINDS, BCRYPT_COST, USERNAME, UserDirectory, Sessions, maskAccount, normalizeUsername, publicUser, parseCookies };
