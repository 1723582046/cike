'use strict';
/**
 * ProfileStore — JSON-backed store for browser profiles.
 * Each profile is a directory under <dataDir>/profiles/<id> plus a record
 * in <dataDir>/profiles.json. Everything stays local; no backend involved.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SPEC = {
  name: 'profile',
  group: '',                  // free-form group label
  platform: 'mac',            // 'mac' | 'win' — drives UA/platform/WebGL consistency
  userAgent: null,            // null = pick from pool by platform
  proxyId: null,              // saved proxy id (from ProxyStore) | null
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: 'auto',                // 'auto' = follow proxy country (if proxy set & checked),
  timezone: 'auto',              // 'auto' = follow proxy IP timezone (if proxy set & checked),
                              // otherwise falls back to America/New_York
  geolocation: null,          // { latitude, longitude, accuracy } | null
  proxy: null,                // inline { server, username, password } | null (custom, not saved)
  canvasSeed: null,           // null = random per profile at creation
  canvasNoise: false,         // true = per-profile canvas pixel offset (unlinkable,
                              // but browserscan flags ANY canvas modification as
                              // "tampering" -5%; keep false for max authenticity)
  hardwareConcurrency: null, // null = sensible random pick per platform at creation
  deviceMemory: null,        // null = 8 or 16 at creation
  webrtc: 'auto',            // 'auto' | 'default' | 'disabled'
  colorScheme: 'light',       // 'light' | 'dark' | 'no-preference'
};

class ProfileStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'profiles.json');
    this.profiles = {};
    fs.mkdirSync(path.join(dataDir, 'profiles'), { recursive: true });
    this._load();
    this.sequenceFile = path.join(dataDir, 'profile-sequence.json');
    let saved = 0;
    try { saved = JSON.parse(fs.readFileSync(this.sequenceFile, 'utf8')).last || 0; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.sequence = Math.max(saved, this.list().length, ...this.list().map(p => Number(p.sequence) || (/^\d+$/.test(p.name) ? Number(p.name) : 0)));

  }

  _load() {
    try {
      this.profiles = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.profiles = {};
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.profiles, null, 2));
  }

  _newId() {
    return 'p_' + crypto.randomBytes(6).toString('hex');
  }

  create(spec = {}) {
    const id = this._newId();
    const now = new Date().toISOString();
    const sequence = ++this.sequence;
    fs.writeFileSync(this.sequenceFile, JSON.stringify({ last: sequence }));
    const record = {
      id,
      ...structuredClone(DEFAULT_SPEC),
      ...spec,
      name: String(spec.name || '').trim() || String(sequence),
      sequence,
      viewport: { ...DEFAULT_SPEC.viewport, ...(spec.viewport || {}) },
      createdAt: now,
      updatedAt: now,
    };
    if (record.canvasSeed === null || record.canvasSeed === undefined) {
      record.canvasSeed = crypto.randomInt(0, 2 ** 31);
    }
    if (record.hardwareConcurrency === null || record.hardwareConcurrency === undefined) {
      const pool = record.platform === 'win' ? [8, 12, 16] : [8, 10, 12];
      record.hardwareConcurrency = pool[crypto.randomInt(0, pool.length)];
    }
    if (record.deviceMemory === null || record.deviceMemory === undefined) {
      record.deviceMemory = [8, 16][crypto.randomInt(0, 2)];
    }
    this.profiles[id] = record;
    this._save();
    return record;
  }

  list() {
    return Object.values(this.profiles).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence || 0) - (b.sequence || 0));
  }

  get(id) {
    return this.profiles[id] || null;
  }

  update(id, patch = {}) {
    const rec = this.get(id);
    if (!rec) return null;
    const safe = { ...patch };
    delete safe.id;
    delete safe.createdAt;
    delete safe.sequence;
    Object.assign(rec, safe, { updatedAt: new Date().toISOString() });
    this._save();
    return rec;
  }

  remove(id) {
    const rec = this.get(id);
    if (!rec) return false;
    delete this.profiles[id];
    this._save();
    fs.rmSync(this.profileDir(id), { recursive: true, force: true });
    return true;
  }

  profileDir(id) {
    return path.join(this.dataDir, 'profiles', id);
  }
}

module.exports = { ProfileStore, DEFAULT_SPEC };
