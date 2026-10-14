'use strict';
// Remembered staging accounts (decision 2026-10-09): the server may remember a person's testing and
// backoffice accounts for their next sign-in, so they don't type them again. They are stored sealed
// (AES-256-GCM) with a key made from that person's portal password (scrypt) when they sign in, the
// only time the server has that password. So only that person's sign-in opens them: not a copy of
// the database, not the VM's administrators, not another person. After an admin resets the portal
// password they can't be opened any more: they are dropped, and the person enters them once again.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
// About a tenth of a second per sign-in; the same cost for anyone trying passwords on a copied database.
const KEY_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** The key to a person's remembered accounts, from their portal password and their own salt. */
const deriveKey = (password, salt) => scrypt(String(password ?? ''), salt, 32, KEY_OPTIONS);

/** A value sealed for one person: iv (12 bytes) | tag (16) | ciphertext. */
function seal(key, username, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(username, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

/** What seal() sealed. Throws when the key (the password) or the person is not the one it was sealed for. */
function open(key, username, sealed) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(username, 'utf8'));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8'));
}

module.exports = { deriveKey, seal, open };
