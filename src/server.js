'use strict';
/**
 * Local automation API — Koa HTTP server on 127.0.0.1.
 *
 * Design mirrors the architecture found in commercial fingerprint browsers:
 *  - port picked from a fixed local range (4440–4539)
 *  - the chosen URL is written to a discovery file so external tools can
 *    find the API without configuration
 *  - token auth (query ?token= or x-api-token header), token persisted
 *    in the data dir and printed on first start
 *
 * Everything runs locally. No vendor backend, no account system.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const Koa = require('koa');
const Router = require('@koa/router');
const bodyParser = require('koa-bodyparser');

const { ProfileStore } = require('./store');
const { ProxyStore } = require('./proxystore');
const { BrowserManager } = require('./browser');
const { checkProxy } = require('./proxycheck');
const { Settings } = require('./settings');

const VERSION = require('../package.json').version;
const DATA_DIR = process.env.LFB_DATA || path.join(os.homedir(), '.local-fingerprint-browser');
const PORT_MIN = 4440;
const PORT_MAX = 4539;
const DISCOVERY_FILE = 'local_api_url.txt';
const TOKEN_FILE = 'api_token.txt';

function ensureDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getToken(dir) {
  const f = path.join(dir, TOKEN_FILE);
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  } catch { /* first run */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

