# Phase 5: Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pane keeps itself current on every computer without users noticing, launchers follow it without keychain prompts, and apps can update themselves through a `pane.updates` API whose only rule is "signed by the same key".

**Architecture:**
- **All installing stays in the `pane` command (packaging layer).** The per-app Electron process never loads packaging code (architecture test). It starts `pane` as a detached child, `pane self-update` or `pane app-update …`, and reads JSON lines from it.
- **State lives in `PANE_HOME`:**
  - the update stamp and lock
  - per-app running markers
  - pending updates recorded in each app's `.pane-install.json`
- **macOS launchers get a stable designated requirement.** They are signed with a per-computer Pane identity kept in a Pane-owned keychain, so the keychain item behind `pane.secrets` keeps trusting the app across rebuilds.

**Tech stack:** Node 24 (`fetch`, `crypto`), the Phase 4 signatures (`release-signature.js`, `app-signature.js`, `publishers.js`, `fuses.js`, `macho-signature.js`), `tar`, `codesign`, `security`, `openssl` (LibreSSL on macOS).

**Spec:** `docs/superpowers/specs/2026-11-08-phase-5-updates-design.md`

## Global Constraints

- **No Pane-drawn update UI:** no dialogs, banners, notifications or settings from Pane. Pane updates are silent. The only output goes to `PANE_HOME/logs/update.log`.
- **A running app is never closed, reloaded or interrupted** by a Pane update.
- **Pane checks for its own update when an app opens (production only, never `pane dev`), at most once a day per computer.**
- **Every app moves to the newest Pane** unless its `pane.json` `pane` range excludes it. Pane fetches only its newest release.
- **App updates:**
  - Only for apps installed with a key.
  - The update must be signed by the **recorded** key.
  - The unsigned-to-signed switch is not allowed through `pane.updates`.
  - The update installs on the app's next restart, never under a running app.
