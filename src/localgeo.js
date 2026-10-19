'use strict';
/**
 * Detect the local (direct) IP's geolocation.
 * Used when a profile has no proxy: timezone/locale 'auto' should follow
 * the local IP's region instead of falling back to a hardcoded default.
 *
 * Returns { country, countryCode, timezone } or nulls on failure.
 * Cached for 10 minutes to avoid hammering the geo API.
 */
const https = require('https');

let cache = null;
let cacheAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function detectLocalGeo() {
  const now = Date.now();
  if (cache && (now - cacheAt) < CACHE_TTL) return cache;
  try {
    // ip-api.com free endpoint (no key, rate-limited but fine for occasional use)
    const j = await fetchJson('http://ip-api.com/json/?fields=country,countryCode,timezone');
    const result = {
      country: j.country || null,
      countryCode: j.countryCode || null,
      timezone: j.timezone || null,
    };
    cache = result;
    cacheAt = now;
    return result;
  } catch {
    return { country: null, countryCode: null, timezone: null };
  }
}

module.exports = { detectLocalGeo };
