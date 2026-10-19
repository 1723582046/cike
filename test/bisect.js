'use strict';
/**
 * Bisection helper: runs the browserscan verdict check with a given set of
 * stealth evasions enabled (LFB_STEALTH_ONLY) and prints 8512ae7d's verdict.
 * Other spoofs (canvas/audio/platform/uad) stay disabled via env.
 *
 * Usage: LFB_STEALTH_ONLY="..." node test/bisect.js <fwd-port>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

async function main() {
  const port = parseInt(process.argv[2] || '18097', 10);
  const fwd = spawn(process.execPath, ['-e', `const net=require("net");const srv=net.createServer((c)=>{const up=net.createConnection({host:"fd8b:4f84:7d32:99::1",port:3128});up.on("connect",()=>{c.pipe(up);up.pipe(c);});up.on("error",()=>c.destroy());c.on("error",()=>{});});srv.listen(${port},"127.0.0.1");`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-bis-'));
  const store = new ProfileStore(d);
  const bm = new BrowserManager(store);
  const p = store.create({ name: 'v', platform: 'mac', locale: 'en-US', timezoneId: 'America/Los_Angeles', proxy: { server: `http://127.0.0.1:${port}` } });
  await bm.open(p.id, { headless: false });
  const page = await bm.getContext(p.id).newPage();
  let v1 = 'N/A', v2 = 'N/A';
  page.on('response', async (res) => {
    const u = res.url();
    if (res.request().method() === 'POST') {
      if (u.endsWith('/api/8512ae7d')) v1 = (await res.text().catch(() => '')).trim();
      if (u.endsWith('/api/2d598d0b')) v2 = (await res.text().catch(() => '')).trim();
    }
  });
  await page.goto('https://www.browserscan.net/zh', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(20000);
  console.log(`flags=[${process.env.LFB_STEALTH_ONLY || ''}${process.env.LFB_NO_PLATFORM ? ' NOPLAT' : ''}${process.env.LFB_NO_UAD ? ' NOUAD' : ''}] => 8512ae7d=${v1} 2d598d0b=${v2}`);
  await bm.closeAll(); fwd.kill();
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e.message.split('\n')[0]); process.exit(1); });
