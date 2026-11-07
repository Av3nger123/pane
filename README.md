# Pane

Pane is installed on a computer once. After that, every Pane app uses Pane's Chromium and Node, so an app is only its own files: a few hundred KB instead of the 150 to 300 MB that each Electron app ships.

Each app still behaves like a normal desktop app:
- It runs in its own process.
- It opens as many windows as it needs.
- It has its own name and icon in the Dock or taskbar, and its own data.

## Make an app

```sh
npm install                       # once, in this folder (downloads Electron)
node bin/pane.js create my-app    # or: pane create my-app
node bin/pane.js dev my-app
```

`pane dev` reloads windows when the web files change. It restarts the backend when backend code changes, and restarts the whole app when `pane.json` changes. The **Develop** menu has Reload, Restart Backend and Developer Tools.

An app is a folder:

```
my-app/
  pane.json          name, id, version, windows, permissions
  icon.png           square PNG, 512 px or more
  ui/                the app's web files: any HTML/CSS/JS, any framework's build output
    index.html
  backend/main.js    optional: Node, running on Pane's built-in Node
```

### pane.json

```json
{
  "id": "my-app",
  "name": "My App",
  "version": "0.1.0",
  "pane": ">=0.1.0",
  "ui": "ui",
  "start": "index.html",
  "backend": "backend/main.js",
  "icon": "icon.png",
  "window": { "width": 960, "height": 640, "titleBar": "hidden", "background": "#f6f6f3" },
  "permissions": ["notifications"]
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes. Identifies the app and its data. |
| `pane` | Pane versions the app works with: `">=0.1.0"`, `"^1.2.0"`. |
| `backend` | Optional. A Node file that runs in its own process. |
| `window.titleBar` | `"default"` is the normal title bar. `"hidden"` makes the window controls float over the page, so the app gets the whole window. |
| `permissions` | `notifications`, `camera`, `microphone`, `clipboard`, `geolocation`. Anything not listed is refused. |

### In the page: `window.pane`

```js
await pane.call('save', note);            // call a backend function, get its return value
pane.send('refresh', data);               // send an event to the backend, no answer
const off = pane.on('progress', (p) => {}); // backend events; off() stops listening
pane.app;                                 // { id, name, version, dev, hasBackend, pane }
await pane.window.open('settings.html', { width: 480, height: 360 });
pane.window.close(); pane.window.minimize(); pane.window.toggleMaximize();
await pane.openExternal('https://example.com');
```

Pages have no access to Node or Electron, and they can only load the app's own `ui` folder. Web links open in the user's browser.

With `"titleBar": "hidden"`, Pane sets `--pane-safe-top`, `--pane-safe-left` and `--pane-safe-right` on `<html>`. Keep content out of that space, and give your top bar `-webkit-app-region: drag` so the window can be moved. The values change when the window enters or leaves full screen.

### In the backend: `require('pane')`

```js
const pane = require('pane');
pane.expose('save', async (note) => { /* ... */ return id; });
pane.expose({ list, remove });             // several at once
pane.on('refresh', (data) => {});
pane.emit('progress', 0.5);                // to every window
pane.app.dataDir;                          // private folder for this app's files
```

The backend is full Node: `fs`, `child_process`, network access and npm packages. `console.log` output appears in the terminal and the window's console during `pane dev`. In installed apps it goes to `<Pane home>/data/<id>/logs/backend.log`.

## Ship an app

```sh
pane build my-app                  # needs Pane on the user's computer
pane build my-app --with-runtime   # includes Pane (about 116 MB) for computers without it
```

`my-app/dist/My App 0.1.0/` contains:
- `my-app-0.1.0.paneapp`: the app.
- `Install My App.command`: double-click it on macOS or Linux. If Pane is missing, it installs Pane first, then installs the app and opens it. If Pane is already there, it installs only the app.

## What installing does

- **Pane** goes to `~/Library/Application Support/Pane/runtime/<version>`, and the `pane` command to `.../Pane/bin/pane`. That command runs on Pane's own Electron, so users don't need Node.
- **Apps** go to `.../Pane/apps/<id>`, and their data to `.../Pane/data/<id>`.
- **On macOS**, the launcher is `~/Applications/Pane Apps/<App>.app`. It's a real app bundle with its own bundle id, name, icon and helper processes. Its 251 MB Chromium framework is an APFS clone of Pane's copy, so it takes about 1.4 MB of real disk. A symlink doesn't work, because Chromium's sandboxed helpers refuse files outside their bundle.

Other commands: `pane install <folder|.paneapp>`, `pane uninstall <id> [--purge]`, `pane list`, `pane setup`.

Set `PANE_HOME` and `PANE_LAUNCHERS_DIR` to install somewhere else, for example while testing.

## Tests

```sh
npm test         # unit tests, no window
npm run smoke    # creates an app, opens it, and drives the real window
```

## Not done yet

- **Windows and Linux** launchers and installers are written but not tested. They create a Start menu shortcut or `.desktop` file instead of an app bundle.
- **No updater.** A launcher keeps the Chromium it was installed with until the app is installed again.
- **Signing.** Launchers are signed ad hoc. Downloads on other Macs need Developer ID signing and notarization, and Windows needs a code-signing certificate.
- **Online install.** Installers built without `--with-runtime` download Pane from `PANE_DOWNLOAD_URL`, but nothing hosts Pane yet.
- **No catalog.**
