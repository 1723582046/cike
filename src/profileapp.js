'use strict';
/**
 * Per-profile macOS .app bundles.
 *
 * When multiple Chromium instances are launched, macOS groups them under the
 * same Dock icon. To let the user distinguish each opened browser, we create
 * a lightweight .app bundle per profile:
 *   <dataDir>/browsers/apps/<profileId>.app/
 *
 * The bundle symlinks the heavy directories (MacOS, Frameworks, etc.) from
 * the real Chromium.app, but has its own Info.plist with CFBundleName set to
 * the profile name, and the CK icon. The Dock then shows the profile name
 * under each browser's icon.
 *
 * macOS only; on other platforms this is a no-op.
 */
const fs = require('fs');
const path = require('path');

/** Find the .app bundle containing the given executable path. */
function findAppBundle(executablePath) {
  // executable is .../Something.app/Contents/MacOS/<binary>
  const parts = executablePath.split(path.sep);
  const idx = parts.findIndex((p) => p.endsWith('.app'));
  if (idx < 0) return null;
  return parts.slice(0, idx + 1).join(path.sep);
}

function appsRoot(dataDir) {
  return path.join(dataDir, 'browsers', 'apps');
}

/**
 * Ensure a per-profile .app bundle exists.
 * @param {string} dataDir - app data directory
 * @param {string} profileId - profile id (used for bundle dir name)
 * @param {string} profileName - profile display name (shown in Dock)
 * @param {string} chromiumExe - path to the real Chromium executable
 * @returns {string} executable path inside the per-profile bundle
 */
function ensureProfileApp(dataDir, profileId, profileName, chromiumExe) {
  if (process.platform !== 'darwin') return chromiumExe;
  const realApp = findAppBundle(chromiumExe);
  if (!realApp) return chromiumExe;

  const bundleDir = path.join(appsRoot(dataDir), `${profileId}.app`);
  const contentsDir = path.join(bundleDir, 'Contents');
  const plistPath = path.join(contentsDir, 'Info.plist');
  const iconPath = path.join(contentsDir, 'Resources', 'app.icns');

  // Reuse if the bundle exists and has the right name + icon + unique bundle ID
  const expectedBundleId = `com.cike.browser.${profileId.replace(/[^a-zA-Z0-9]/g, '')}`;
  try {
    const existing = fs.readFileSync(plistPath, 'utf8');
    const iconStat = fs.statSync(iconPath);
    if (existing.includes(`<string>${escapeXml(profileName)}</string>`) &&
        existing.includes(`<string>${expectedBundleId}</string>`) &&
        iconStat.size > 0) {
      const exe = path.join(contentsDir, 'MacOS', path.basename(chromiumExe));
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* rebuild */ }

  // (Re)build the bundle
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(contentsDir, { recursive: true });

  const realContents = path.join(realApp, 'Contents');
  let realPlist = '';
  try {
    realPlist = fs.readFileSync(path.join(realContents, 'Info.plist'), 'utf8');
  } catch {
    return chromiumExe; // can't brand without the original plist
  }

  // Customize Info.plist: bundle name = profile name, icon = app.icns
  const safeName = escapeXml(profileName);
  let plist = realPlist;
  plist = plist.replace(
    /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${safeName}$2`
  );
  plist = plist.replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${safeName}$2`
  );
  if (!plist.includes('<key>CFBundleName</key>')) {
    plist = plist.replace(
      /(<dict>)/,
      `$1\n\t<key>CFBundleName</key>\n\t<string>${safeName}</string>`
    );
  }
  // CRITICAL: unique bundle identifier per profile, otherwise macOS treats
  // all profile apps as the same application — closing one window can
  // terminate or hide the others.
  const bundleId = `com.cike.browser.${profileId.replace(/[^a-zA-Z0-9]/g, '')}`;
  plist = plist.replace(
    /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${bundleId}$2`
  );
  if (!plist.includes('<key>CFBundleIdentifier</key>')) {
    plist = plist.replace(
      /(<dict>)/,
      `$1\n\t<key>CFBundleIdentifier</key>\n\t<string>${bundleId}</string>`
    );
  }
  plist = plist.replace(
    /(<key>CFBundleIconFile<\/key>\s*<string>)[^<]*(<\/string>)/,
    '$1app$2'
  );
  if (!plist.includes('<key>CFBundleIconFile</key>')) {
    plist = plist.replace(
      /(<dict>)/,
      '$1\n\t<key>CFBundleIconFile</key>\n\t<string>app</string>'
    );
  }
  fs.writeFileSync(plistPath, plist);

  // Symlink everything from the real Contents, except Info.plist and Resources
  const realEntries = fs.readdirSync(realContents, { withFileTypes: true });
  for (const e of realEntries) {
    if (e.name === 'Info.plist') continue;
    const src = path.join(realContents, e.name);
    const dest = path.join(contentsDir, e.name);
    if (e.name === 'Resources') {
      fs.mkdirSync(dest, { recursive: true });
      const resEntries = fs.readdirSync(src, { withFileTypes: true });
      for (const r of resEntries) {
        if (/\.icns$/i.test(r.name)) continue;
        try { fs.symlinkSync(path.join(src, r.name), path.join(dest, r.name)); } catch {}
      }
      // Generate profile-specific icon: name at top + smaller CK logo
      try {
        generateProfileIcon(profileName, path.join(dest, 'app.icns'));
      } catch (err) {
        console.warn('[profileapp] icon generation failed:', err.message);
        // Fallback: copy plain CK icon
        try {
          const ckIcon = path.join(__dirname, '..', 'electron', 'assets', 'icon.icns');
          if (fs.existsSync(ckIcon)) fs.copyFileSync(ckIcon, path.join(dest, 'app.icns'));
        } catch {}
      }
    } else {
      try { fs.symlinkSync(src, dest); } catch {}
    }
  }

  const exe = path.join(contentsDir, 'MacOS', path.basename(chromiumExe));
  return fs.existsSync(exe) ? exe : chromiumExe;
}

/**
 * Generate a Dock icon with the profile name at the top and a smaller
 * CK logo below, using the bundled Python script.
 */
function generateProfileIcon(profileName, outPath) {
  const { execFileSync } = require('child_process');
  const script = path.join(__dirname, '..', 'electron', 'make-profile-icon.py');
  const ckPath = path.join(__dirname, '..', 'electron', 'assets', 'icon-ck.png');
  if (!fs.existsSync(script) || !fs.existsSync(ckPath)) {
    throw new Error('icon assets missing');
  }
  execFileSync('python3', [script, profileName, ckPath, outPath], {
    timeout: 30000,
    stdio: 'pipe',
  });
  if (!fs.existsSync(outPath)) throw new Error('icon not created');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { ensureProfileApp, findAppBundle, appsRoot };
