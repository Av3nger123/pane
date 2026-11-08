'use strict';
// Compiles PaneSetup.cs into PaneSetup.exe with the C# compiler that ships
// with Windows. Run on Windows: node installer/windows/build.js
// (Pane releases include the compiled file, so `pane build` on macOS and
// Linux can make Windows installers without this step.)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const OUT = path.join(HERE, 'PaneSetup.exe');

function findCompiler() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'));
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function buildStub() {
  if (process.platform !== 'win32') throw new Error('The Windows installer can only be compiled on Windows.');
  const csc = findCompiler();
  if (!csc) throw new Error('The .NET Framework C# compiler (csc.exe) was not found.');
  execFileSync(csc, [
    '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
    `/out:${OUT}`,
    `/win32icon:${path.join(HERE, '..', '..', 'assets', 'icon.ico')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(HERE, 'PaneSetup.cs'),
  ], { stdio: 'inherit' });
  return OUT;
}

if (require.main === module) {
  console.log(`Built ${buildStub()}`);
}

module.exports = { buildStub, STUB: OUT };
