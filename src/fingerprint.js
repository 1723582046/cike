'use strict';
/**
 * Fingerprint recipes — turn a profile record into Playwright context options
 * plus per-profile init scripts. Covers the standard bot-detection checklist:
 *
 *  - navigator.webdriver / automation flags  (via stealth plugin)
 *  - plugins, mimeTypes, chrome.runtime       (via stealth plugin)
 *  - languages, permissions                    (via stealth plugin)
 *  - userAgent matching the REAL Chromium major version (dynamic)
 *  - navigator.platform consistency            (init script)
 *  - Client Hints (navigator.userAgentData + Sec-CH-UA* headers) consistency
 *  - canvas fingerprint noise, seeded AND stable per profile (init script)
 *  - audio fingerprint noise, seeded per profile (init script)
 *  - hardwareConcurrency / deviceMemory per profile (init script)
 *  - WebGL vendor/renderer spoof               (via stealth plugin)
 *  - viewport, deviceScaleFactor, locale, timezone, geolocation, colorScheme
 *  - per-profile proxy + WebRTC IP-handling policy (launch arg)
 *
 * Honest limits (see README): this is JS-level spoofing. It does NOT patch
 * Chromium at the native level, so TLS/JA3 fingerprints and deep consistency
 * engines are out of scope.
 */

const fs = require('fs');
const path = require('path');

const PLATFORM_TOKEN = { mac: 'MacIntel', win: 'Win32' };
const CH_PLATFORM = { mac: 'macOS', win: 'Windows' };

/** Real Chromium version, detected at runtime via CDP (not browsers.json,
 *  which can be stale). Set by browser.js on first open(). */
let _realFull = null;

function setRealVersion(full) {
  if (typeof full === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(full)) _realFull = full;
}

/** Full version, e.g. "131.0.6778.33". Falls back to browsers.json. */
function getChromiumFullVersion() {
  if (_realFull) return _realFull;
  try {
    const pkgPath = require.resolve('playwright-core/package.json');
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(pkgPath), 'browsers.json'), 'utf8'));
    const e = (j.browsers || []).find((b) => b.name === 'chromium');
    if (e && /^\d+\.\d+\.\d+\.\d+$/.test(String(e.browserVersion))) return String(e.browserVersion);
  } catch { /* fall through */ }
  return null;
}

/** Real Chromium major version. */
function getChromiumMajor() {
  const full = getChromiumFullVersion();
  if (full) return full.split('.')[0];
  return '131';
}

