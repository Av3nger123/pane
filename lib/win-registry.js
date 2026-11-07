'use strict';
// What a Pane app writes to the Windows registry, all under HKEY_CURRENT_USER
// (no administrator rights):
//   - its links (pane.json "protocols"): Software\Classes\<scheme>
//   - "Open with" for its file types, without becoming the default app:
//     a ProgId plus Software\Classes\.<ext>\OpenWithProgids
//   - an entry in Settings > Apps, so it can be uninstalled from there
// Built as .reg files for `reg import`, which has exact quoting rules (unlike
// passing quoted values through reg.exe's command line). No Electron imports.

const HKCU = 'HKEY_CURRENT_USER';
const CLASSES = `${HKCU}\\Software\\Classes`;
const UNINSTALL = `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;

const progId = (manifest, index) => `Pane.${manifest.id}.${index + 1}`;
const uninstallKey = (manifest) => `${UNINSTALL}\\Pane.${manifest.id}`;

// "C:\path" -> "\"C:\\path\"" in .reg string syntax
const regString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const quoteArg = (s) => `"${s}"`;

// { electron, mainJs, appDir, icon, paneCommand, sizeKb }
function installEntries(manifest, { electron, mainJs, appDir, icon, paneCommand, sizeKb = 0 }) {
  const open = (arg) => [electron, mainJs, `--app=${appDir}`].map(quoteArg).join(' ') + (arg ? ` ${quoteArg(arg)}` : '');
  const keys = [];
  const set = (key, values) => keys.push({ key, values });

  for (const scheme of manifest.protocols) {
    set(`${CLASSES}\\${scheme}`, { '@': `URL:${manifest.name}`, 'URL Protocol': '' });
    if (icon) set(`${CLASSES}\\${scheme}\\DefaultIcon`, { '@': icon });
    set(`${CLASSES}\\${scheme}\\shell\\open\\command`, { '@': open('%1') });
  }

  manifest.fileTypes.forEach((type, i) => {
    const id = progId(manifest, i);
    set(`${CLASSES}\\${id}`, { '@': type.name, FriendlyTypeName: type.name });
    set(`${CLASSES}\\${id}\\Application`, { ApplicationName: manifest.name });
    if (icon) set(`${CLASSES}\\${id}\\DefaultIcon`, { '@': icon });
    set(`${CLASSES}\\${id}\\shell\\open`, { FriendlyAppName: manifest.name });
    set(`${CLASSES}\\${id}\\shell\\open\\command`, { '@': open('%1') });
    for (const ext of type.extensions) set(`${CLASSES}\\.${ext}\\OpenWithProgids`, { [id]: '' });
  });

  set(uninstallKey(manifest), {
    DisplayName: manifest.name,
    DisplayVersion: manifest.version,
    Publisher: 'Pane app',
    ...(icon ? { DisplayIcon: icon } : {}),
    InstallLocation: appDir,
    // cmd strips the outer quotes: ""C:\...\pane.cmd" uninstall id"
    UninstallString: `cmd.exe /c ""${paneCommand}" uninstall ${manifest.id}"`,
    NoModify: { dword: 1 },
    NoRepair: { dword: 1 },
    EstimatedSize: { dword: Math.max(1, Math.round(sizeKb)) },
  });
  return regFile(keys);
}

function removeEntries(manifest) {
  const lines = [];
  for (const scheme of manifest.protocols) lines.push(`[-${CLASSES}\\${scheme}]`);
  manifest.fileTypes.forEach((type, i) => {
    const id = progId(manifest, i);
    lines.push(`[-${CLASSES}\\${id}]`);
    for (const ext of type.extensions) lines.push(`[${CLASSES}\\.${ext}\\OpenWithProgids]`, `${regString(id)}=-`);
  });
  lines.push(`[-${uninstallKey(manifest)}]`);
  return `Windows Registry Editor Version 5.00\r\n\r\n${lines.join('\r\n')}\r\n`;
}

function regFile(keys) {
  const out = ['Windows Registry Editor Version 5.00', ''];
  for (const { key, values } of keys) {
    out.push(`[${key}]`);
    for (const [name, value] of Object.entries(values)) {
      const left = name === '@' ? '@' : regString(name);
      const right = value && typeof value === 'object' ? `dword:${value.dword.toString(16).padStart(8, '0')}` : regString(value);
      out.push(`${left}=${right}`);
    }
    out.push('');
  }
  return out.join('\r\n');
}

// .reg files are read as UTF-16 LE with a byte-order mark.
const encodeRegFile = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

module.exports = { installEntries, removeEntries, encodeRegFile, progId, regString };
