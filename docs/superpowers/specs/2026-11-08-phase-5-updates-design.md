# Phase 5: Updates — Design

Status: draft for review, 2026-11-08.

## Why

Today nothing updates once it is installed:
- Every app keeps the Chromium it was installed with forever, so it never gets browser security fixes.
- An app's developer has no way to ship version 1.1 to people who installed 1.0.

Pane's promise is "install once, every app shares one up-to-date runtime". Without updates, "up to date" is false.

## What the owner decided

1. **Pane updates are invisible.**
   - Users never see a window, a notification or the word "Pane" because Pane updated.
   - Pane updates itself quietly, behind the apps.
2. **App updates belong to the app.**
   - The app's developer decides whether an update installs silently, asks the user, or offers the user a setting.
   - Pane provides the plumbing and **draws no update screens of its own**.
3. **Apps can get updates from anywhere.**
   - Developers are not tied to GitHub.
   - There is a simple way (an address in `pane.json`) and a flexible way (the app hands Pane a downloaded file).
4. **Updates must come from the app's own developer** (a security rule).
   - Pane installs an app update only if it is signed by the key that first installed the app (Phase 4's rule, applied to updates).
5. **No money is needed.** Everything works with the free keys from Phase 4.
6. **Older apps move to the new Pane.**
   - Pane promises to keep apps working across its updates, the way a browser keeps old websites working, so every app gets the latest Chromium security fixes.
   - An app can opt out by naming an exact Pane version in `pane.json`. It then stays on that Pane, without updates.
7. **The certificate check waits for a real certificate.**
   - Checking that app updates carry the same Apple or Microsoft certificate identity (as Electron's updaters do) is deferred, probably to Phase 6, when the owner ships an app with a real certificate.
   - The check only means something if the certificate is confirmed to come from Apple or Microsoft, and that can't be tested with throwaway certificates.
   - Phase 5 relies on the free key check, which already blocks hijacked updates.

## Goals

- **Pane stays current on every computer that runs Pane apps,** with no user action:
  - Pane checks for its own updates when any Pane app opens, at most once a day. Pane has no background service.
  - It downloads the new version from Pane's distribution (GitHub Releases), checks its signature and version (Phase 4), and installs it next to the current one.
- **No interruption.**
  - An app that is running keeps its current Pane until it is next opened, then starts on the new one.
  - A user never loses work or sees an app close because Pane updated.
- **Launchers follow Pane.** Each app's launcher (macOS `.app`, Windows Start menu shortcut and registry entries, Linux `.desktop`) is moved onto the new Pane. Launchers from before Phase 4 get the Phase 4 fuses this way.
- **No new permission prompts.**
  - After a Pane update, macOS must not ask the user again to allow an app to use its saved secrets (`pane.secrets`, stored with Electron's `safeStorage` in the keychain).
  - Today a rebuilt launcher gets a new ad hoc signature, which can trigger that prompt. Fixing this is part of the phase.
- **Every app moves to the newest Pane,** under Pane's compatibility promise (decision 6):
  - Pane fetches only its newest release; there are no patch lines for older versions.
  - An app whose `pane.json` excludes the newest Pane, because it opted out with an exact version, stays on the newest installed Pane it allows, without updates.
  - Templates keep `"pane": ">=0.1.0"`, so new apps follow Pane by default.
  - The README states the promise for developers.
- **Old Pane versions are cleaned up** once no installed app uses them and no app is running on them. Disk use does not grow without bound.
- **App updates, the simple way.**
  - `pane.json` may name an update address (https; `localhost` allowed for tests). It returns a small JSON file describing the latest version and where to download its `.paneapp`.
  - The app asks Pane to check it, download, and install on the next restart.
- **App updates, the flexible way.**
  - The app obtains a `.paneapp` however it wants: its own server, an authenticated API, a file the user picked.
  - It hands Pane the file to install.
- **Same rules either way.** Pane checks:
  - the update is for the same app id
  - its signature matches the key recorded for that id
  - it needs a Pane version that is installed or can be downloaded (Pane fetches that first, quietly)
- **An API in pages and backends,** something like:
  - `pane.updates.check()` resolves to `{ available, version, notes }`
  - `.download()`, with progress events
  - `.installFile(path)` for the flexible way
  - `.restartToUpdate()`
  - an event when a downloaded update is ready

  The builder settles the exact names. The backend gets the same calls through the `pane` module.
- **The developer's command line.** `pane build` writes the update file next to the `.paneapp`, ready to upload. It is filled in from `pane.json`, and the download address is left for the developer to fill in or set with a flag.
- **The Notes example shows how an app does it,** with its own "Update available" UI. That UI is designed with mockups first and built only after the owner approves them.

## Non-goals

- **Pane-drawn update UI.** No dialogs, banners, notifications or settings pages from Pane.
- **Updating apps installed without a key in a "safe" way.** Unsigned apps can still update, but get no protection, as in Phase 4.
- **Using Electron's built-in updater (Squirrel) or electron-updater.**
  - They replace a whole signed `.app` or `.exe`, Electron included.
  - Pane apps have no developer-built app bundle: launchers are made on the user's computer from the shared Pane.
  - An update replaces only the app's own files.
- **Delta or partial updates.** A full `.paneapp` each time is fine; apps are small.
- **Automatic rollback of a bad app version.** An app can ship a fix as the next version.
- **Rollback of a bad Pane version.**
  - Not automatic in this phase.
  - The previous Pane stays installed until every app has started successfully on the new one, so recovery stays possible by hand.
- **Settings for IT departments,** such as turning Pane updates off for a whole computer.
- **Certificate checks on app updates** (decision 7). Deferred to when a real certificate exists.
- **Security fixes for older Pane versions.** Apps that opt out of updates stay on their Pane as it is.
- **Linux app-update UI testing beyond what CI covers.** Linux launchers are still untested by hand.

## Anti-goals (failure even if it "works")

- A user sees anything that says Pane updated, or is asked anything because of it.
- A running app closes, reloads or loses state because Pane updated.
- macOS asks for keychain access again after a Pane update.
- Someone who controls an app's update address (a hacked website or GitHub account, an expired domain) can push code to that app's users.
- A Pane update breaks an app whose declared Pane range doesn't include the new version.
- Every app downloads its own copy of the new Pane (the whole point of Pane is one shared copy).

## Constraints

- These Phase 4 pieces are reused, not reimplemented:
  - release signature and version check
  - app signatures and key ownership (`publishers.json`)
  - in-place launcher signing, fuses and `macho-signature.js`
- **Layering:**
  - `src/core` has no Electron.
  - The runtime never loads the CLI or packaging.
  - If the update work running inside an app needs packaging code (installing a runtime, rebuilding launchers), it starts the `pane` command as a separate process. Doing that is the builder's call, but the architecture test must keep passing.
- **Platforms:** macOS and Windows tested end to end in CI. Linux implemented, with unit and CI coverage only.
- **Tests:**
  - Use a sandboxed `PANE_HOME` / `PANE_LAUNCHERS_DIR` and a local stand-in for the distribution and for app update addresses.
  - Never touch the user's real keychain contents or certificate stores. The Phase 4 rule about temporary keychains applies.
- **Process:** commits without co-author trailers; `main` changes only through a PR; no tags or releases.

## Decided by me, open to the owner's correction

- Pane checks for its own update when an app opens, at most once a day per computer, not per app.
- The update file for apps is JSON. My guess at the fields:
  - `version`
  - `url` of the `.paneapp`
  - optional `notes`
  - optional `pane` (the Pane range it needs)
  - optional `sha256`

  The builder finalizes them.
- Downloaded app updates install when the app next restarts, never under a running app. `restartToUpdate()` lets an app do that immediately.

## Settled after the builder check (my calls, open to correction)

- **Only signed apps can update themselves.**
  - `pane.updates` refuses to work for an app installed without a key, both the simple and the flexible way, and says why.
  - Otherwise anyone who controls an unsigned app's update address could push code, which is an anti-goal.
  - An update must be signed with the key already recorded for the app. The unsigned-to-signed switch Phase 4 allows for a manual `pane install` is not allowed through `pane.updates`.
  - Unsigned apps can still be reinstalled by hand, as today.
- **No migration from older Panes.**
  - Pane has never been released, so the first Pane with updates is a clean start.
  - Installs made before it (developer machines only) are reinstalled by hand.
  - No one-time keychain prompt needs an exception.
- **The keychain test runs only on CI's throwaway Macs.**
  - `safeStorage` always uses the user's default keychain, so the "no prompt after a Pane update" test needs a temporary default keychain.
  - It runs only when `CI` is set and never changes a developer's own keychain setup.
- **Finding the newest Pane.**
  - The distribution gains a small "latest version" file next to the release folders, published by the release workflow.
  - A tampered latest-version file can at worst delay an update, never install anything: every download is still checked for Pane's signature and version (Phase 4).
  - The builder may sign it, or keep a tampered one harmless another way.

## Left to the builder

- **How launchers move onto a new Pane without interrupting running apps.** For example:
  - rebuild the launchers of apps that aren't running right away
  - rebuild a running app's launcher when it quits, or on its next start with one invisible relaunch
- **How to keep macOS from asking for keychain access again after a launcher is rebuilt.**
  - Today's ad hoc signature changes on every rebuild, so the keychain's access list no longer matches.
  - Candidates:
    - a stable signing identity per computer, created once and kept out of the login keychain if possible
    - a stable designated requirement
    - moving the key `safeStorage` uses
  - The solution must not weaken Phase 4's fuses, and must not need the user's password.
- How Pane remembers when it last checked, and how it avoids two apps checking or installing at the same moment.
- The exact API names, events and error messages, in plain language.
- How old Pane versions are found to be unused and removed safely.

## Done when

- **Pane updates on macOS and Windows,** in an end-to-end test against a local distribution:
  - a computer with Pane N and an installed app opens the app
  - Pane N+1 installs quietly
  - the running app keeps working
  - after a restart it runs on N+1 with a working backend
  - no new window or prompt appeared
  - Pane N is removed once unused
- **Wrong updates are refused** in the same test: a newer Pane that the app's range excludes, a newer Pane with a bad signature, and an app update signed by another key.
- **App updates work both ways in the test:**
  - the simple way: check, download, restart, running the new version
  - the flexible way: `installFile`
- **Opting out:** an app pinned to an exact Pane version stays on it while the other apps move on.
- **No keychain prompt:** on macOS, a secret saved with `pane.secrets` before a Pane update can still be read after it, with no prompt. The test fails if `safeStorage` would need user approval.
- **Documentation:** the README explains updates for developers, the Notes example shows its own update UI (after mockup approval), and CI is green.
