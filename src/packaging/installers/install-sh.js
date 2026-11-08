'use strict';
// install.sh (terminal installs on macOS and Linux) and the program inside the
// macOS "Install <App>.app". Installs Pane first when needed, then the app.

const fs = require('fs');
const path = require('path');
const { EXIT_NEEDS_NEWER_PANE } = require('../apps');

// The install script. `gui` makes it report through notifications and dialogs
// (the macOS "Install <App>" app) instead of only the terminal; `packageExpr`
// is where the .paneapp sits relative to the script.
// releaseKeys: Pane's public keys (PEM). A downloaded Pane must carry a
// signature from one of them; they are fixed here, when the app is built.
function unixInstaller({ name, pkgName, paneVersion, dist, releaseKeys = [], gui = false, packageExpr = '"$HERE/"' }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const writeKeys = releaseKeys.map((pem, i) => `  cat > "$TMP/key-${i}.pem" <<'PANE_KEY'\n${pem.trim()}\nPANE_KEY`).join('\n');
  return `#!/bin/sh
# Installs ${name}.
# If this computer does not have Pane ${paneVersion} or newer, downloads it first.
HERE=$(cd "$(dirname "$0")" && pwd)
APP_NAME=${q(name)}
PACKAGE=${packageExpr}${q(pkgName)}
PANE_VERSION=${q(paneVersion)}
DIST_URL="\${PANE_DIST_URL:-${dist.replace(/[\\"`$]/g, '\\$&')}}"
GUI=${gui ? '"${PANE_INSTALLER_GUI:-1}"' : '0'}
OPEN=--open
[ "\${PANE_INSTALLER_OPEN:-1}" = 0 ] && OPEN=

say() {
  echo "$1"
  if [ "$GUI" = 1 ]; then
    osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' "$1" "Install $APP_NAME" >/dev/null 2>&1 || true
  fi
}
fail() {
  echo "$1" >&2
  if [ "$GUI" = 1 ]; then
    osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1 with icon stop' -e 'end run' "$1" "Install $APP_NAME" >/dev/null 2>&1 || true
  fi
  exit 1
}

case "$(uname -s)" in
  Darwin) OS=darwin; DEFAULT_HOME="$HOME/Library/Application Support/Pane" ;;
  Linux) OS=linux; DEFAULT_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}/pane" ;;
  *) fail "This installer supports macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
PANE_HOME="\${PANE_HOME:-$DEFAULT_HOME}"
export PANE_HOME
PANE="$PANE_HOME/bin/pane"

install_pane() {
  [ -n "$DIST_URL" ] || fail "$APP_NAME needs Pane $PANE_VERSION, and this installer does not know where to download it."${releaseKeys.length ? '' : `
  fail "$APP_NAME's installer has no key to check Pane's download, so it will not download Pane."`}
  FILE="pane-runtime-$PANE_VERSION-$OS-$ARCH.tar.gz"
  URL="$DIST_URL/v$PANE_VERSION/$FILE"
  TMP=$(mktemp -d) || fail "Could not create a temporary folder."
  say "Downloading Pane $PANE_VERSION, which $APP_NAME runs on…"
  curl -fL --progress-bar "$URL" -o "$TMP/$FILE" || { rm -rf "$TMP"; fail "Could not download Pane from $URL"; }
  curl -fsSL "$URL.sig" -o "$TMP/$FILE.sig" || { rm -rf "$TMP"; fail "Could not download Pane's signature from $URL.sig. Nothing was installed."; }
  command -v openssl >/dev/null 2>&1 || { rm -rf "$TMP"; fail "Checking Pane's download needs openssl, which this computer lacks. Nothing was installed."; }
${writeKeys}
  VERIFIED=0
  for KEY in "$TMP"/key-*.pem; do
    [ -f "$KEY" ] || continue
    if openssl dgst -sha256 -verify "$KEY" -signature "$TMP/$FILE.sig" "$TMP/$FILE" >/dev/null 2>&1; then VERIFIED=1; break; fi
  done
  if [ "$VERIFIED" != 1 ]; then
    rm -rf "$TMP"
    fail "The Pane download is not signed by Pane (signature check failed). Nothing was installed."
  fi
  say "Installing Pane $PANE_VERSION…"
  mkdir "$TMP/runtime" && tar -xzf "$TMP/$FILE" -C "$TMP/runtime" || { rm -rf "$TMP"; fail "Could not unpack Pane."; }
  if [ "$OS" = darwin ]; then
    ELECTRON="$TMP/runtime/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  else
    ELECTRON="$TMP/runtime/node_modules/electron/dist/electron"
  fi
  SETUP_OUTPUT=$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$TMP/runtime/bin/pane.js" setup --expect "$PANE_VERSION" 2>&1) || { rm -rf "$TMP"; fail "Could not install Pane. $SETUP_OUTPUT"; }
  echo "$SETUP_OUTPUT"
  rm -rf "$TMP"
}

if [ -x "$PANE" ]; then
  echo "Pane is already installed."
else
  install_pane
fi

say "Installing $APP_NAME…"
STATUS=0
OUTPUT=$("$PANE" install "$PACKAGE" $OPEN 2>&1) || STATUS=$?
echo "$OUTPUT"
if [ "$STATUS" -eq ${EXIT_NEEDS_NEWER_PANE} ]; then
  say "$APP_NAME needs a newer Pane."
  install_pane
  STATUS=0
  OUTPUT=$("$PANE" install "$PACKAGE" $OPEN 2>&1) || STATUS=$?
  echo "$OUTPUT"
fi
[ "$STATUS" -eq 0 ] || fail "$APP_NAME could not be installed. $OUTPUT"
`;
}

function writeInstallScript({ outDir, opts }) {
  const sh = path.join(outDir, 'install.sh');
  fs.writeFileSync(sh, unixInstaller(opts));
  fs.chmodSync(sh, 0o755);
  return sh;
}

module.exports = { unixInstaller, writeInstallScript };