function uaFor(platform, major) {
  const osToken = platform === 'win'
    ? 'Windows NT 10.0; Win64; x64'
    : 'Macintosh; Intel Mac OS X 10_15_7';
  // Real Chrome UAs carry "<major>.0.0.0"; the full build version only
  // appears in high-entropy Client Hints.
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function pickUa(profile) {
  if (profile.userAgent) return profile.userAgent;
  return uaFor(profile.platform, getChromiumMajor());
}

/** Sec-CH-UA* request headers consistent with the spoofed UA. */
function secChUaHeaders(profile) {
  const major = getChromiumMajor();
  return {
    'Sec-CH-UA': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not=A?Brand";v="99"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': `"${CH_PLATFORM[profile.platform] || 'macOS'}"`,
  };
}

/**
 * Shared anti-detection: mask patched JS functions as native code.
 * Intercepts Function.prototype.toString so even
 * Function.prototype.toString.call(patchedFn) returns a native string.
 * (An own 'toString' on the patched fn is itself detectable via
 * hasOwnProperty, so interception happens at the Function.prototype level.)
 * Safe to include in multiple scripts — installs the wrapper only once,
 * shares one global mask registry.
 */
const NATIVE_MASK_SETUP = `
  if (!Function.prototype.__lfb_masks) {
    Object.defineProperty(Function.prototype, '__lfb_masks', {
      value: new Map(), configurable: true, writable: true,
    });
  }
  function __lfb_maskNative(fn, name, len) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      Object.defineProperty(fn, 'length', { value: len, configurable: true });
      Function.prototype.__lfb_masks.set(fn, 'function ' + name + '() { [native code] }');
    } catch (e) {}
  }
  if (!Function.prototype.__lfb_masked) {
    const __lfb_origToString = Function.prototype.toString;
    const __lfb_wrapper = function () {
      const m = Function.prototype.__lfb_masks;
      if (m && m.has(this)) return m.get(this);
      return __lfb_origToString.call(this);
    };
    Object.defineProperty(__lfb_wrapper, 'toString', {
      value: function () { return 'function toString() { [native code] }'; },
      configurable: true,
    });
    Function.prototype.toString = __lfb_wrapper;
    Object.defineProperty(Function.prototype, '__lfb_masked', {
      value: true, configurable: true, writable: true,
    });
  }
`;

/**
 * Patch navigator.userAgentData (Client Hints) to match the spoofed UA.
 * browserscan-style checkers compare these against the UA string.
 *
 * IMPORTANT: navigator.userAgentData returns a FRESH object on every access,
 * so we patch NavigatorUAData.prototype (shared by all instances) rather
 * than replacing the getter — the instance stays a genuine NavigatorUAData,
 * only the reported values are spoofed.
 */
function userAgentDataScript(profile) {
  const major = getChromiumMajor();
  const platform = CH_PLATFORM[profile.platform] || 'macOS';
  return `(() => {
    try {
      const uad = navigator.userAgentData;
      if (!uad) return;
      const proto = Object.getPrototypeOf(uad);
      if (!proto) return;
      const brands = [
        { brand: 'Chromium', version: '${major}' },
        { brand: 'Google Chrome', version: '${major}' },
        { brand: 'Not=A?Brand', version: '99' },
      ];
      Object.defineProperty(proto, 'brands', {
        get: () => brands.map((b) => ({ brand: b.brand, version: b.version })),
        configurable: true,
      });
      Object.defineProperty(proto, 'mobile', { get: () => false, configurable: true });
      Object.defineProperty(proto, 'platform', { get: () => '${platform}', configurable: true });
      // NOTE: getHighEntropyValues is intentionally left real — overriding it
      // is detectable, and the high-entropy values (real version) already match
      // the UA story.
    } catch (e) {}
  })();`;
}

/**
 * Per-profile canvas noise, seeded AND stable: the same perturbation is
 * applied on every read, so the fingerprint is unique per profile but
 * deterministic within it (like a real GPU).
 *
 * The noise is a CONSTANT per-channel offset derived from the seed (not
 * random per-pixel). Random per-pixel noise destroys local smoothness and
 * is flagged by heuristic tamper checks; a uniform offset preserves image
 * structure while still shifting the fingerprint hash.
 */
function canvasNoiseScript(seed) {
  return `(() => {
    const SEED = ${seed >>> 0};
    // Constant per-channel offsets in [-4, +4], derived from the seed.
    // (Zero offsets are re-rolled so every profile actually differs.)
    let s = SEED || 1;
    function next() { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s; }
    let dR = 0, dG = 0, dB = 0;
    while (!dR && !dG && !dB) {
      dR = (next() % 9) - 4; dG = (next() % 9) - 4; dB = (next() % 9) - 4;
    }
    // Idempotency: never noise the same canvas twice (else repeated reads
    // would accumulate noise and look non-deterministic).
    const noised = new WeakSet();
    ${NATIVE_MASK_SETUP}
    function applyNoise(canvas, ctx) {
      if (noised.has(canvas)) return;
      noised.add(canvas);
      const w = canvas.width, h = canvas.height;
      if (!w || !h || !ctx) return;
      try {
        const sw = Math.min(w, 32), sh = Math.min(h, 32);
        const img = ctx.getImageData(0, 0, sw, sh);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = Math.max(0, Math.min(255, d[i] + dR));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + dG));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + dB));
        }
        ctx.putImageData(img, 0, 0);
      } catch (e) { /* cross-origin canvas: leave untouched */ }
    }
    try {
      const proto = HTMLCanvasElement.prototype;
      const origToDataURL = proto.toDataURL;
      const origToBlob = proto.toBlob;
      proto.toDataURL = function (...args) {
        try { applyNoise(this, this.getContext('2d')); } catch (e) {}
        return origToDataURL.apply(this, args);
      };
      __lfb_maskNative(proto.toDataURL, 'toDataURL', 0);
      if (origToBlob) {
        proto.toBlob = function (...args) {
          try { applyNoise(this, this.getContext('2d')); } catch (e) {}
          return origToBlob.apply(this, args);
        };
        __lfb_maskNative(proto.toBlob, 'toBlob', 1);
      }
    } catch (e) {}
  })();`;
}

/**
 * Per-profile AudioContext noise: perturbs the first samples returned by
 * getChannelData with a fixed, seeded pattern (inaudible, deterministic).
 */
function audioNoiseScript(seed) {
  return `(() => {
    // Constant offset (not per-sample random): preserves signal structure,
    // shifts the fingerprint hash. Tiny enough to be inaudible/irrelevant.
    const SEED = (${seed >>> 0} ^ 0x9e3779b9) >>> 0;
    let s = SEED || 1;
    function next() { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s; }
    const OFFSET = ((next() % 2001) - 1000) * 1e-9 || 1e-9;
    // Idempotency: never noise the same buffer twice.
    const noised = new WeakSet();
    ${NATIVE_MASK_SETUP}
    try {
      const proto = AudioBuffer.prototype;
      const orig = proto.getChannelData;
      proto.getChannelData = function (ch) {
        const data = orig.call(this, ch);
        if (!noised.has(this)) {
          noised.add(this);
          const n = Math.min(64, data.length);
          for (let i = 0; i < n; i++) data[i] += OFFSET;
        }
        return data;
      };
      __lfb_maskNative(proto.getChannelData, 'getChannelData', 1);
    } catch (e) {}
  })();`;
}

/** Keep navigator.platform consistent with the chosen UA pool. */
function platformScript(profile) {
  const token = PLATFORM_TOKEN[profile.platform] || 'MacIntel';
  return `(() => {
    try {
      Object.defineProperty(navigator, 'platform', { get: () => '${token}' });
    } catch (e) {}
  })();`;
}

/** Per-profile hardwareConcurrency / deviceMemory (replaces stealth's fixed 4). */
function hardwareScript(profile) {
  const cores = Number(profile.hardwareConcurrency) || 8;
  const mem = Number(profile.deviceMemory) || 8;
  return `(() => {
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cores} });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => ${mem} });
    } catch (e) {}
  })();`;
}

/**
 * Build Playwright launchPersistentContext options + init scripts for a profile.
 * Returns { options, scripts, userAgent, extraHeaders }.
 */
function buildContextOptions(profile) {
  const userAgent = pickUa(profile);
  // 'auto' timezone without a proxy timezone resolved -> fall back to default
  const tz = profile.timezone === 'auto' ? 'America/New_York' : profile.timezone;
  const options = {
    userAgent,
    viewport: { width: profile.viewport.width, height: profile.viewport.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    locale: profile.locale,
    timezoneId: tz,
    colorScheme: profile.colorScheme,
    acceptDownloads: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
  };
  if (profile.geolocation) {
    options.geolocation = { ...profile.geolocation };
    options.permissions = ['geolocation'];
  }
  if (profile.proxy) {
    options.proxy = {
      server: profile.proxy.server,
      username: profile.proxy.username,
      password: profile.proxy.password,
    };
  }
  // Canvas noise is OPT-IN per profile (profile.canvasNoise=true).
  // Rationale: browserscan-style checkers flag ANY canvas pixel modification
  // as "tampering" (-5%, even Brave's built-in randomization is flagged).
  // A pristine canvas is required for 100%. Enable per-profile when
  // unlinkability matters more than the authenticity score.
  // Audio noise stays ON: it is not flagged by checkers.
  // (LFB_NO_* env vars remain as a debug escape hatch.)
  const skip = (name) => process.env['LFB_NO_' + name] === '1';
  const scripts = [];
  if (!skip('PLATFORM')) scripts.push(platformScript(profile));
  if (!skip('UAD')) scripts.push(userAgentDataScript(profile));
  if (profile.canvasNoise && !skip('CANVAS')) scripts.push(canvasNoiseScript(profile.canvasSeed));
  if (!skip('AUDIO')) scripts.push(audioNoiseScript(profile.canvasSeed));
  scripts.push(hardwareScript(profile));
  return { options, scripts, userAgent, extraHeaders: secChUaHeaders(profile) };
}

/**
 * Chromium launch args for WebRTC handling.
 * webrtc: 'auto' (default) -> disable_non_proxied_udp when a proxy is set
 *         (prevents the real IP leaking via STUN), 'disabled' -> fully off,
 *         'default' -> browser default.
 */
function webrtcArgs(profile) {
  const mode = profile.webrtc || 'auto';
  const hasProxy = !!(profile.proxy || profile.proxyId);
  if (mode === 'disabled') return ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=WebRtcHideLocalIpsWithMdns'];
  if (mode === 'default') return [];
  if (hasProxy) return ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  return [];
}

module.exports = {
  buildContextOptions,
  pickUa,
  uaFor,
  getChromiumMajor,
  getChromiumFullVersion,
  setRealVersion,
  secChUaHeaders,
  webrtcArgs,
  // script builders (exported for unit testing)
  userAgentDataScript,
  canvasNoiseScript,
  audioNoiseScript,
  platformScript,
  hardwareScript,
  UA_POOLS: { mac: [], win: [] }, // kept for backward-compat; UAs are dynamic now
};
