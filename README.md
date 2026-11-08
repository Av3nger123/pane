<img src="assets/icon.svg" width="72" height="72" alt="">

# Pane

Pane is installed on a computer once. After that, every Pane app uses Pane's Chromium and Node, so an app is only its own files: tens of KB instead of the 150 to 300 MB that each Electron app ships.

Each app still behaves like a normal desktop app:
- It runs in its own process.
- It opens as many windows as it needs.
- It has its own name and icon in the Dock or taskbar, and its own data.

## Start an app

Pane comes from GitHub, not npm. Install the `pane` command from a release:

```sh
npm install -g https://github.com/Av3nger123/pane/releases/download/v0.1.0/pane-runtime-0.1.0.tgz
pane create my-app --template react    # react | svelte | vanilla
cd my-app && npm run dev
```

Or from a clone of this repository:

```sh
npm install
node bin/pane.js create my-app --template react
cd my-app && npm run dev
```

| Template | What you get |
|---|---|
| `react`, `svelte` | Vite. `pane dev` starts Vite's dev server and loads it, so components hot-reload in place. `pane build` runs `vite build` and packages `dist/`. |
| `vanilla` | Plain HTML, CSS and JavaScript in `ui/`. No build step and no npm install. `pane dev` reloads the window when you save. |

`pane dev`, for every template:
- restarts the backend when its code changes
- restarts the app when `pane.json` changes
- shows a backend crash in the window, with its last output and a Restart button
- shows an error page, instead of a blank window, when a page fails to load

The **Develop** menu has Reload, Restart Backend and Developer Tools. To pass flags to Chromium, put them after `--`: `pane dev -- --remote-debugging-port=9222`.

### Example: Notes

[`examples/notes`](examples/notes) is a real app on Pane, built with the React template. Notes are plain Markdown files in the app's data folder. It has search, autosave, a File menu with shortcuts, a context menu, a native confirmation before deleting, export through a save dialog, `pane-notes://` links, opening and dropping `.md` files, and any note in its own remembered window. Every window is kept in sync through backend events.

```sh
cd examples/notes && npm install && npm run dev
```

## An app

```
my-app/
  pane.json          name, id, version, windows, permissions
  icon.png           square PNG, 512 px or more
  ui/ or dist/       the web files Pane serves
  backend/main.js    optional: Node, running on Pane's built-in Node
  package.json       framework templates only
```

### pane.json

```json
{
  "id": "my-app",
  "name": "My App",
  "version": "0.1.0",
  "pane": ">=0.1.0",
  "ui": "dist",
  "start": "index.html",
  "backend": "backend/main.js",
  "icon": "icon.png",
  "window": { "width": 960, "height": 640, "titleBar": "hidden", "background": "#f6f6f3" },
  "permissions": ["notifications"],
  "dev": { "command": "vite --port {port} --strictPort", "url": "http://localhost:{port}" },
  "build": { "command": "vite build" }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes. Identifies the app and its data. |
| `pane` | Pane versions the app works with: `">=0.1.0"`, `"^1.2.0"`. |
| `ui`, `start` | The folder Pane serves, and the first page in it. |
| `backend` | Optional. A Node file (CommonJS or ES module) that runs in its own process. |
| `window.background` | Shown while pages load, and behind the window controls. One colour, or `{ "light": "#ffffff", "dark": "#1e1e1e" }`, which follows the system theme. |
| `window.titleBar` | `"default"` is the normal title bar. `"hidden"` makes the window controls float over the page, so the app gets the whole window. |
| `permissions` | `notifications`, `camera`, `microphone`, `clipboard`, `geolocation`. Anything not listed is refused. |
| `protocols` | Optional. Links like `notes://...` open the app, for example `["notes"]`. |
| `fileTypes` | Optional. Files the app can open ("Open with"), for example `[{ "name": "Markdown", "extensions": ["md"], "role": "editor" }]`. |
| `dev` | Optional. `pane dev` runs `command` and loads `url`, which must be on `localhost`. `{port}` is a free port that Pane picks. Leave out `command` if you start the server yourself. |
| `build` | Optional. `pane build` runs it first. |

### In the page: `window.pane`

