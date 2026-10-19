'use strict';
/**
 * Self-test harness: opens https://www.browserscan.net/zh in a headed
 * browser (under Xvfb) driven by our own BrowserManager, then scrapes the
 * authenticity score and per-item results.
 *
 * Usage: xvfb-run -a node test/browserscan.js [profile-platform]
 * Requires LFB_CHROMIUM_EXECUTABLE (sandbox) — the packaged app uses its
 * own downloaded Chromium.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

const URL = 'https://www.browserscan.net/zh';
const TIMEOUT_MS = 120000;
const FWD_PORT = 18080;
// Sandbox-only: the egress proxy only forwards data over IPv6, and Chromium
// mishandles the IPv6 literal as a proxy server, so traffic goes through a
// tiny local forwarder (127.0.0.1:18080 -> proxy IPv6). Test-only.
const FWD_SCRIPT = `
const net = require('net');
function pipe(a, b) {
  a.on('data', (d) => { try { b.write(d); } catch (e) {} });
  a.on('close', () => { try { b.destroy(); } catch (e) {} });
  a.on('error', () => {});
  b.on('error', () => {});
}
const srv = net.createServer((c) => {
  const up = net.createConnection({ host: 'fd8b:4f84:7d32:99::1', port: 3128 });
  up.on('connect', () => { c.pipe(up); up.pipe(c); });
  up.on('error', () => c.destroy());
  c.on('error', () => {});
});
srv.listen(${FWD_PORT}, '127.0.0.1');
`;

async function main() {
  const platform = process.argv[2] === 'win' ? 'win' : 'mac';
  const { spawn } = require('child_process');
  const fwd = spawn(process.execPath, ['-e', FWD_SCRIPT], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));

  // Egress IP geo (Indianapolis, US) — keep tz/locale consistent to avoid noise.
  const proxy = { server: `http://127.0.0.1:${FWD_PORT}` };
  if (!proxy) throw new Error('no https_proxy in env; cannot reach the internet from sandbox');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-bs-'));
  const store = new ProfileStore(dataDir);
  const browsers = new BrowserManager(store);

  const profile = store.create({
    name: 'bs-test',
    platform,
    locale: 'en-US',
    // match the egress IP geo so geo/timezone checks don't add noise
    timezone: 'America/Los_Angeles',
    proxy,
  });
  console.log(`profile: ${profile.id} platform=${platform} tz=${profile.timezone}`);

  try {
    await browsers.open(profile.id, { headless: false });
    const ctx = browsers.getContext(profile.id);
    const page = await ctx.newPage();

    console.log('loading', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait until the score is rendered (non-empty % text).
    await page.waitForFunction(() => {
      const el = document.querySelector('#anchor_progress ._5tuium');
      return el && /\d+%/.test(el.textContent);
    }, { timeout: TIMEOUT_MS });
    // Give async checks (webrtc, fonts, tls) time to settle.
    await page.waitForTimeout(15000);

    const result = await page.evaluate(() => {
      const scoreEl = document.querySelector('#anchor_progress ._5tuium');
      const score = scoreEl ? scoreEl.textContent.trim() : 'N/A';
      // Collect section results: h3 title -> following value text.
      const items = {};
      document.querySelectorAll('h3').forEach((h) => {
        const title = h.textContent.trim().replace(/:$/, '');
        const box = h.parentElement;
        const val = box ? box.textContent.replace(h.textContent, '').trim().slice(0, 120) : '';
        if (title && val) items[title] = val;
      });
      return { score, items };
    });

    console.log('\n==== SCORE:', result.score, '====\n');
    const keys = ['机器人检测', 'WebRTC', 'WebRTC STUN', 'Canvas', 'WebGL', 'Audio',
      'Client Rects', 'WebGPU Report', '操作系统', '浏览器', '浏览器版本', 'Header',
      '语言', '请求头语言', 'Internationalization API', '基于IP的时区', '本地时区',
      '字体', 'Client Hints', 'Do Not Track', '隐身模式', '屏幕分辨率', '厂商', '渲染'];
    for (const k of keys) {
      if (result.items[k] !== undefined) console.log(`${k}: ${result.items[k]}`);
    }
    // dump the rest that look relevant
    console.log('\n--- other items ---');
    for (const [k, v] of Object.entries(result.items)) {
      if (!keys.includes(k) && v && !/广告/.test(v)) console.log(`${k}: ${v.slice(0, 80)}`);
    }
  } finally {
    await browsers.closeAll().catch(() => {});
    try { fwd.kill(); } catch (e) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('HARNESS FATAL:', err.message);
  process.exit(1);
});