function findFreePort(min, max) {
  return new Promise((resolve, reject) => {
    let port = min;
    const tryNext = () => {
      if (port > max) return reject(new Error('no free API port in range'));
      const s = net.createServer();
      s.once('error', () => { port += 1; tryNext(); });
      s.once('listening', () => s.close(() => resolve(port)));
      s.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

function need(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') {
      const err = new Error(`missing required field: ${f}`);
      err.status = 400;
      throw err;
    }
  }
}

/** Resolve a profile's effective proxy: saved proxy (proxyId) wins, else inline. */
function resolveProxy(profile, proxyStore) {
  if (profile.proxyId) {
    const p = proxyStore.getSecret(profile.proxyId);
    if (p) return ProxyStore.toPlaywright(p);
  }
  if (profile.proxy && profile.proxy.server) return profile.proxy;
  return null;
}

/**
 * Build the backend (stores + Koa app) without listening.
 * Returns { app, store, proxyStore, browsers, token, dataDir }.
 */
function buildBackend(dataDir = DATA_DIR, options = {}) {
  ensureDataDir(dataDir);
  const token = getToken(dataDir);
  const store = new ProfileStore(dataDir);
  const proxyStore = new ProxyStore(dataDir);
  const settings = new Settings(dataDir, options.resolveSystemProxy);
  const browsers = new BrowserManager(store, proxyStore, settings, options);

  const app = new Koa();
  const router = new Router({ prefix: '/api' });

  app.use(bodyParser());

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = { ok: false, error: err.message };
    }
  });

  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith('/api/')) return next();
    const t = ctx.query.token || ctx.get('x-api-token');
    if (t !== token) {
      ctx.status = 401;
      ctx.body = { ok: false, error: 'invalid token' };
      return;
    }
    await next();
  });

  // --- meta ---
  router.get('/getVersion', (ctx) => {
    ctx.body = { ok: true, version: VERSION, name: 'local-fingerprint-browser' };
  });

  router.get('/settings', (ctx) => {
    ctx.body = { ok: true, settings: settings.get() };
  });

  router.patch('/settings', (ctx) => {
    ctx.body = { ok: true, settings: settings.set(ctx.request.body || {}) };
  });

  // --- profiles ---
  router.get('/profiles', (ctx) => {
    const profiles = store.list().map((p) => ({
      ...p,
      open: browsers.isOpen(p.id),
      proxyRemark: p.proxyId ? (proxyStore.get(p.proxyId)?.remark || '(deleted)') : (p.proxy ? 'custom' : 'none'),
    }));
    ctx.body = { ok: true, profiles };
  });

  router.post('/profiles', (ctx) => {
    const body = ctx.request.body || {};
    if (body.proxyId && !proxyStore.get(body.proxyId)) ctx.throw(400, 'proxy not found');
    ctx.body = { ok: true, profile: store.create(body) };
  });

  router.get('/profiles/:id', (ctx) => {
    const p = store.get(ctx.params.id);
    if (!p) ctx.throw(404, 'profile not found');
    ctx.body = { ok: true, profile: p };
  });

  router.patch('/profiles/:id', (ctx) => {
    const body = ctx.request.body || {};
    if (body.proxyId && !proxyStore.get(body.proxyId)) ctx.throw(400, 'proxy not found');
    const p = store.update(ctx.params.id, body);
    if (!p) ctx.throw(404, 'profile not found');
    ctx.body = {
      ok: true,
      profile: p,
      ...(browsers.isOpen(ctx.params.id) ? { warning: 'profile is open; changes apply on next open' } : {}),
    };
  });

  router.delete('/profiles/:id', async (ctx) => {
    await browsers.close(ctx.params.id);
    if (!store.remove(ctx.params.id)) ctx.throw(404, 'profile not found');
    ctx.body = { ok: true };
  });

  // --- proxies ---
  router.get('/proxies', (ctx) => {
    ctx.body = { ok: true, proxies: proxyStore.list() };
  });

  router.post('/proxies', (ctx) => {
    const body = ctx.request.body || {};
    if (body.bulk) {
      const { added, errors } = proxyStore.bulkAdd(body.bulk, body.type || 'http');
      ctx.body = { ok: true, added, errors };
      return;
    }
    need(body, ['host', 'port']);
    ctx.body = { ok: true, proxy: proxyStore.add({ type: body.type || 'http', ...body }) };
  });

  router.patch('/proxies/:id', (ctx) => {
    const p = proxyStore.update(ctx.params.id, ctx.request.body || {});
    if (!p) ctx.throw(404, 'proxy not found');
    ctx.body = { ok: true, proxy: p };
  });

  router.delete('/proxies/:id', (ctx) => {
    if (!proxyStore.remove(ctx.params.id)) ctx.throw(404, 'proxy not found');
    ctx.body = { ok: true };
  });

  router.post('/proxies/check', async (ctx) => {
    const body = ctx.request.body || {};
    const ids = body.ids || proxyStore.list().map((p) => p.id);
    const results = [];
    for (const id of ids) {
      const secret = proxyStore.getSecret(id);
      if (!secret) {
        results.push({ id, status: 'failed', error: 'not found' });
        continue;
      }
      const r = await checkProxy(secret, settings);
      proxyStore.setCheckResult(id, {
        status: r.status,
        exitIp: r.exitIp || null,
        country: r.country || null,
        countryCode: r.countryCode || null,
        timezone: r.timezone || null,
      });
      results.push({ id, ...r });
    }
    ctx.body = { ok: true, results };
  });

  // --- browser sessions ---
  router.post('/openBrowser', async (ctx) => {
    need(ctx.request.body || {}, ['profile_id']);
    const { profile_id, headless = false } = ctx.request.body;
    const profile = store.get(profile_id);
    if (!profile) ctx.throw(404, 'profile not found');
    const proxy = resolveProxy(profile, proxyStore);
    ctx.body = { ok: true, ...(await browsers.open(profile_id, { headless, proxyOverride: proxy })) };
  });

  router.post('/closeBrowser', async (ctx) => {
    need(ctx.request.body || {}, ['profile_id']);
    ctx.body = { ok: true, ...(await browsers.close(ctx.request.body.profile_id)) };
  });

  router.get('/checkOpen', (ctx) => {
    need(ctx.query, ['profile_id']);
    ctx.body = { ok: true, profile_id: ctx.query.profile_id, open: browsers.isOpen(ctx.query.profile_id) };
  });

  router.get('/openedList', (ctx) => {
    ctx.body = { ok: true, opened: browsers.listOpen() };
  });

  router.post('/closeAllBrowsers', async (ctx) => {
    ctx.body = { ok: true, ...(await browsers.closeAll()) };
  });

  app.use(router.routes()).use(router.allowedMethods());

  return { app, store, proxyStore, browsers, settings, token, dataDir };
}

/** Start listening; writes the discovery file. Returns { url, port, server, ...backend }. */
async function startBackend(dataDir = DATA_DIR, options = {}) {
  const backend = buildBackend(dataDir, options);
  const port = await findFreePort(PORT_MIN, PORT_MAX);
  const url = `http://127.0.0.1:${port}/`;
  fs.writeFileSync(path.join(backend.dataDir, DISCOVERY_FILE), url + '\n');
  const server = await new Promise((resolve) => {
    const s = backend.app.listen(port, '127.0.0.1', () => resolve(s));
  });
  return { ...backend, url, port, server };
}

async function main() {
  const b = await startBackend();
  console.log(`[LocalAPI] listening on ${b.url}`);
  console.log(`[LocalAPI] discovery file: ${path.join(b.dataDir, DISCOVERY_FILE)}`);
  console.log(`[LocalAPI] api token: ${b.token}`);
  console.log(`[LocalAPI] data dir: ${b.dataDir}`);

  const shutdown = async () => {
    console.log('\n[LocalAPI] shutting down, closing browsers…');
    await b.browsers.closeAll().catch(() => {});
    b.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[LocalAPI] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { main, buildBackend, startBackend, DATA_DIR };