```js
await pane.call('save', note);              // call a backend function, get its return value
pane.send('refresh', data);                 // send an event to the backend, no answer
const off = pane.on('progress', (p) => {}); // backend events; off() stops listening
pane.app;                                   // { id, name, version, dev, hasBackend, pane }
await pane.window.open('settings.html', { width: 480, height: 360 });
await pane.window.open('index.html#about'); // single-page apps: same page, another view
await pane.window.open('index.html#note=42', { key: 'note-42' }); // remembers size and position; never opened twice
pane.window.close(); pane.window.minimize(); pane.window.toggleMaximize();
await pane.openExternal('https://example.com');
```

### Native features

```js
// Dialogs
const files = await pane.dialog.open({ filters: [{ name: 'Markdown', extensions: ['md'] }], multiple: true });
const target = await pane.dialog.save({ defaultPath: 'note.md' });   // null if cancelled
if (await pane.dialog.confirm('Delete this note?', { okLabel: 'Delete', type: 'warning' })) { /* ... */ }
const button = await pane.dialog.message({ message: 'Saved', detail: '...', buttons: ['OK'] });

// Menus: items in File, Edit, View, Window or Help merge into Pane's standard menus
await pane.menu.set([
  { label: 'File', items: [{ label: 'New Note', id: 'new', shortcut: 'CmdOrCtrl+N' }] },
]);
pane.on('pane:menu', ({ id }) => { if (id === 'new') createNote(); });  // in the window it was used in
const choice = await pane.menu.popup([{ label: 'Delete', id: 'delete' }]); // context menu, id or null

await pane.shell.showItemInFolder('/Users/me/notes/a.md');           // Finder / Explorer
await pane.notify({ title: 'Export finished' });                       // needs "notifications" permission

await pane.store.set('theme', { dark: true });                         // small JSON settings, same in dev and installed
await pane.secrets.set('token', 'abc');                                // encrypted with the system keychain
```

Pages never get file access. A dialog returns paths, and the page passes them to the backend, which reads or writes the files. For drag and drop or `<input type="file">`, `pane.pathForFile(file)` gives the path.

### Links and files from the system

Declare `protocols` and `fileTypes` in `pane.json`, then:

```js
pane.onOpen((request) => {
  if (request.kind === 'url') openLink(new URL(request.url));   // notes://open/42
  if (request.kind === 'file') pane.call('importFile', request.path);
});
```

The first `onOpen` call also receives the link or file the app was launched with. Each request goes to one window. Treat URLs and file contents as untrusted input.

- **macOS:** the app's launcher declares its protocols and file types, so links open the app and Finder offers it under "Open With".
- **Windows and Linux:** installed apps register their protocols when they first run (not yet tested).
- **During development:** `pane open <folder> <link-or-file> --dev` sends one to the copy running under `pane dev`.

`pane.secrets` refuses to work where there is no real keychain, for example Linux without a keyring, rather than storing secrets in a form anyone could read.

### Testing your app

Under `pane dev`, `PANE_TEST_DIALOGS` answers dialogs instead of showing them, so end-to-end tests don't stop at a dialog. For example, `PANE_TEST_DIALOGS='{"message":0,"save":"/tmp/out.md"}' pane dev`. Installed apps ignore it.

Pages have no access to Node or Electron, and they can only load the app's own files. Web links open in the user's browser.

With `"titleBar": "hidden"`, Pane sets `--pane-safe-top`, `--pane-safe-left` and `--pane-safe-right` on `<html>`. Keep content out of that space, and give your top bar `-webkit-app-region: drag` so the window can be moved.

### In the backend: `import pane from 'pane'`

```js
import pane from 'pane';                    // or: const pane = require('pane')
pane.expose('save', async (note) => { /* ... */ return id; });
pane.expose({ list, remove });              // several at once
pane.on('refresh', (data) => {});
pane.emit('progress', 0.5);                 // to every window
pane.app.dataDir;                           // private folder for this app's files
```

The backend is full Node: `fs`, `child_process`, network access and npm packages. Packages the backend needs at runtime go in `dependencies`. Build tools and frontend libraries go in `devDependencies`. If a backend crashes in an installed app, Pane restarts it, up to three times a minute.

### TypeScript

The framework templates include Pane's types. To type your backend calls, declare them once:

```ts
declare global {
  interface PaneBackend {
    save(note: { title: string }): Promise<number>;
  }
}
const id = await pane.call('save', { title: 'x' });   // id: number
```

## Ship an app

```sh
pane build my-app        # or: npm run build
```

This writes `my-app/release/My App 0.1.0/`:
- `my-app-0.1.0.paneapp`: the app, with production dependencies only.
- `My App 0.1.0.dmg`: macOS, holding "Install My App" (built on a Mac).
- `My App Setup 0.1.0.exe`: Windows (built on any OS once `PaneSetup.exe` is available).
- `install.sh`: macOS and Linux, from a terminal.

