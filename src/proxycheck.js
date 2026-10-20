'use strict';
/**
 * Proxy connectivity check via system curl (available on macOS and Linux).
 * Reports exit IP (and country when the free geo lookup answers).
 * SSH-type proxies are not checkable this way and are skipped.
 */
const { execFile } = require('child_process');
const { ProxyStore } = require('./proxystore');
const { SocksForwarder } = require('./socksfwd');

function curl(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)), ...args],
      { timeout: timeoutMs + 2000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
        resolve(stdout.trim());
      });
  });
}

/**
 * Check one proxy. Returns { status: 'ok'|'failed', exitIp, country, timezone, error }.
 */
async function checkProxy(proxy, settings) {
  if (proxy.type === 'ssh') {
    return { status: 'unchecked', error: 'ssh proxies cannot be checked with curl' };
  }
  let forwarder;
  if (proxy.type === 'socks5' && settings?.get().socksViaSystemProxy) {
    const systemProxy = await settings.route(proxy.host, proxy.port);
    forwarder = await SocksForwarder.start({ host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password, systemProxy });
  }
  const px = forwarder ? `http://127.0.0.1:${forwarder.port}` : ProxyStore.toCurlArg(proxy);
  try {
    const exitIp = await curl(['-x', px, 'https://api.ipify.org']);
    if (!/^[0-9a-fA-F.:]+$/.test(exitIp) || exitIp.length > 45) {
      throw new Error('unexpected response from ip echo');
    }
    let country = null, countryCode = null, timezone = null;
    try {
      const geo = await curl(['-x', px, `http://ip-api.com/json/${exitIp}?fields=country,countryCode,timezone`], 10000);
      const j = JSON.parse(geo);
      country = j.country || null;
      countryCode = j.countryCode || null;
      timezone = j.timezone || null;
    } catch { /* geo is best-effort */ }
    return { status: 'ok', exitIp, country, countryCode, timezone };
  } catch (e) {
    return { status: 'failed', exitIp: null, country: null, countryCode: null, timezone: null, error: e.message };
  } finally {
    await forwarder?.stop();
  }
}

module.exports = { checkProxy };
