# Phase 4: Trust Without Paid Certificates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what users install trustworthy without Pane buying certificates: the runtime download is signed by Pane, each app is signed by its developer and its id belongs to that developer, launchers cannot be borrowed to run other code, and developers who do own certificates can sign their installers with one flag.

**Architecture:** Four parts, each its own PR on branch `phase-4-*` → `main`. Signature math lives in `src/core` (pure Node `crypto`, no Electron). Installing and building use it from `src/packaging`. The download checks run where no Pane exists yet: in `install.sh` (`openssl`) and `PaneSetup.cs` (.NET Framework `RSACryptoServiceProvider`).

**Tech stack:** Node 24 `crypto` (RSA-3072 PKCS#1 v1.5 SHA-256 for the runtime, Ed25519 for apps), `/bin/sh` + `openssl dgst`, C# 5 compiled by Windows' built-in `csc.exe`, `codesign` / `xcrun notarytool` / `xcrun stapler`, `signtool.exe`.

**Spec:** the description agreed in chat on 2026-11-08 ("Phase 4 for Pane is the four free items"). Its points, with the decisions this plan adds:

1. **Signed runtime downloads.** Release archives get a detached signature. Installers carry Pane's public keys and refuse a runtime that does not verify.
   - *Decision:* RSA-3072, not Ed25519. The check must run before any Pane exists, in `/bin/sh` with the system `openssl` (LibreSSL on macOS) and in C# 5 on .NET Framework. Neither verifies Ed25519 reliably; both verify RSA PKCS#1 v1.5 SHA-256.
2. **App identity.** Developers sign `.paneapp` files with their own Ed25519 key. The first install records the key per app id. Later installs of that id must carry the same key. `pane install` prints the publisher and permissions.
3. **Electron fuses off on launchers:** `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`. The `pane` command's Electron keeps them.
   - *Decision:* macOS only. Windows and Linux launchers start the shared `electron.exe` / `electron` directly (no per-app copy), and the `pane` command needs `RunAsNode` on that same binary. The threat (borrowing an app's camera, microphone or file permissions) is a macOS TCC problem.
   - *Decision:* Pane writes the fuse bytes in place. `@electron/fuses` rewrites the whole 160 MB framework file, which un-shares the APFS clone that keeps each launcher at about 1.4 MB. `@electron/fuses` becomes a devDependency, used only to cross-check fuse positions in a test.
4. **`pane build --sign`** signs installers with the *developer's* certificates. It is tested in CI with throwaway self-signed certificates. Notarization and SmartScreen reputation stay untested until a real certificate exists.

## Global Constraints

- Node 24 and Electron 45.2.3. No new runtime dependencies. `@electron/fuses` is a devDependency only.
- `PaneSetup.cs` stays C# 5 and compiles with `installer/windows/build.js` (`csc.exe /target:winexe`).
- Layer rules in `test/unit/architecture.test.js` hold: `src/core` never loads Electron, cli or packaging; `src/packaging` never loads Electron.
- Private keys never enter the repo, logs or test output. Keys written to disk get mode `0600`.
- Public keys and fingerprints are fine to print.
- Trust anchors are fixed at **build** time. Nothing a user's environment sets at install time may add or replace a key. `PANE_DIST_URL` may still change the download address, because the signature makes it safe.
- Tests that install use a sandboxed `PANE_HOME` / `PANE_LAUNCHERS_DIR`, and unregister macOS launchers (`lsregister -u`) during cleanup.
- Tests never modify the machine's certificate stores or default keychain. Signing tests use temp keychains and PFX files.
- Commits carry no `Co-Authored-By` trailer. Changes reach `main` only through PRs. No tags or releases.
- No new UI: installer windows, dialogs and notifications keep their current look. New information is CLI text only. A UI change needs mockups first.
- User-facing messages are plain English, say what happened and what to do, and never apologise.

## Review Focus

1. **A signed `Setup.exe` must still find its app.** Authenticode appends a certificate table after the payload trailer. Pinned in Task 10 (synthetic PE) and Task 11 (real signtool).
2. **A missing `.sig` (404), a truncated archive or a wrong key all stop the install.** Nothing gets installed, and the message names the cause. Pinned in Task 2 (sh) and Task 3 (C#).
3. **An app installed before Phase 4 (no publisher record) gets a signed update.** It is accepted and the key recorded. **An app uninstalled without `--purge` and reinstalled from another key** is refused, because its data is still there. Pinned in Task 7.
4. **`.paneapp` files with symlinks** (`node_modules/.bin`) and empty folders verify after a tar round trip. Pinned in Task 5.
5. **Launchers created before Phase 4 keep working.** A reinstall or a fresh install gets the fuses, and the app still launches with a working backend. Pinned in Task 9 (installers e2e launches the app).

---

# Part 1: Signed runtime downloads

### Task 1: Release signatures in core, `pane keygen --release`, `pack-runtime` signs

**Files:**
- Create: `src/core/release-signature.js`
- Create: `src/cli/commands/keygen.js` (release keys now, app keys in Task 6)
- Modify: `src/packaging/runtime.js` (`packRuntime`), `src/cli/commands/pack-runtime.js`, `src/cli/index.js` (HELP, `keygen` case, `key` in `VALUE_FLAGS`), `package.json` (`"pane": { "releaseKeys": [] }`)
- Test: `test/unit/signing.test.js` (new)

**Interfaces:**
- Produces, in `src/core/release-signature.js`:
  - `generateReleaseKey() -> { privatePem: string, publicPem: string }`: RSA 3072, PKCS#8 / SPKI PEM.
  - `signRelease(data: Buffer, privatePem: string) -> Buffer`: 384 raw bytes, `crypto.sign('sha256', …)`.
  - `verifyRelease(data: Buffer, signature: Buffer, publicPems: string[]) -> boolean`: true if any key verifies.
  - `checkReleaseKeys(publicPems: unknown) -> string[]`: throws `Error` unless an array of RSA public PEMs of at least 3072 bits. Returns them trimmed.
  - `jwkParts(publicPem: string) -> string`: `"<n>.<e>"`, base64url, for PaneSetup's config.
  - `releaseKeys({ env = process.env } = {}) -> string[]`: `env.PANE_RELEASE_KEYS` (JSON array) if set, else `package.json` `pane.releaseKeys`, passed through `checkReleaseKeys`. **Build time only.**
- Produces, in `packRuntime({ out, signingKey })`: writes `<archive>.sig` next to `<archive>` and `<archive>.sha256`. Returns `{ dir, archive, sha256, signature }`. Throws `"Pane's release signing key is missing. Set PANE_RELEASE_SIGNING_KEY or pass --key <file>."` when there is no key.

- [ ] **Step 1: Write the failing tests** in `test/unit/signing.test.js`:
  - `test('release signatures: sign, verify, reject')`:
    - generate two keys and sign `Buffer.from('runtime')` with key A
    - assert `verifyRelease(data, sig, [A.publicPem])` is true, and so is `[B.publicPem, A.publicPem]`
    - assert `[B.publicPem]` is false, a changed byte in data is false, and a truncated sig is false
    - assert `sig.length === 384`
  - `test('release keys: only RSA of 3072 bits or more')`:
    - `checkReleaseKeys` throws `/RSA/` for an Ed25519 public PEM and `/3072/` for an RSA 2048 PEM
    - it throws for a non-array
    - `releaseKeys({ env: { PANE_RELEASE_KEYS: JSON.stringify([A.publicPem]) } })` deep-equals `[A.publicPem]`
  - `test('jwkParts matches the key')`: split on `.`, decode base64url, and rebuild with `crypto.createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' })`. Its SPKI export equals A's.
- [ ] **Step 2: Run** `node --test test/unit/signing.test.js`. Expected: FAIL, `Cannot find module '../../src/core/release-signature'`.
- [ ] **Step 3: Implement** `src/core/release-signature.js` with the interfaces above. Use `crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })` and `crypto.sign/verify('sha256', …)` with the default PKCS#1 v1.5 padding.
- [ ] **Step 4: Implement signing in `packRuntime`.**
  - Read the key from `signingKey`, then `process.env.PANE_RELEASE_SIGNING_KEY` (PEM text), then fail with the message above.
  - `pack-runtime --key <file>` reads the file.
  - Add `pane keygen --release <file>`:
    - refuses to overwrite an existing file
    - writes the private PEM with mode `0600`
    - prints the public PEM, plus: `Add this public key to "pane.releaseKeys" in package.json. Store the private key as the GitHub secret PANE_RELEASE_SIGNING_KEY, then delete this file.`
- [ ] **Step 5: Add a test** to `test/unit/signing.test.js`, `test('pack-runtime writes a signature that verifies')`. It runs `packRuntime({ out: tmp, signingKey: A.privatePem })`. Assert `verifyRelease(readFileSync(archive), readFileSync(archive + '.sig'), [A.publicPem])` is true, and `packRuntime({ out: tmp })` with `PANE_RELEASE_SIGNING_KEY` unset throws `/release signing key is missing/`. (This test stages the runtime and takes a few seconds. Skip it on win32, like the existing build test.)
- [ ] **Step 6: Run** `npm test`. Expected: all pass, including `architecture.test.js`.
- [ ] **Step 7: Commit** `git commit -m "Phase 4, part 1a: signed runtime archives (pack-runtime, keygen --release)"`

### Task 2: `install.sh` and the macOS installer verify the signature

**Files:**
- Modify: `src/packaging/installers/install-sh.js` (`unixInstaller` gains `releaseKeys: string[]`), `src/packaging/build.js` (pass `releaseKeys()`, warn when empty), `src/packaging/installers/dmg.js` (passes through)
- Modify: `test/e2e/installers.js`, `test/unit/core.test.js` (the existing `pane build writes installers…` test)

**Interfaces:**
- Consumes: `releaseKeys()` and `generateReleaseKey()` (Task 1); `packRuntime` signing via `PANE_RELEASE_SIGNING_KEY`.
- Produces: `unixInstaller({ name, pkgName, paneVersion, dist, releaseKeys, gui, packageExpr })`. The script embeds each PEM in a quoted heredoc, written to `$TMP/key-<n>.pem`.

- [ ] **Step 1: Write the failing assertions.**
  - In `test/unit/core.test.js`'s build test: build with `PANE_RELEASE_KEYS` set to a test key. Assert `install.sh` contains `-----BEGIN PUBLIC KEY-----` and `openssl dgst -sha256 -verify`, and contains no `PANE_RELEASE_KEYS`, so the environment cannot add keys at install time.
  - In `test/e2e/installers.js`:
    - generate a release key and pack with `PANE_RELEASE_SIGNING_KEY`; build with `PANE_RELEASE_KEYS`
    - **before** the good install, serve a second dist folder whose archive has one byte flipped
    - run the installer against it with `PANE_DIST_URL` pointing there
    - assert it exits non-zero, output matches `/signature/i`, and `home/bin/pane` does not exist
    - repeat with the `.sig` file deleted; assert output matches `/signature/i`
- [ ] **Step 2: Run** `npm test` and `npm run test:installers` (macOS). Expected: FAIL. No signature check exists yet.
- [ ] **Step 3: Implement `install_pane` in the script.**
  - After the download, fetch `$URL.sig` (failure: `fail "Could not download Pane's signature from $URL.sig. Nothing was installed."`).
  - Require `command -v openssl` (else `fail "Checking Pane's download needs openssl, which this computer lacks."`).
  - Try each embedded key with `openssl dgst -sha256 -verify "$KEY" -signature "$TMP/$FILE.sig" "$TMP/$FILE" >/dev/null 2>&1`.
  - If none verifies: `fail "The Pane download is not signed by Pane (signature check failed). Nothing was installed."`
  - With no embedded keys: `fail "$APP_NAME's installer has no key to check Pane's download, so it will not download Pane."`
  - Drop the `.sha256` comparison (the signature covers it).
  - In `build.js`, push a warning when `releaseKeys()` is empty: installers will refuse to download Pane.
- [ ] **Step 4: Run** `npm test` and `npm run test:installers`. Expected: PASS. The tampered and unsigned runs are refused; the good run installs, launches and uninstalls as before.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 1b: install.sh and the macOS installer check Pane's signature"`

### Task 3: `PaneSetup.exe` verifies the signature

**Files:**
- Modify: `installer/windows/PaneSetup.cs` (`InstallPane`), `src/packaging/installers/setup-exe.js` (config `releaseKeys`), `test/e2e/installers.js` (Windows branch)

**Interfaces:**
- Consumes: `jwkParts()` (Task 1). Config line `releaseKeys=<n>.<e>[,<n>.<e>…]`.
- Produces: `static bool VerifyRelease(byte[] sha256, byte[] signature, string keys)` in PaneSetup.cs, using `RSACryptoServiceProvider.ImportParameters(new RSAParameters { Modulus, Exponent })` and `VerifyHash(hash, CryptoConfig.MapNameToOID("SHA256"), sig)`.

- [ ] **Step 1: Write the failing e2e assertions.** These mirror Task 2, on Windows:
  - a tampered archive is refused with `/signature/i`, and `home\bin\pane.cmd` is absent
  - a missing `.sig` is refused
  - the good run passes
- [ ] **Step 2: Run** `npm run test:installers` on the Windows CI job (push the branch). Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Download `url + ".sig"` with `WebClient.DownloadData`. A 404 means: `"Could not download Pane's signature. Nothing was installed."`
  - Hash the archive with the existing `SHA256` stream code, then verify against each key.
  - On failure: `"The Pane download is not signed by Pane (signature check failed). Nothing was installed."`
  - With empty `releaseKeys`: `name + "'s installer has no key to check Pane's download, so it will not download Pane."`
  - Base64url decoding: replace `-`→`+`, `_`→`/`, then pad with `=`.
  - Remove the `.sha256` check.
- [ ] **Step 4: Run** the Windows installers job. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 1c: PaneSetup.exe checks Pane's signature"`

### Task 4: Release workflow and docs

**Files:**
- Modify: `.github/workflows/release.yml` (runtime job: `env: PANE_RELEASE_SIGNING_KEY: ${{ secrets.PANE_RELEASE_SIGNING_KEY }}`, and fail early with `Release signing key secret is not set` when empty), `README.md` (distribution section: archives come with `.sig`; how keys rotate: add the new public key, release, then remove the old one)

- [ ] **Step 1:** Edit the workflow and README as above. `gh release upload` already uploads `pane-dist/v*/*`, so the `.sig` goes along.
- [ ] **Step 2: Verify.**
  - `npx --yes @action-validator/cli .github/workflows/release.yml` (or `actionlint` if installed). Expected: no errors.
  - `grep -n PANE_RELEASE_SIGNING_KEY .github/workflows/release.yml`. Expected: one `env` line and one guard.
- [ ] **Step 3: Commit** `git commit -m "Phase 4, part 1d: release workflow signs runtime archives"`
- [ ] **Step 4: Owner action (not the implementer).** The repo owner runs `pane keygen --release <file>`, sets the secret with `gh secret set PANE_RELEASE_SIGNING_KEY < <file>`, commits the public key to `package.json`, and deletes the file. Until then, `pane build` warns and the release workflow stops at the guard.

# Part 2: App identity

### Task 5: App signatures in core, and the manifest's `publisher`

**Files:**
- Create: `src/core/app-signature.js`
- Modify: `src/core/manifest.js` (optional `publisher`: string, 1–100 characters, no control characters; frozen into the manifest; error `"publisher" must be text of 1–100 characters.`)
- Test: `test/unit/signing.test.js`, `test/unit/core.test.js` (manifest cases)

**Interfaces:**
- Produces, in `src/core/app-signature.js`:
  - `SIGNATURE_FILE = '.pane-signature.json'`
  - `generateAppKey() -> { privatePem, publicPem }`: Ed25519.
  - `fingerprint(publicKey: string | KeyObject) -> string`: the first 16 hex characters of `sha256(SPKI DER)`, in groups of 4 separated by spaces, e.g. `"3f9a 1c22 0b7e 91d4"`.
  - `hashTree(dir: string) -> Array<[string, string]>`, sorted by path:
    - paths use `/` separators and skip `SIGNATURE_FILE` at the root
    - a file maps to `sha256:<hex>`, a symlink to `link:<readlink target>`, an empty folder to `dir`
    - any other entry type throws
  - `signApp(dir, { id, version, publisher }, privatePem) -> object`: writes and returns `{ format: 1, publicKey: <base64 SPKI DER>, signed: <string>, signature: <base64> }`. Here `signed` is `JSON.stringify({ format: 1, id, version, publisher: publisher || null, files: hashTree(dir) })`.
  - `verifyApp(dir, { id, version }) -> null | { publicKey: string, fingerprint: string, publisher: string | null }`:
    - returns `null` when there is no signature file
    - throws `AppSignatureError` (exported) when the signature is bad, the `signed` id or version differs from the manifest, or the files differ (listing up to 5 changed, added or missing paths)

- [ ] **Step 1: Write the failing tests.**
  - `test('app signatures: sign, verify, detect changes')`:
    - in a temp dir with `pane.json`, `ui/index.html`, a symlink `node_modules/.bin/x -> ../x/cli.js` and an empty `data/`: sign with key A
    - tar it (`tar -czf`) and untar into another dir; `verifyApp` returns `{ fingerprint: fingerprint(A.publicPem), publisher: 'Acme' }`
    - each of these throws `/do not match/`: change one byte in `ui/index.html`, add `ui/extra.js`, delete `ui/index.html`
    - `verifyApp(dir, { id: 'other', version })` throws `/id/`
    - a signature made by key B over A's `signed` text throws `/signature/`
  - `test('fingerprint format')`: matches `/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/`, and is stable for the same key.
  - Manifest: `publisher: 'Acme'` is kept; `publisher: ''` and a 101-character string produce the error above.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both files per the interfaces. Use `crypto.sign(null, data, key)` for Ed25519.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 2a: app signatures and the publisher field"`

### Task 6: `pane keygen` for apps, and `pane build --key`

**Files:**
- Modify: `src/cli/commands/keygen.js` (no flag means an app key), `src/packaging/build.js` (sign the stage before `tar`), `src/cli/commands/build.js` (print `Signed by <publisher or "unnamed publisher"> (key <fingerprint>)` or the warning), `src/cli/index.js` (HELP lines)
- Test: `test/unit/core.test.js` (build test)

**Interfaces:**
- Consumes: `generateAppKey`, `signApp`, `fingerprint`, `verifyApp` (Task 5).
- Produces:
  - `buildInstaller(appDir, { out, key })` resolves the key from `key` (a file path), then `process.env.PANE_SIGNING_KEY` (PEM text).
  - It returns `{ …, publisher: { name, fingerprint } | null }`.
  - With no key, it warns: `This app is unsigned. Anyone can publish an app with the id "<id>" and replace it on users' computers. Create a key with "pane keygen <file>" and build with --key <file>.`
  - `pane keygen <file>` writes an Ed25519 PKCS#8 PEM with mode `0600`, refuses to overwrite, and prints the fingerprint plus: `Keep this file secret and backed up. Every update to your apps must be signed with it; without it, users cannot update them.`

- [ ] **Step 1: Write the failing test.** In the build test, build once with `{ key: <file with A.privatePem> }`. Untar the `.paneapp` into a temp dir. `verifyApp` returns A's fingerprint, and the result's `publisher.fingerprint` matches. Build again without a key: `warnings` matches `/unsigned/`, and the untarred app has no `.pane-signature.json`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces. Signing happens on `stage` after `npm ci` and before `tar`, so the signature covers production dependencies.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 2b: pane keygen and pane build --key"`

### Task 7: Install checks the publisher (first install wins)

**Files:**
- Create: `src/packaging/publishers.js`
- Modify:
  - `src/core/paths.js` (`publishersFile() -> PANE_HOME/publishers.json`)
  - `src/packaging/apps.js`:
    - `installApp` runs `verifyApp` on the unpacked source, then `checkPublisher`, before copying, then `recordPublisher` after success
    - `uninstallApp` with `purge` calls `forgetPublisher`
    - the record gains `publisher`
  - `src/cli/commands/install.js` (prints lines), `src/cli/commands/list.js` (shows publisher)
- Test: `test/unit/signing.test.js`, `test/e2e/installers.js`

**Interfaces:**
- Consumes: `verifyApp`, `AppSignatureError` (Task 5).
- Produces, in `src/packaging/publishers.js`:
  - `checkPublisher(id, signer: null | { publicKey, fingerprint, publisher }) -> void`. It throws `PublisherError` with `code = 'PUBLISHER_CHANGED'` when:
    - (a) a key is recorded and `signer` is null: `"<id> is installed from a signed publisher (key <fp>), and this copy is unsigned. Nothing was installed."`
    - (b) a key is recorded and differs: `"<id> is installed from a different publisher (key <fp>). This copy is signed with key <fp2>. Nothing was installed. To replace it and delete its data, run: pane uninstall <id> --purge"`
    - With no record, or a record of `null`, it accepts anything.
  - `recordPublisher(id, signer) -> void`. It records `{ publicKey, name, since }`, or `null` for unsigned. It never overwrites a recorded key; it may replace `null` with a key.
  - `forgetPublisher(id) -> void`
  - `publisherOf(id) -> record | undefined`
  - The file is written atomically (tmp + rename) with mode `0600`.
- `pane install` output adds:
  - `  publisher: <name or "unnamed"> (key <fp>)`, or `  publisher: unsigned`
  - `  permissions: <comma list or "none">`

- [ ] **Step 1: Write the failing tests.**
  - Unit `test('publishers: the first install decides, purge forgets')`, with `PANE_HOME` set to a temp dir:
    - unsigned then signed by A is accepted, and the record becomes A
    - after that, B throws `PUBLISHER_CHANGED` and unsigned throws
    - after `forgetPublisher`, B is accepted
  - E2e (macOS, cheap, fails before any launcher is created):
    - build `Field Notes` with key A and install; output contains `publisher:` and A's fingerprint
    - then `pane uninstall <id>` **without** `--purge`
    - build the same id with key B; `pane install` exits 1 with `/different publisher/`
    - `pane uninstall <id> --purge`, then the install with B succeeds
- [ ] **Step 2: Run** `npm test` and `npm run test:installers`. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces. `pane install` maps `PublisherError` and `AppSignatureError` to exit code 1 with the message. Installers already show `pane install`'s output on failure.
- [ ] **Step 4: Run** both. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 2c: an app id belongs to the key that first installed it"`

# Part 3: Fuses on macOS launchers

### Task 8: Fuse reader and in-place writer in core

**Files:**
- Create: `src/core/fuses.js`
- Modify: `package.json` (devDependency `@electron/fuses` `2.1.3`)
- Test: `test/unit/signing.test.js`

**Interfaces:**
- Produces:
  - `SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'`
  - `FUSE = Object.freeze({ RunAsNode: 0, EnableCookieEncryption: 1, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3, EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5, LoadBrowserProcessSpecificV8Snapshot: 6, GrantFileProtocolExtraPrivileges: 7 })`
  - `LAUNCHER_FUSES = { [FUSE.RunAsNode]: false, [FUSE.EnableNodeOptionsEnvironmentVariable]: false, [FUSE.EnableNodeCliInspectArguments]: false }`
  - `readFuses(file) -> Array<{ offset: number, wire: string }>`:
    - one entry per sentinel found (universal binaries have several)
    - `wire` is the ASCII fuse bytes
    - throws when there are none, or when the version byte is not `1`
  - `setFuses(file, changes: Record<number, boolean>) -> void`:
    - opens with `'r+'` and writes only the changed bytes with `fs.writeSync(fd, byte, 0, 1, position)`; never rewrites the file
    - throws when an index is beyond the wire length or the wire there is `'r'` (removed)
- Facts measured on Electron 45.2.3, arm64: the wire is in `Contents/Frameworks/Electron Framework.framework/Electron Framework`, version 1, length 9, value `101100011`.

- [ ] **Step 1: Write the failing tests.**
  - `test('fuse positions match @electron/fuses')`: for each key in `FUSE`, assert `FUSE[k] === require('@electron/fuses').FuseV1Options[k]`.
  - `test('fuses: read and flip in place')`:
    - copy the real framework binary to a temp file (`fs.copyFileSync`); `readFuses` returns one wire of length ≥ 8 with `wire[0] === '1'`
    - after `setFuses(tmp, LAUNCHER_FUSES)`, the wire has `'0'` at indices 0, 2 and 3, and the other bytes are unchanged
    - the file size is unchanged, and the bytes differ only at those offsets (compare buffers; count the differences = number of fuses that were `'1'`)
    - skip unless darwin
  - `test('fuses: synthetic buffers')`: a buffer with the sentinel, `0x01`, length 3 and `'1r0'`: setting index 1 throws `/removed/`, and a version byte `0x02` throws `/version/`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces. Read with `fs.readFileSync` to find offsets, then write single bytes.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 3a: read and set Electron fuses in place"`

### Task 9: macOS launchers get the fuses

**Files:**
- Modify: `src/packaging/launchers/macos.js` (`buildMacBundle`: `setFuses(<tmp>/Contents/Frameworks/Electron Framework.framework/Electron Framework, LAUNCHER_FUSES)` before `codesign`), `test/e2e/installers.js` (macOS checks)

**Interfaces:**
- Consumes: `setFuses`, `readFuses`, `LAUNCHER_FUSES`, `FUSE` (Task 8).

- [ ] **Step 1: Write the failing e2e assertions.** After the macOS install:
  - `readFuses(<launcher>/Contents/Frameworks/Electron Framework.framework/Electron Framework)[0].wire` has `'0'` at `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`
  - the installed runtime's own `Electron Framework` still has `'1'` at `RunAsNode`
  - `codesign --verify --deep --strict <launcher>` exits 0
  - the existing launch-and-call-backend check still passes
- [ ] **Step 2: Run** `npm run test:installers`. Expected: FAIL on the fuse assertion.
- [ ] **Step 3: Implement** the one call in `buildMacBundle`.
- [ ] **Step 4: Run** `npm run test:installers` and `npm run smoke`. Expected: PASS.
- [ ] **Step 5: Manual check (record in the PR).** Run `df -k /` before and after `pane install` of three apps into a sandbox `PANE_LAUNCHERS_DIR`. Expected: under 20 MB used in total, so the clone is still shared. Report the number.
- [ ] **Step 6: Commit** `git commit -m "Phase 4, part 3b: macOS launchers cannot run as Node or be debugged"`

# Part 4: `pane build --sign` with the developer's certificates

### Task 10: The installer payload survives an Authenticode signature

**Files:**
- Modify: `src/core/installer-payload.js` (`readPayload`), `installer/windows/PaneSetup.cs` (`ReadPayload`), `test/unit/installer-formats.test.js`

**Interfaces:**
- Produces: `payloadEnd(exe: Buffer) -> number`:
  - Parse the PE header: `e_lfanew` at `0x3C`, then `PE\0\0`, then the optional header after a 20-byte COFF header.
  - The data directory starts at optional header + 96 (PE32, magic `0x10b`) or + 112 (PE32+, `0x20b`); the security entry is index 4.
  - If the security entry's size is > 0, the end is its file offset; otherwise the end is `exe.length`.
  - Then step back over up to 7 trailing `0x00` bytes (signtool's alignment padding).
- `readPayload` uses `payloadEnd` instead of `exe.length`. `ReadPayload` in C# implements the same steps on the open `FileStream`.

- [ ] **Step 1: Write the failing test** `test('installer payload is found in front of a signature')`:
  - build a minimal PE32 stub (64-byte DOS header with `e_lfanew = 0x40`, `PE\0\0`, a 20-byte COFF header with `SizeOfOptionalHeader = 224`, a 224-byte optional header with magic `0x10b`), then `attachPayload`
  - append 5 zero bytes, then a fake 200-byte certificate table, and write the security entry (offset, 200)
  - `readPayload` returns the same config and paneapp
  - the unsigned case still passes, as in the existing test
- [ ] **Step 2: Run** `npm test`. Expected: FAIL with `No Pane installer payload`.
- [ ] **Step 3: Implement** `payloadEnd` in Node and the same steps in C#.
- [ ] **Step 4: Run** `npm test`, and the Windows installers CI job (which recompiles PaneSetup). Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 4a: PaneSetup finds its app in front of a signature"`

### Task 11: Windows signing (`signtool`)

**Files:**
- Create: `src/packaging/signing/windows.js`, `test/e2e/signing.js`
- Modify: `src/packaging/build.js` (`buildInstaller(appDir, { out, key, sign })`), `src/cli/commands/build.js`, `src/cli/index.js` (HELP: `--sign`), `package.json` (`"test:signing": "node test/e2e/signing.js"`)

**Interfaces:**
- Produces, in `src/packaging/signing/windows.js`:
  - `findSigntool() -> string | null`: the newest `C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\signtool.exe`, or `PANE_SIGNTOOL`.
  - `signWindows(file, env = process.env) -> void`:
    - runs `signtool sign /fd SHA256 /td SHA256 /tr <PANE_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com'>` with one source of the certificate:
      - `/f <PANE_SIGN_PFX> /p <PANE_SIGN_PFX_PASSWORD>`, or
      - `/sha1 <PANE_SIGN_CERT_SHA1>`, or
      - extra arguments from `PANE_SIGNTOOL_ARGS` (JSON array; for Azure Artifact Signing's `/dlib … /dmdf …`)
    - `PANE_SIGN_TIMESTAMP_URL=none` drops `/tr /td`, for offline tests
    - throws `"--sign needs a certificate: set PANE_SIGN_PFX (and PANE_SIGN_PFX_PASSWORD), PANE_SIGN_CERT_SHA1 or PANE_SIGNTOOL_ARGS."` when none is set
    - never echoes the password
- `buildInstaller` with `sign: true` on win32 calls `signWindows` on the written `Setup.exe` (after `attachPayload`). On other OSes it warns: `The Windows installer is not signed: signing it needs Windows (signtool).`

- [ ] **Step 1: Write the failing e2e test** `test/e2e/signing.js`, Windows branch:
  - create a self-signed code-signing certificate with PowerShell (`New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Pane Test" -CertStoreLocation Cert:\CurrentUser\My`)
  - export it to a temp PFX with a random password, then delete it from the store
  - `pane build --sign` a created app with `PANE_SIGN_PFX`, `PANE_SIGN_PFX_PASSWORD` and `PANE_SIGN_TIMESTAMP_URL=none`
  - assert `(Get-AuthenticodeSignature <exe>).Status` is neither `NotSigned` nor `HashMismatch`, and the signer subject is `CN=Pane Test`
  - assert `readPayload(<exe>).config.id` equals the app id
  - flip one byte inside the paneapp region of a copy: the status becomes `HashMismatch`, so the payload is covered by the signature
  - run the signed exe with `/quiet`, a sandbox `PANE_HOME` and the local dist (reuse `serveDir` and the Task 1 key): it exits 0 and the app is listed
- [ ] **Step 2: Run** `npm run test:signing` in the Windows CI job. Expected: FAIL. `--sign` is unknown.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 4b: pane build --sign on Windows"`

### Task 12: macOS signing and notarization

**Files:**
- Create: `src/packaging/signing/macos.js`
- Modify: `src/packaging/installers/dmg.js` (sign "Install <App>.app" before `hdiutil`, then sign the DMG, then notarize and staple), `test/e2e/signing.js` (macOS branch)

**Interfaces:**
- Produces, in `src/packaging/signing/macos.js`:
  - `signMac(target, env) -> void`: `codesign --force --timestamp --options runtime --sign <PANE_SIGN_IDENTITY> [--keychain <PANE_SIGN_KEYCHAIN>] <target>`. `PANE_SIGN_TIMESTAMP=none` replaces `--timestamp` with `--timestamp=none` for offline tests. It throws `"--sign needs PANE_SIGN_IDENTITY, e.g. \"Developer ID Application: Your Name (TEAMID)\"."` when unset.
  - `notarize(dmg, env) -> boolean`: when `PANE_NOTARY_PROFILE` is set, runs `xcrun notarytool submit <dmg> --keychain-profile <profile> --wait`, then `xcrun stapler staple <dmg>`, and returns true. Otherwise returns false, and `buildInstaller` warns: `The .dmg is signed but not notarized, so macOS will still block it. Set PANE_NOTARY_PROFILE (see "xcrun notarytool store-credentials") and build again.`
- Known risk, written into the PR: "Install <App>.app" runs a shell script as its main program. Apple's notary service may reject it or Gatekeeper may still warn. If the first real notarization fails, the fix is a tiny compiled launcher program (follow-up, not in this plan).

- [ ] **Step 1: Write the failing e2e test**, macOS branch of `test/e2e/signing.js`:
  - create a temp keychain (`security create-keychain -p <random> <tmp>/pane-test.keychain-db`, then `unlock-keychain`)
  - make a self-signed code-signing certificate with `openssl req -x509 -newkey rsa:2048 -subj "/CN=Pane Test" -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature"`
  - pack it with `openssl pkcs12 -export -legacy` and import it with `security import <p12> -k <keychain> -P <pw> -T /usr/bin/codesign`, then `security set-key-partition-list -S apple-tool:,apple: -k <random> <keychain>`
  - `pane build --sign` with `PANE_SIGN_IDENTITY="Pane Test"`, `PANE_SIGN_KEYCHAIN=<keychain>` and `PANE_SIGN_TIMESTAMP=none`
  - assert `codesign --verify --strict --deep` passes on the mounted DMG's "Install Field Notes.app" and on the DMG
  - assert `codesign -dv` shows `Authority=Pane Test` and `flags=0x10000(runtime)`
  - assert warnings match `/not notarized/`
  - delete the keychain at the end (`security delete-keychain`); the default keychain is never touched
- [ ] **Step 2: Run** `npm run test:signing` on macOS. Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces. Signing order inside `buildDmg`: the app bundle, then `hdiutil create`, then the DMG, then `notarize`.
- [ ] **Step 4: Run** `npm run test:signing` and `npm run test:installers` on macOS. Expected: PASS. The unsigned build path is unchanged.
- [ ] **Step 5: Commit** `git commit -m "Phase 4, part 4c: pane build --sign on macOS (codesign, notarytool)"`

### Task 13: CI and docs

**Files:**
- Modify: `.github/workflows/ci.yml` (installers job: add `- run: npm run test:signing`), `README.md` (sections: "Signing your app" — `pane keygen`, `--key`, `--sign`, and each `PANE_SIGN_*` variable; "What users see" — publisher lines, and why unsigned apps can be replaced), `types/` (no change)

- [ ] **Step 1:** Add the CI step and the README sections.
- [ ] **Step 2: Verify.** Push the branch and open the PR. Expected: all checks pass, and the six required ones in the `main` ruleset are unchanged. The new step runs inside the existing `Installers (…)` jobs, so no ruleset edit is needed.
- [ ] **Step 3: Commit** `git commit -m "Phase 4, part 4d: run signing tests in CI, document signing"`

---

## Not in this plan

- Getting a real Apple Developer ID or Windows certificate, and proving that notarization and SmartScreen reputation work. That needs the owner's accounts.
- Keychain prompts after a Pane update, caused by ad hoc launcher signatures. This needs its own design.
- Fuses on Windows and Linux. It would need a separate copy of Electron for apps.
- Showing the publisher inside installer windows or dialogs. It needs mockups first.
- Re-signing launchers that existed before Phase 4. They get the fuses on their next install; Phase 5 updates will rebuild them.