**Installers never contain Pane.** Each one records the Pane version the app was built with:
1. If the computer has that version of Pane or newer, the installer installs only the app.
2. If Pane is missing or older, the installer downloads that version from Pane's distribution server. It checks the download's signature against Pane's public keys, installs Pane next to any older versions, then installs and opens the app.
3. If the signature is missing or doesn't match, the installer stops and installs nothing.

The public keys come from `"pane.releaseKeys"` in Pane's `package.json` and are written into each installer when the app is built. Nothing on the user's computer can add a key, so a different download address (`PANE_DIST_URL`) can't change what gets installed.

### Where Pane is downloaded from: GitHub Releases

Pane's `package.json` sets the address:

```json
"pane": { "distributionUrl": "https://github.com/Av3nger123/pane/releases/download" }
```

An installer for an app built with Pane 0.1.0 downloads:

```
https://github.com/Av3nger123/pane/releases/download/v0.1.0/pane-runtime-0.1.0-darwin-arm64.tar.gz
https://github.com/Av3nger123/pane/releases/download/v0.1.0/pane-runtime-0.1.0-darwin-arm64.tar.gz.sig
```

The `.sig` is an RSA signature (PKCS#1 v1.5, SHA-256), because installers check it before Pane exists: `install.sh` with the system's `openssl`, `Setup.exe` with .NET Framework. A `.sha256` file is published too, for people checking by hand.

To release a version, bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow (`.github/workflows/release.yml`) creates the GitHub release. It packs Pane on macOS, Windows and Linux and attaches each archive with its signature and checksum. It signs with the `PANE_RELEASE_SIGNING_KEY` secret and stops if the secret is missing. It also attaches the developer package (`pane-runtime-0.1.0.tgz`) that `npm install -g` uses.

`pane pack-runtime --out pane-dist --key <file>` makes the same files by hand.

**Release keys.** `pane keygen --release <file>` creates one. Put its public key in `"pane.releaseKeys"`, store the private key as the GitHub secret `PANE_RELEASE_SIGNING_KEY`, then delete the file. To replace a key, add the new public key next to the old one, release with the new key, and remove the old public key once apps built with it no longer need to download Pane. `PANE_DIST_URL` overrides the address, for example to test against a local server. The address must use https, except `localhost` while testing.

### Signing your app

Two kinds of signature, both optional:

**Your app key (free).** It proves updates come from you. Create it once and keep it secret and backed up:

```sh
pane keygen ~/keys/my-apps.pem
pane build my-app --key ~/keys/my-apps.pem     # in CI: put the key itself in PANE_SIGNING_KEY
```

The first install of an app id records its key. After that, users' computers only accept that id from the same key, so nobody else can ship an app with your id and take over its data. Without a key, `pane build` warns: an unsigned app can be replaced by anyone who reuses its id. Set `"publisher"` in `pane.json` to show a name next to the key.

**Your certificates (paid, from Apple and Microsoft).** Without them, macOS Gatekeeper and Windows SmartScreen warn about your installer. `pane build --sign` signs the installers with them:

| Setting | Meaning |
|---|---|
| `PANE_SIGN_IDENTITY` | macOS: `"Developer ID Application: Your Name (TEAMID)"` or its SHA-1 |
| `PANE_SIGN_KEYCHAIN` | macOS, optional: the keychain that holds it |
| `PANE_NOTARY_PROFILE` | macOS: a profile saved with `xcrun notarytool store-credentials`. Without it the .dmg is signed but not notarized, and macOS still blocks it |
| `PANE_SIGN_PFX`, `PANE_SIGN_PFX_PASSWORD` | Windows: a .pfx certificate file |
| `PANE_SIGN_CERT_SHA1` | Windows: a certificate in the Windows certificate store |
| `PANE_SIGNTOOL_ARGS` | Windows: extra `signtool` arguments as a JSON list, e.g. for Azure Artifact Signing |
| `PANE_SIGN_TIMESTAMP_URL` | Windows: the timestamp server (default DigiCert's) |

The Windows installer is signed only when building on Windows (it needs `signtool`).

### What users see

`pane install` (and the installers' logs) show who signed the app and what it may use:

```
Installed Notes 1.2.0
  launcher: ~/Applications/Pane Apps/Notes.app
  publisher: Acme (key 3f9a 1c22 0b7e 91d4)
  permissions: notifications
```

`pane list` shows the same publisher for each installed app.

## What installing does

- **Pane** goes to `~/Library/Application Support/Pane/runtime/<version>`, and the `pane` command to `.../Pane/bin/pane`. That command runs on Pane's own Electron, so users don't need Node. Several versions can be installed side by side, and the default only moves forward.
- **Apps** go to `.../Pane/apps/<id>`, and their data to `.../Pane/data/<id>`.
- **On macOS**, the launcher is `~/Applications/Pane Apps/<App>.app`. It's a real app bundle with its own bundle id, name, icon and helper processes. Its 251 MB Chromium framework is an APFS clone of Pane's copy, so it takes about 1.4 MB of real disk.

Other commands: `pane install <folder|.paneapp>`, `pane uninstall <id> [--purge]`, `pane list`, `pane setup`, `pane run`, `pane open`. On macOS, uninstalling also removes the app's registration, so it stops being offered for its links and file types.

Set `PANE_HOME` and `PANE_LAUNCHERS_DIR` to install somewhere else, for example while testing.

## Code layout

```
main.js, bin/pane.js   one-line entry points (Electron and the pane command)
src/core/        no Electron: manifest, versions, safe paths, validation, links and files,
                 the settings store, the .ico, .reg and installer-payload formats, and
                 signatures (release-signature.js, app-signature.js, fuses.js, macho-signature.js)
src/runtime/     Electron, one app per process
  main.js          starts the app
  ipc/             page APIs, one file per area, with the message names in ipc/channels.js
  security.js      locking pages down, permissions
  open.js          links and files from the system
  windows.js, backend.js, protocol.js, menu.js, dev.js, preload.js
src/cli/         the pane command: index.js dispatches to commands/<name>.js
src/packaging/   installing Pane (runtime.js) and apps (apps.js), pane build (build.js),
                 installers/ (install.sh, .dmg, Setup.exe), launchers/ (macOS, Windows, Linux),
                 signing/ (codesign, signtool), publishers.js (which key owns each app id)
sdk/backend/     the `pane` module app backends import
templates/       vanilla, react, svelte and _shared, filled in by pane create
installer/windows/  PaneSetup.cs, the Windows installer program
types/           TypeScript types for pages and backends
test/unit/, test/e2e/
```

`test/unit/architecture.test.js` enforces these rules:
- `src/core` never loads Electron.
- `src/runtime` never loads the CLI or packaging.
- The CLI and packaging never load the Electron runtime.
- The preload and the runtime use the same message names.

## Tests

```sh
npm test                  # unit tests (including the layout rules), no window
npm run smoke             # creates an app, opens it, and drives the real window
npm run test:templates    # React and Svelte: npm install, Vite dev server, hot reload, build (needs network)
npm run test:notes        # drives the Notes example like a user: write, search, second window, delete
npm run test:installers   # the real .dmg (macOS) or Setup.exe (Windows) against a local copy of the distribution
npm run test:signing      # pane build --sign with a throwaway certificate (macOS or Windows)
```

CI (`.github/workflows/ci.yml`) runs the unit and smoke tests on macOS, Windows and Linux, the template and Notes tests on macOS, and the installer tests on macOS and Windows.

## Not done yet

- **Windows** installs are tested end to end in CI on Windows Server, not yet by hand on a Windows 10 or 11 desktop. Task Manager lists Pane apps as "Electron", because they share Pane's `electron.exe`.
- **Linux** launchers are written but not tested, and there's no Linux installer beyond `install.sh`.
- **Real certificates are untested.** `pane build --sign` is tested in CI with throwaway certificates. Nobody has yet notarized with Apple or built SmartScreen reputation. "Install <App>" runs a shell script as its program, and Apple's notary service may reject that.
- **No updater.** A launcher keeps the Chromium it was installed with until the app is installed again.
- **Signing.** Launchers are signed ad hoc, so macOS may ask again for access to an app's saved secrets after Pane updates. Pane's own release key isn't created yet, so installers built today refuse to download Pane (`pane build` warns about this).
- **Fuses** are turned off only in macOS launchers. Windows and Linux apps run the shared `electron.exe`, which the `pane` command needs as Node.
- **Intel Macs and Linux on ARM** have no release build yet. The release workflow builds macOS arm64, Windows x64 and Linux x64.

## License

MIT. See [LICENSE](LICENSE).