- **Update addresses** (`pane.json` `updates`, Pane's `latestUrl`) use https; `http://localhost` and `http://127.0.0.1` are allowed for tests.
- **Trust anchors for Pane updates come from the installed Pane's `package.json` `pane.releaseKeys`.** `PANE_RELEASE_KEYS` is read only at build and pack time, never during an update.
- **Layering** (`test/unit/architecture.test.js` keeps passing): `src/runtime` never loads cli or packaging; `src/core` never loads Electron.
- **Tests:**
  - Sandbox `PANE_HOME` / `PANE_LAUNCHERS_DIR`.
  - Unregister macOS launchers on cleanup.
  - Never change the user's real keychains or certificate stores.
  - Tests that change keychain settings run only when `CI` is set.
- **Process:** no `Co-Authored-By` trailers; `main` changes only through a PR; no tags or releases.
- **User-facing messages:** plain English, saying what happened and what to do.
- **The Notes "Update available" UI is built only after the owner approves mockups.**

## Review Focus

1. **Two apps open at the same moment, both due for a check.** Only one `pane self-update` runs; the other exits quietly. Pinned in Task 3 (lock test).
2. **The computer goes offline, or the latest file returns garbage or an older version.** No change, nothing logged as installed, and the next check is still allowed the next day. Pinned in Task 3.
3. **The user reopens an app while its launcher is being moved to the new Pane.** The app still opens, on the old or the new Pane, never broken. Pinned in Task 5 (the relaunch path waits for the rebuild).
4. **An app update needs a newer Pane than the computer has.** Pane updates itself first, quietly. If that fails, the app update is refused with a plain reason. Pinned in Task 13.
5. **An old Pane is removed while something still uses it.** It is never removed while any record or running marker references it. Pinned in Task 6.

---

# Part 1: Pane updates itself

### Task 1: Where the newest Pane is announced, and test builds of other versions

**Files:**
- Modify:
  - `src/packaging/runtime.js`: `latestUrl()`; `packRuntime` writes `pane-latest.json` and bakes release keys and an optional version into the staged `package.json`
  - `package.json`: `"pane": { "latestUrl": "https://github.com/Av3nger123/pane/releases/latest/download/pane-latest.json" }`
  - `.github/workflows/release.yml`: uploads `pane-latest.json` once, from the ubuntu runtime job
  - `README.md`: one paragraph. GitHub's "latest" ignores pre-releases, and the release workflow creates pre-releases, so updates see a release once the owner marks it latest.
- Test: `test/unit/updates.test.js` (new)

**Interfaces:**
- Produces:
  - `latestUrl({ env = process.env } = {}) -> string | null`: `env.PANE_LATEST_URL`, else `package.json` `pane.latestUrl`, with the same https/localhost rule as `distributionUrl()`.
  - `packRuntime({ out, signingKey, version })`:
    - writes `<out>/pane-latest.json` = `{"version":"<v>"}`
    - writes `<out>/v<v>/…` as today
    - the staged runtime's `package.json` gets `version` (when given) and `pane.releaseKeys` = `releaseKeys()`, which reads `PANE_RELEASE_KEYS` at pack time
    - returns `{ dir, archive, sha256, signature, latest }`
  - `RUNTIME_FILES` unchanged.

- [ ] **Step 1: Write the failing tests** in `test/unit/updates.test.js`:
  - `test('latestUrl: https only, localhost for tests, env override')`: same cases as the existing `distributionUrl` test, with `PANE_LATEST_URL`.
  - `test('pack-runtime: latest file, baked keys, other versions')` (skip on win32):
    - with `PANE_RELEASE_KEYS=[A.publicPem]`, run `packRuntime({ out, signingKey: A.privatePem, version: '0.1.1' })`
    - assert `JSON.parse(read(out/pane-latest.json))` equals `{ version: '0.1.1' }`
    - assert the archive name contains `0.1.1`
    - untar into a temp dir: `package.json` has `version === '0.1.1'` and `pane.releaseKeys` deep-equals `[A.publicPem.trim()]`
- [ ] **Step 2: Run** `node --test test/unit/updates.test.js`. Expected: FAIL (`latestUrl` is not a function).
- [ ] **Step 3: Implement** the interfaces in `runtime.js`. `stageRuntime` rewrites the staged `package.json` after copying.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 1a: announce the newest Pane; pack test versions"`

### Task 2: Download, check and install a Pane in Node

**Files:**
- Create: `src/packaging/runtime-download.js`
- Test: `test/unit/updates.test.js`

**Interfaces:**
- Consumes: `verifyRelease`, `checkReleaseKeys` (Phase 4); `runtimeArchiveName`, `distributionUrl` (runtime.js); `RUNTIME_ROOT`, `electronBinary`.
- Produces:
  - `installedReleaseKeys(runtimeDir = RUNTIME_ROOT) -> string[]`: `checkReleaseKeys` on that runtime's `package.json` `pane.releaseKeys`. It never reads the environment.
  - `downloadRuntime({ version, dist, keys, onProgress }) -> Promise<{ dir: string, version: string }>`:
    1. Fetch the archive and `.sig` with `fetch` (which follows redirects) into a temp dir under `PANE_HOME/downloads`.
    2. Throw `RuntimeDownloadError` with these messages when a check fails:
       - `"Pane <v>'s download is not signed by Pane."`
       - `"Could not download Pane <v>: <reason>"`
       - `"This Pane download is version X, but version Y was expected."` (from `setup --expect` output)
    3. Unpack with `tar -xzf`; on win32, `%SystemRoot%\System32\tar.exe`.
    4. Run `<unpacked electron> <unpacked>/bin/pane.js setup --expect <v>` with `ELECTRON_RUN_AS_NODE=1`.
    5. Return the installed dir, `runtimesDir()/<v>`.
    6. Remove the temp dir in every case.

- [ ] **Step 1: Write the failing tests** (skip on win32; one packed runtime shared across them):
  - `test('downloadRuntime installs a signed Pane of the asked version')`:
    - pack `0.1.1` with key A and serve it with `test/e2e/lib/serve.js`
    - with a sandbox `PANE_HOME`, `downloadRuntime({ version: '0.1.1', dist: server.url, keys: [A.publicPem] })` resolves `{ version: '0.1.1' }`
    - `fs.existsSync(dir + '/main.js')`
  - `test('downloadRuntime refuses a wrong key, a missing signature, a wrong version')`:
    - keys `[B.publicPem]` rejects `/not signed by Pane/`
    - a server without the `.sig` rejects `/not signed by Pane|signature/`
    - asking for `'0.1.1'` while serving a correctly signed `0.1.2` archive under the `0.1.1` name rejects `/version 0\.1\.2.*0\.1\.1/`
    - after each, `runtimesDir()` has no new version folder
- [ ] **Step 2: Run** them. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 1b: download and install a signed Pane from Node"`

### Task 3: `pane self-update` (stamp, lock, latest file)

**Files:**
- Create:
  - `src/core/update-state.js`: stamp and lock helpers, pure fs, used by both runtime and packaging
  - `src/packaging/self-update.js`
  - `src/cli/commands/self-update.js`
- Modify: `src/cli/index.js` (HELP: `pane self-update [--force]`)
- Test: `test/unit/updates.test.js`

**Interfaces:**
- Produces, in `src/core/update-state.js`:
  - `updateDue({ now = Date.now() } = {}) -> boolean`: false if `PANE_HOME/update-check.json` `{ lastCheck }` is less than 24 h old.
  - `markChecked({ now })`.
  - `takeLock(name) -> release() | null`: `fs.openSync(PANE_HOME/locks/<name>.lock, 'wx')` with the pid inside. A lock older than 30 minutes, or held by a dead pid, is taken over.
- Produces, in `src/packaging/self-update.js`, `selfUpdate({ force = false, now }) -> Promise<{ status, version, error? }>`:
  - `status` is one of `'not-due'`, `'busy'`, `'up-to-date'`, `'updated'`, `'failed'`.
  - Order: `updateDue` unless forced → `takeLock('self-update')` → fetch `latestUrl()` → if `version > installed current`, `downloadRuntime` (keys = `installedReleaseKeys()`) → `moveAppsOnto(dir)` (Task 4) → `cleanupRuntimes()` (Task 6) → `markChecked`.
  - Offline, a bad latest file or an older version: no install; `markChecked` is still written, so the computer doesn't retry every launch.
  - Every outcome is appended to `PANE_HOME/logs/update.log`.
- `pane self-update [--force]` prints the result as one JSON line and exits 0, or 1 on `failed`.

- [ ] **Step 1: Write the failing tests**, with a sandbox `PANE_HOME` and a fake `now`:
  - `test('update stamp: once a day')`: due → `markChecked` → not due at +23 h → due at +25 h.
  - `test('update lock: one at a time, stale locks expire')`:
    - a second `takeLock` returns null while the first is held
    - after `release()` it works
    - a lock file with a dead pid (`999999`) is taken over
  - `test('selfUpdate: up to date, newer, offline, garbage, older')` (skip on win32):
    - Pane `0.1.0` installed in the sandbox via `setupRuntime`
    - `latestUrl` served as `{"version":"0.1.0"}` gives `up-to-date`
    - `{"version":"0.1.1"}` with a packed `0.1.1` gives `updated`, and `installedRuntime()` ends with `0.1.1`
    - an unreachable address gives `failed`, and stays `not-due` until forced
    - `"nonsense"` and `{"version":"0.0.9"}` both give no install
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces (`moveAppsOnto` and `cleanupRuntimes` can be stubs that Tasks 4 and 6 fill).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 1c: pane self-update"`

### Task 4: Moving installed apps onto the new Pane

**Files:**
- Create: `src/core/running.js` (running markers, pure fs)
- Modify: `src/packaging/apps.js` (`moveAppsOnto`, `refreshLauncher`; the record gains `pendingRuntime`)
- Test: `test/unit/updates.test.js`

**Interfaces:**
- Produces, in `src/core/running.js`:
  - `markRunning(id, { pid, runtimeDir })` writes `PANE_HOME/running/<id>.json`.
  - `clearRunning(id, pid)` removes it only if the pid matches.
  - `runningApps() -> Array<{ id, pid, runtimeDir }>` keeps entries whose pid is alive (`process.kill(pid, 0)`) and deletes stale files.
- Produces, in `src/packaging/apps.js`:
  - `refreshLauncher(id, runtimeDir) -> record`:
    - recreates the launcher with `createLauncher({ …, runtimeRoot: runtimeDir })`
    - updates `record.runtime` and `record.runtimeDir`, and clears `pendingRuntime`
    - throws if the app's `pane` range excludes that runtime's version
  - `moveAppsOnto(runtimeDir) -> Array<{ id, result: 'moved' | 'pending' | 'kept' }>`, for each installed app:
    - `kept` when its range excludes the new version
    - `pending` (record gets `pendingRuntime: runtimeDir`) when `runningApps()` lists it
    - otherwise `refreshLauncher`, which gives `moved`

- [ ] **Step 1: Write the failing tests** (skip on win32; launchers in the sandbox, `lsregister -u` on cleanup):
  - Install two apps on Pane `0.1.0`: `a` with `"pane": ">=0.1.0"` and `b` with `"pane": "0.1.0"`.
  - Mark `a` running with the test's own pid. Install a fake second runtime dir `0.1.1`: a `stageRuntime` copy with its version changed.
  - `moveAppsOnto(<0.1.1 dir>)` returns `a: pending, b: kept`.
  - `clearRunning('a', pid)`, then `moveAppsOnto` again returns `a: moved`.
  - `a`'s launcher `boot.js` (macOS) contains the `0.1.1` dir.
  - `runningApps()` drops a marker whose pid is `999999`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 1d: move installed apps onto a new Pane"`

### Task 5: The runtime starts the check and finishes pending moves

**Files:**
- Create:
  - `src/runtime/updates.js`
  - `src/cli/commands/launcher-refresh.js`: `pane launcher-refresh <id> --open [--after <pid>]`
- Modify: `src/runtime/main.js` (call `startUpdates()` in production after `app.whenReady`), `src/cli/index.js`
- Test: `test/e2e/updates.js` (new; `npm run test:updates`; wired into CI's installers job)

**Interfaces:**
- Consumes: `updateDue`, `markRunning`, `clearRunning` (core); `refreshLauncher` through the CLI; the `.pane-install.json` record.
- Produces: `startUpdates({ manifest, home, isDev }) -> { pendingRelaunch: boolean }` in `src/runtime/updates.js`. In production only:
  1. Call `markRunning`, and `clearRunning` on `will-quit`.
  2. If this app's record has `pendingRuntime` (or `pendingUpdate`, Task 13):
     - spawn detached `<PANE_HOME>/bin/pane launcher-refresh <id> --open --after <process.pid>`
     - return `{ pendingRelaunch: true }`
     - `main.js` then calls `app.exit(0)` before creating any window
  3. Otherwise, 10 s after the first window shows, if `updateDue()`, spawn detached `pane self-update`. Use `windowsHide: true` and `stdio: 'ignore'`, and remove `ELECTRON_RUN_AS_NODE` from the child env (the `pane` script sets its own).
- `pane launcher-refresh <id> --open --after <pid>`:
  - waits up to 30 s for `pid` to exit
  - takes `takeLock('app-<id>')`
  - runs `refreshLauncher(id, record.pendingRuntime)`, or Task 13's `applyPendingUpdate`
  - opens the launcher with the existing `openLauncher`
  - if the refresh fails, opens the existing launcher anyway and logs the error, so the app always opens (Review Focus 3)

- [ ] **Step 1: Write the failing e2e test** `test/e2e/updates.js`. macOS and Windows; it reuses `serveDir`, `waitForPage` and `connect`.
  - **Setup:**
    - make a release key A
    - pack Pane `0.1.0` and `0.1.1` with `PANE_RELEASE_KEYS=[A]`; serve `dist` with `pane-latest.json` = `0.1.0`
    - in a sandbox, install Pane `0.1.0` (download through the built installer's path, or `pane setup` from the unpacked archive)
    - `pane install` a created app with a backend and launch it from its launcher with a debugging port
    - assert `pane.app.pane === '0.1.0'`
  - **Update while running:**
    - point `pane-latest.json` at `0.1.1` and remove `PANE_HOME/update-check.json`
    - restart the app (the check runs on launch)
    - wait up to 3 minutes for `runtime/0.1.1/main.js` to exist and the record to have `pendingRuntime`
    - assert `pane.call('greet', 'x')` still answers and no new window appeared (the CDP target list is unchanged)
  - **Next open:**
    - quit the app (close its window; wait for the pid to exit) and open the launcher again
    - wait for a page whose `pane.app.pane === '0.1.1'`, with a working backend
  - **Pinned app:** an app with `"pane": "0.1.0"`, installed alongside, still reports `0.1.0` after reopening.
  - **A failed move still opens the app** (Review Focus 3): set a record's `pendingRuntime` to a missing folder and run `pane launcher-refresh <id> --open`.
    - it exits 0
    - `update.log` records the failure
    - the record keeps its old `runtimeDir`
    - the app opens on its old Pane
- [ ] **Step 2: Run** `npm run test:updates` on macOS. Expected: FAIL (no check is started).
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm run test:updates`, `npm run test:installers` and `npm run smoke` on macOS; push for Windows CI. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 1e: apps start Pane's update check and finish moves on next open"`

### Task 6: Removing Panes nobody uses

**Files:**
- Modify: `src/packaging/runtime.js` (`cleanupRuntimes`), `src/packaging/self-update.js` (call it), `src/cli/commands/launcher-refresh.js` (call it after a move)
- Test: `test/unit/updates.test.js`, `test/e2e/updates.js`

**Interfaces:**
- Produces: `cleanupRuntimes() -> string[]`, the removed versions. A version folder in `runtimesDir()` is removed only if:
  - it is not `current`
  - no app record's `runtimeDir` or `pendingRuntime` points at it
  - no `runningApps()` entry points at it
  - it isn't the runtime running this command (`RUNTIME_ROOT`)

  `.partial` folders older than an hour are removed too.

- [ ] **Step 1: Write the failing tests:**
  - Unit: with runtimes `0.1.0`, `0.1.1` (current) and `0.0.9`, a record on `0.1.0` and nothing on `0.0.9`, `cleanupRuntimes()` returns `['0.0.9']`.
  - Unit: a running marker on `0.1.0` keeps it even after the record moves to `0.1.1`.
  - E2e (Task 5's test): after the reopen, `runtime/0.1.0` still exists, because the pinned app uses it. After uninstalling the pinned app and running `pane self-update --force`, `runtime/0.1.0` is gone.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test` and `npm run test:updates`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 1f: remove Panes no app uses"`

# Part 2: No keychain prompt after an update (macOS)

### Task 7: A per-computer signing identity for launchers

**Files:**
- Create: `src/packaging/signing/local-identity.js`
- Test: `test/e2e/keychain.js` (new; `npm run test:keychain`; runs only when `CI` is set, on macOS)

**Interfaces:**
- Produces: `ensureLocalIdentity({ env = process.env } = {}) -> { identity: string, keychain: string } | null`:
  - Returns null when `env.PANE_LAUNCHER_SIGNING === 'adhoc'` (tests that don't concern signing set this) or the platform isn't darwin.
  - Otherwise, on first use, creates:
    - `PANE_HOME/signing/pane.keychain-db`
    - a random password in `PANE_HOME/signing/password` (mode `0600`)
    - a self-signed code-signing certificate `CN=Pane Local Signing (<hostname>)`, valid 20 years, made with `openssl`, imported with `-T /usr/bin/codesign`, with the key partition list set using the stored password
  - Unlocks the keychain on every call.
  - Makes sure the keychain is on the user's search list, appending it and keeping every existing entry.
  - Returns the identity's SHA-1.
  - Never touches the login keychain and never asks for the user's password.
- Accepted risk, recorded in the README: malware already running as the user could read the password file and sign as Pane. Such malware can already edit the app's own files in `PANE_HOME/apps`, so this adds no new exposure.

- [ ] **Step 1: Write the failing CI-only test** `test/e2e/keychain.js`, part 1:
  - save the user's search list and default keychain
  - run `ensureLocalIdentity()` with a sandbox `PANE_HOME`
  - assert `security find-identity -p codesigning <keychain>` lists it
  - assert the search list now contains the keychain and every original entry
  - a second call returns the same SHA-1
  - restore the search list and default keychain in `finally`
- [ ] **Step 2: Run** `CI=1 npm run test:keychain` on the macOS CI runner. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 2a: a per-computer signing identity for launchers"`

### Task 8: Launchers signed with it keep their secrets across rebuilds

**Files:**
- Modify:
  - `src/packaging/launchers/macos.js`: sign helpers and the app with `ensureLocalIdentity()` when it returns one (`codesign --force --sign <sha1> --keychain <kc>`), else ad hoc as today. The framework keeps its in-place repaired ad hoc signature.
  - Every existing e2e and unit test that installs apps: set `PANE_LAUNCHER_SIGNING=adhoc` in its env, so local runs never touch keychains.
- Test: `test/e2e/keychain.js`, part 2

- [ ] **Step 1: Write the failing CI-only test**, part 2:
  - set a temporary default keychain with `security default-keychain -s <tmp>`, restored in `finally`
  - install an app whose page can call `pane.secrets`, and launch it
  - `await pane.secrets.set('token', 'kept')`, then quit
  - rebuild its launcher onto a second staged runtime (as a Pane update would)
  - launch again and assert `await pane.secrets.get('token') === 'kept'` within 20 s. A keychain prompt would block on CI, so a timeout counts as failure.
  - **Control run:** the same with `PANE_LAUNCHER_SIGNING=adhoc` must fail, which proves the test detects the prompt.
- [ ] **Step 2: Run** `CI=1 npm run test:keychain` on macOS CI. Expected: the main run FAILS (launchers are still ad hoc) and the control fails.
- [ ] **Step 3: Implement** the signing change.
- [ ] **Step 4: Run** it again, plus `npm run test:installers` and `npm run test:updates`. Expected: the main run PASSES, the control fails as designed, and the others pass.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 2b: launchers keep their keychain access across Pane updates"`

# Part 3: Apps update themselves

### Task 9: `updates` in `pane.json`, the update file, and `pane build --update-url`

**Files:**
- Create: `src/core/app-update.js`
- Modify:
  - `src/core/manifest.js`: optional `updates` (https, or localhost), with the error `"updates" must be an https address of your update file.`
  - `src/packaging/build.js`: writes `<outDir>/latest.json`
  - `src/cli/commands/build.js` and `src/cli/index.js`: `--update-url <base>`
- Test: `test/unit/updates.test.js`, `test/unit/core.test.js`

**Interfaces:**
- Produces, in `src/core/app-update.js`, `parseUpdateFile(text) -> { version, url, notes, pane, sha256 }`:
  - `version` must be a valid version
  - `url` must be https or localhost
  - `notes` is a string ≤ 2000 characters, or null
  - `pane` must be a valid spec, or null
  - `sha256` is 64 hex characters, or null
  - throws `UpdateFileError` naming the bad field
- `buildInstaller(…, { updateUrl })` writes `latest.json` = `{ version, url: <updateUrl joined with the .paneapp name, or "">, pane: manifest.pane, sha256 }`. Without `--update-url`, it warns that `url` is empty and must be filled in before uploading.

- [ ] **Step 1: Write the failing tests:**
  - `parseUpdateFile`: a valid file round-trips; `version: 'x'`, `url: 'http://evil'` and `sha256: 'zz'` each throw, naming the field.
  - Manifest: `updates: 'https://a/b.json'` is kept; `'http://a'` errors.
  - Build: with `{ updateUrl: 'https://dl.example.com/notes/' }`, `latest.json` has `url === 'https://dl.example.com/notes/<id>-0.1.0.paneapp'` and a `sha256` matching the file.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 3a: update addresses and update files"`

### Task 10: `pane app-update` (check, download, stage, apply)

**Files:**
- Create: `src/packaging/app-updates.js`, `src/cli/commands/app-update.js`
- Modify: `src/packaging/apps.js` (record gains `pendingUpdate`; `installApp(source, { requireSigner })`)
- Test: `test/unit/updates.test.js`

**Interfaces:**
- Consumes: `parseUpdateFile` (Task 9); `verifyApp` and `publisherOf` (Phase 4); `selfUpdate` (Task 3).
- Produces, in `src/packaging/app-updates.js`:
  - `checkAppUpdate(id) -> Promise<{ available: boolean, version, notes }>`:
    - throws `AppUpdateError` with `"<Name> is not signed, so it cannot update itself. Its developer must build it with pane build --key."` when the app's publisher record is null or missing
    - throws `"<Name> has no update address."` when the manifest has no `updates`
  - `downloadAppUpdate(id, { onProgress }) -> Promise<string>`, the path to the downloaded file under `PANE_HOME/updates/<id>/`. It checks `sha256` when given.
  - `stageAppUpdate(id, file) -> Promise<{ version }>`:
    1. Unpack to a temp dir.
    2. Check: same id; `verifyApp` gives a signer; the signer's key is the **recorded** key (full key comparison); version newer than installed.
    3. If the update's `pane` range isn't met by any installed Pane, run `selfUpdate({ force: true })`, then re-check (Review Focus 4). If it's still not met: `"<Name> <v> needs Pane <range>, which could not be installed: <reason>"`.
    4. Set `record.pendingUpdate = file`.
  - `applyPendingUpdate(id) -> record`: `installApp(file, { requireSigner: true })`, then remove the file and clear `pendingUpdate`.
    - `installApp` with `requireSigner` refuses unsigned, and refuses unsigned-to-signed: it needs an existing key record equal to the signer.
- CLI, each printing JSON lines (`{"progress":0.4}` …, then `{"result":…}` or `{"error":"…"}`) and exiting 0 or 1:
  - `pane app-update check <id>`
  - `pane app-update download <id>` (downloads and stages)
  - `pane app-update install-file <id> <file>` (stages)
  - `pane app-update apply <id> [--open] [--after <pid>]`

- [ ] **Step 1: Write the failing tests** (skip on win32; sandbox):
  - Install app v0.1.0 signed by key K; serve v0.2.0 signed by K with a `latest.json`.
  - `checkAppUpdate` gives `{ available: true, version: '0.2.0' }`.
  - `downloadAppUpdate` then `stageAppUpdate` sets `pendingUpdate`; `applyPendingUpdate` makes the record version `0.2.0`.
  - **Refusals**, each leaving the installed version unchanged with no `pendingUpdate`:
    - v0.3.0 signed by key L rejects `/different publisher|not signed by/`
    - v0.3.0 unsigned rejects `/unsigned/`
    - v0.1.5 signed by K but older than installed rejects `/newer/`
    - an app installed unsigned: `checkAppUpdate` rejects `/not signed, so it cannot update itself/`
  - `install-file` with a correct file stages it.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 3b: pane app-update: check, download, stage, apply"`

### Task 11: `pane.updates` in pages and backends

**Files:**
- Create: `src/runtime/ipc/updates.js`
- Modify:
  - `src/runtime/ipc/channels.js`: `UPDATES: 'pane:updates'`, `EVENTS.UPDATE_PROGRESS: 'pane:update-progress'`, `EVENTS.UPDATE_READY: 'pane:update-ready'`
  - `src/runtime/ipc/index.js`
  - `src/runtime/preload.js`
  - `src/runtime/backend.js` and `sdk/backend/index.js`: a backend→main request message `{ type: 'request', id, api, args }` answered with `{ type: 'response', id, result | error }`
  - `src/runtime/updates.js`: `pendingUpdate` triggers the relaunch from Task 5
  - `types/index.d.ts`, `types/backend.d.ts`
- Test: `test/e2e/updates.js` (app update section)

**Interfaces:**
- Consumes: the `pane app-update` CLI (Task 10). The runtime spawns `<PANE_HOME>/bin/pane app-update …` and parses its JSON lines.
- Produces, in pages (`window.pane.updates`) and backends (`pane.updates`):
  - `check() -> Promise<{ available, version, notes }>`
  - `download() -> Promise<{ version }>`: downloads and stages; progress goes to `onProgress`
  - `installFile(path) -> Promise<{ version }>`
  - `restartToUpdate() -> void`: spawns `pane app-update apply <id> --open --after <pid>` detached, then `app.quit()`
  - `onProgress(fn) -> unsubscribe`, with `fn(fraction)`
  - `onReady(fn) -> unsubscribe`, with `fn({ version })`
  - Errors reject with the CLI's message.
  - In `pane dev`, every call rejects with `"Updates work in installed apps, not under pane dev."`

- [ ] **Step 1: Write the failing e2e section** in `test/e2e/updates.js`:
  - Install v0.1.0 of an app signed by K, with `updates` pointing at the local server; launch it from its launcher.
  - Through CDP:
    - `await pane.updates.check()` gives `available: true, version: '0.2.0'`
    - `await pane.updates.download()` resolves, and `onReady` fired once
    - `pane.updates.restartToUpdate()`
  - Wait for a new page whose `pane.app.version === '0.2.0'`.
  - The backend's `pane.updates.check()` (through an exposed method) gives `available: false`.
  - An installed unsigned app's `check()` rejects `/not signed/`.
- [ ] **Step 2: Run** `npm run test:updates` on macOS. Expected: FAIL (`pane.updates` is undefined).
- [ ] **Step 3: Implement** per the interfaces. `architecture.test.js` must still pass: the channel strings live in `channels.js`, and the runtime doesn't load packaging.
- [ ] **Step 4: Run** `npm test` and `npm run test:updates`; push for Windows CI. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 5, part 3c: pane.updates in pages and backends"`

### Task 12: Docs, CI and the README

**Files:**
- Modify:
  - `.github/workflows/ci.yml`: installers job adds `npm run test:updates`; `npm run test:keychain` runs on the macOS installers job only
  - `README.md`:
    - "Updates" section: Pane updates quietly; Pane's compatibility promise; pinning an exact Pane version; `updates` in `pane.json`; `pane build --update-url`; the `pane.updates` API; only signed apps update; no update screens from Pane
    - Code layout lines for the new files
    - Remove "No updater" from "Not done yet"
  - `types/`: already done in Task 11; check
- [ ] **Step 1:** Make the edits.
- [ ] **Step 2: Verify.** Push and open the PR. Expected: all CI checks green, including the new steps.
- [ ] **Step 3: Commit** `git commit -m "Phase 5, part 3d: document updates; run update tests in CI"`

### Task 13: The Notes example's own update UI (gated)

- [ ] **Step 1: Stop.** Make mockups of Notes' update experience (where "Update available" appears, what the user can do, what happens during download and restart). Show them to the owner. **Do not build until the owner explicitly approves one.**
- [ ] **Step 2:** After approval, add `updates` to `examples/notes/pane.json` and build the approved UI with `pane.updates`. `test:notes` gains an assertion that the UI shows when `check()` reports an update (served locally).
- [ ] **Step 3: Commit** `git commit -m "Notes: show its own update screen"`

---

## Not in this plan

- Certificate checks on app updates (design decision 7).
- Rolling back a bad Pane or app version.
- Settings that turn updates off for a whole computer.
- Memory and CPU sharing between apps (discussed 2026-11-08, revisit after Phase 5).
