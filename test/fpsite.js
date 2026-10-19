'use strict';
/**
 * Generic fingerprint site tester.
 * Usage: node test/fpsite.js <url> <fwd-port> [profile-opts-json]
 * Scrapes page text after load and prints it.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

async function main() {
  const url = process.argv[2];
  const port = parseInt(process.argv[3] || '18201', 10);
  const profileOpts = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  const fwd = spawn(process.execPath, ['-e', `const net=require("net");const srv=net.createServer((c)=>{const up=net.createConnection({host:"fd8b:4f84:7d32:99::1",port:3128});up.on("connect",()=>{c.pipe(up);up.pipe(c);});up.on("error",()=>c.destroy());c.on("error",()=>{});});srv.listen(${port},"127.0.0.1");`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-site-'));
  const store = new ProfileStore(d);
  const bm = new BrowserManager(store);
  const p = store.create({
    name: 'v', platform: 'mac', locale: 'en-US', timezone: 'America/Los_Angeles',
    proxy: { server: `http://127.0.0.1:${port}` },
    ...profileOpts,
  });
  await bm.open(p.id, { headless: false });
  const page = await bm.getContext(p.id).newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(20000);
  const text = await page.evaluate(() => document.body.innerText);
  console.log('=== PAGE TEXT (first 4000 chars) ===');
  console.log(text.slice(0, 4000));
  await bm.closeAll(); fwd.kill();
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e.message.split('\n')[0]); process.exit(1); });
