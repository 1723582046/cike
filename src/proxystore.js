'use strict';
/**
 * ProxyStore — JSON-backed store for saved proxies.
 * Types: http | https | socks5 | ssh  (mirrors the common antidetect set)
 * Everything stays local; no backend involved.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['http', 'https', 'socks5', 'ssh'];

class ProxyStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'proxies.json');
    this.proxies = {};
    this._load();
  }

  _load() {
    try {
      this.proxies = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.proxies = {};
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.proxies, null, 2));
  }

  _newId() {
    return 'x_' + crypto.randomBytes(6).toString('hex');
  }

  /**
   * Parse one line of bulk input. Accepts:
   *   host:port
   *   host:port:user:pass
   *   http://user:pass@host:port   (also https://, socks5://)
   *   ...{remark}   (trailing {remark} becomes the remark)
   */
  static parseLine(line) {
    let remark = '';
    const m = line.match(/\{([^}]*)\}\s*$/);
    if (m) {
      remark = m[1].trim();
      line = line.slice(0, m.index).trim();
    }
    let type = 'http';
    const urlm = line.match(/^(https?|socks5):\/\/(.*)$/i);
    if (urlm) {
      type = urlm[1].toLowerCase();
      line = urlm[2];
    }
    // strip possible userinfo already handled? handle user:pass@host
    let auth = '';
    const at = line.lastIndexOf('@');
    if (at !== -1) {
      auth = line.slice(0, at);
      line = line.slice(at + 1);
    }
    const parts = line.split(':');
    if (parts.length < 2) throw new Error(`cannot parse proxy line: ${line}`);
    const host = parts[0].trim();
    const port = parseInt(parts[1].trim(), 10);
    if (!host || !Number.isFinite(port)) throw new Error(`cannot parse proxy line: ${line}`);
    let username = '';
    let password = '';
    if (auth) {
      const i = auth.indexOf(':');
      username = decodeURIComponent(i === -1 ? auth : auth.slice(0, i));
      password = decodeURIComponent(i === -1 ? '' : auth.slice(i + 1));
    } else if (parts.length >= 4) {
      username = parts[2].trim();
      password = parts.slice(3).join(':').trim();
    }
    return { type, host, port, username, password, remark: remark || `${host}:${port}` };
  }

  add(spec) {
    if (!TYPES.includes(spec.type)) throw Object.assign(new Error('bad proxy type'), { status: 400 });
    const id = this._newId();
    const now = new Date().toISOString();
    const rec = {
      id,
      type: spec.type,
      host: spec.host,
      port: spec.port,
      username: spec.username || '',
      password: '',
      remark: spec.remark || `${spec.host}:${spec.port}`,
      status: 'unchecked',
      checkedAt: null,
      exitIp: null,
      country: null,
      createdAt: now,
      updatedAt: now,
    };
    // NOTE: password kept in memory/file by explicit user action (they pasted it).
    rec.password = spec.password || '';
    this.proxies[id] = rec;
    this._save();
    return this._public(rec);
  }

  bulkAdd(text, type = 'http') {
    const added = [];
    const errors = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const p = ProxyStore.parseLine(line);
        if (!p.remark || p.remark === `${p.host}:${p.port}`) {
          // keep parsed remark
        }
        added.push(this.add({ ...p, type: p.type === 'http' ? type : p.type }));
      } catch (e) {
        errors.push({ line, error: e.message });
      }
    }
    return { added, errors };
  }

  list() {
    return Object.values(this.proxies).map((p) => this._public(p));
  }

  get(id) {
    const p = this.proxies[id];
    return p ? this._public(p) : null;
  }

  /** Internal: with password (for launching browsers). */
  getSecret(id) {
    return this.proxies[id] || null;
  }

  update(id, patch = {}) {
    const p = this.proxies[id];
    if (!p) return null;
    const safe = { ...patch };
    delete safe.id;
    delete safe.createdAt;
    Object.assign(p, safe, { updatedAt: new Date().toISOString(), status: 'unchecked', checkedAt: null });
    this._save();
    return this._public(p);
  }

  setCheckResult(id, result) {
    const p = this.proxies[id];
    if (!p) return;
    Object.assign(p, result, { checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    this._save();
  }

  remove(id) {
    if (!this.proxies[id]) return false;
    delete this.proxies[id];
    this._save();
    return true;
  }

  _public(p) {
    const { password, ...rest } = p;
    return { ...rest, hasAuth: !!password };
  }

  /** Playwright-compatible proxy option from a stored proxy. */
  static toPlaywright(p) {
    if (!p) return null;
    const server = `${p.type === 'ssh' ? 'http' : p.type}://${p.host}:${p.port}`;
    const opt = { server };
    if (p.username) opt.username = p.username;
    if (p.password) opt.password = p.password;
    return opt;
  }

  /** curl -x argument for connectivity checks. */
  static toCurlArg(p) {
    const scheme = p.type === 'https' ? 'https' : p.type === 'socks5' ? 'socks5h' : 'http';
    const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
    return `${scheme}://${auth}${p.host}:${p.port}`;
  }
}

module.exports = { ProxyStore, TYPES };
