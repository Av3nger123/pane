'use strict';
// Signing the Windows installer with the developer's certificate (signtool).
//
// Which certificate, from the environment:
//   PANE_SIGN_PFX + PANE_SIGN_PFX_PASSWORD   a .pfx/.p12 file
//   PANE_SIGN_CERT_SHA1                      a certificate in the Windows store
//   PANE_SIGNTOOL_ARGS                       extra signtool arguments as a JSON list,
//                                            e.g. Azure Artifact Signing's /dlib and /dmdf
// PANE_SIGN_TIMESTAMP_URL: the timestamp server (default DigiCert's; "none"
// skips it, for offline tests). PANE_SIGNTOOL: signtool.exe's path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function findSigntool(env = process.env) {
  if (env.PANE_SIGNTOOL) return env.PANE_SIGNTOOL;
  const kits = path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  let versions = [];
  try { versions = fs.readdirSync(kits).filter((v) => /^\d+\./.test(v)); } catch { return null; }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const tool = path.join(kits, v, 'x64', 'signtool.exe');
    if (fs.existsSync(tool)) return tool;
  }
  return null;
}

function signWindows(file, env = process.env) {
  const certificate = [];
  if (env.PANE_SIGN_PFX) certificate.push('/f', env.PANE_SIGN_PFX, ...(env.PANE_SIGN_PFX_PASSWORD ? ['/p', env.PANE_SIGN_PFX_PASSWORD] : []));
  else if (env.PANE_SIGN_CERT_SHA1) certificate.push('/sha1', env.PANE_SIGN_CERT_SHA1);
  if (env.PANE_SIGNTOOL_ARGS) {
    let extra;
    try { extra = JSON.parse(env.PANE_SIGNTOOL_ARGS); } catch { extra = null; }
    if (!Array.isArray(extra)) throw new Error('PANE_SIGNTOOL_ARGS must be a JSON list of arguments.');
    certificate.push(...extra.map(String));
  }
  if (!certificate.length) {
    throw new Error('--sign needs a certificate: set PANE_SIGN_PFX (and PANE_SIGN_PFX_PASSWORD), PANE_SIGN_CERT_SHA1 or PANE_SIGNTOOL_ARGS.');
  }
  const signtool = findSigntool(env);
  if (!signtool) throw new Error('signtool.exe was not found. Install the Windows SDK, or set PANE_SIGNTOOL to its path.');
  const url = env.PANE_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  const timestamp = url === 'none' ? [] : ['/tr', url, '/td', 'SHA256'];
  try {
    execFileSync(signtool, ['sign', '/fd', 'SHA256', ...timestamp, ...certificate, file], { stdio: 'pipe' });
  } catch (err) {
    // signtool's own message, never the command line (it holds the password).
    const output = `${err.stdout || ''}${err.stderr || ''}`.trim();
    throw new Error(`signtool could not sign ${path.basename(file)}.${output ? `\n${output}` : ''}`);
  }
}

module.exports = { findSigntool, signWindows };
