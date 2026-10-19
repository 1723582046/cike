'use strict';
/**
 * Sannysoft bot-check harness: loads https://bot.sannysoft.com/ in our
 * headed browser and scrapes the per-check table (PASS/FAIL per row).
 *
 * Usage: node test/sannysoft.js [mac|win]
 * (spawns its own IPv6 forwarder for sandbox egress)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

const FWD_PORT = 18084;
const FWD_SCRIPT = `
const net = require('net');
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
  const fwd = spawn(process.execPath, ['-e', FWD_SCRIPT], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-san-'));
  const store = new ProfileStore(dataDir);
  const browsers = new BrowserManager(store);
  const profile = store.create({
    name: 'san-test', platform, locale: 'en-US',
    timezone: 'America/Los_Angeles',
    proxy: { server: `http://127.0.0.1:${FWD_PORT}` },
  });

  try {
    await browsers.open(profile.id, { headless: false });
    const page = await browsers.getContext(profile.id).newPage();
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    // wait for the results table to populate
    await page.waitForFunction(() => {
      const t = document.body.innerText;
      return /webdriver/i.test(t) && !/loading/i.test(document.title);
    }, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(8000);

    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td, th')].map((c) => c.innerText.trim());
        if (cells.length >= 2) out.push(cells.slice(0, 3).join(' | '));
      });
      return out;
    });
    console.log('==== Sannysoft results ====');
    rows.forEach((r) => console.log(r));
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
