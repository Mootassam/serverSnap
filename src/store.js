'use strict';
// Saved servers and settings in one JSON file. Passwords and keys' passphrases are
// encrypted with the Windows account (Electron safeStorage) before they touch the disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FIELDS = ['password', 'passphrase', 'sudoPassword', 'hostDbPassword'];

class Store {
  /** crypt: { encrypt(str) -> base64, decrypt(base64) -> str } */
  constructor(file, crypt) {
    this.file = file;
    this.crypt = crypt;
    this.data = this._load();
  }

  _load() {
    const empty = { version: 1, settings: { backupRoot: null, telegram: { token: '', chatId: '' }, closeToTray: true, startWithWindows: false }, servers: [] };
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        return { ...empty, ...d, settings: { ...empty.settings, ...(d.settings || {}) } };
      } catch (_) { /* try the next copy */ }
    }
    return empty;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
  }

  // Servers as the window sees them: no secrets, only whether each one is set.
  publicServers() {
    return this.data.servers.map((s) => this.publicServer(s));
  }

  publicServer(s) {
    const { secrets, ...rest } = s;
    const has = {};
    for (const k of SECRET_FIELDS) has[k] = !!(secrets && secrets[k]);
    // Customer access keys never go to the window.
    const clients = (rest.clients || []).map(({ keyEnc, ...c }) => c);
    return { ...rest, clients, has };
  }

  get(id) {
    return this.data.servers.find((s) => s.id === id) || null;
  }

  // Full details for connecting, with secrets decrypted (stays in the main process).
  withSecrets(id) {
    const s = this.get(id);
    if (!s) throw new Error('Server not found');
    const out = { ...s };
    for (const k of SECRET_FIELDS) out[k] = s.secrets && s.secrets[k] ? this.crypt.decrypt(s.secrets[k]) : '';
    delete out.secrets;
    if (out.authType === 'key' && out.keyPath) {
      try { out.privateKey = fs.readFileSync(out.keyPath); } catch (e) { throw new Error(`Cannot read the SSH key file ${out.keyPath}: ${e.message}`); }
    }
    if (!out.sudoPassword && out.authType === 'password') out.sudoPassword = out.password;
    return out;
  }

  // Creates or updates a server. Secret fields: undefined = keep, '' = clear, text = set.
  upsert(input) {
    let s = input.id ? this.get(input.id) : null;
    if (!s) {
      s = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        secrets: {},
        knownHostKey: null,
        selection: null,
        schedule: { enabled: false, every: 'daily', time: '03:00', weekday: 1, since: null },
        keep: 7,
        lastRun: null,
        lastScan: null,
      };
      this.data.servers.push(s);
    }
    for (const k of ['name', 'host', 'port', 'username', 'authType', 'keyPath', 'backupRoot', 'keep']) {
      if (input[k] !== undefined) s[k] = input[k];
    }
    s.port = Number(s.port) || 22;
    s.keep = Math.max(1, Math.min(365, Number(s.keep) || 7));
    s.host = String(s.host || '').trim();
    s.username = String(s.username || '').trim() || 'root';
    s.name = String(s.name || '').trim() || s.host;
    for (const k of SECRET_FIELDS) {
      if (input[k] === undefined) continue;
      if (input[k] === '') delete s.secrets[k];
      else s.secrets[k] = this.crypt.encrypt(String(input[k]));
    }
    if (input.schedule) {
      const was = s.schedule || {};
      s.schedule = { ...was, ...input.schedule };
      if (s.schedule.enabled && !was.enabled) s.schedule.since = new Date().toISOString();
    }
    this.save();
    return s;
  }

  patch(id, fields) {
    const s = this.get(id);
    if (!s) throw new Error('Server not found');
    Object.assign(s, fields);
    this.save();
    return s;
  }

  remove(id) {
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this.save();
  }

  settings() {
    const t = this.data.settings.telegram || {};
    return { ...this.data.settings, telegram: { chatId: t.chatId || '', hasToken: !!t.token } };
  }

  telegram() {
    const t = this.data.settings.telegram || {};
    return { token: t.token ? this.crypt.decrypt(t.token) : '', chatId: t.chatId || '' };
  }

  setSettings(input) {
    const st = this.data.settings;
    for (const k of ['backupRoot', 'closeToTray', 'startWithWindows']) if (input[k] !== undefined) st[k] = input[k];
    if (input.telegram) {
      st.telegram = st.telegram || {};
      if (input.telegram.chatId !== undefined) st.telegram.chatId = String(input.telegram.chatId).trim();
      if (input.telegram.token !== undefined) st.telegram.token = input.telegram.token ? this.crypt.encrypt(String(input.telegram.token).trim()) : '';
    }
    this.save();
    return this.settings();
  }
}

module.exports = { Store, SECRET_FIELDS };
