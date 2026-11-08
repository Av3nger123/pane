'use strict';
// Signing the macOS installer with the developer's certificate (codesign),
// and notarizing it with Apple (notarytool).
//
//   PANE_SIGN_IDENTITY    "Developer ID Application: Your Name (TEAMID)" or its SHA-1
//   PANE_SIGN_KEYCHAIN    optional keychain holding it
//   PANE_SIGN_TIMESTAMP   "none" skips Apple's timestamp server (offline tests)
//   PANE_NOTARY_PROFILE   a profile saved with `xcrun notarytool store-credentials`;
//                         without it the .dmg is signed but not notarized

const { execFileSync } = require('child_process');

function signMac(target, env = process.env) {
  if (!env.PANE_SIGN_IDENTITY) {
    throw new Error('--sign needs PANE_SIGN_IDENTITY, e.g. "Developer ID Application: Your Name (TEAMID)".');
  }
  const args = ['--force', env.PANE_SIGN_TIMESTAMP === 'none' ? '--timestamp=none' : '--timestamp',
    '--options', 'runtime', '--sign', env.PANE_SIGN_IDENTITY];
  if (env.PANE_SIGN_KEYCHAIN) args.push('--keychain', env.PANE_SIGN_KEYCHAIN);
  run('codesign', [...args, target], `codesign could not sign ${target}`);
}

// True when the .dmg was notarized and the ticket stapled to it.
function notarize(dmg, env = process.env) {
  if (!env.PANE_NOTARY_PROFILE) return false;
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', env.PANE_NOTARY_PROFILE, '--wait'], 'Apple did not notarize the .dmg');
  run('xcrun', ['stapler', 'staple', dmg], 'Could not attach the notarization ticket to the .dmg');
  return true;
}

function run(cmd, args, what) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}`.trim();
    throw new Error(`${what}.${output ? `\n${output}` : ''}`);
  }
}

module.exports = { signMac, notarize };
