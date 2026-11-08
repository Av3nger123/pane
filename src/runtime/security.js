'use strict';
// What app pages may do beyond the Pane bridge: stay on the app's own origin,
// open web links in the user's browser, and use only the permissions pane.json
// asks for.

const { shell } = require('electron');

const isExternalUrl = (url) => typeof url === 'string' && /^(https?:|mailto:)/i.test(url);

// Pages stay on the app's own origin. Web links open in the user's browser.
function lockDownContents(contents, isAppUrl) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url);
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

// Only what pane.json asks for. macOS then asks the user for camera and
// microphone in the app's own name.
function applyPermissions(ses, manifest, isAppUrl) {
  const allowed = new Set(manifest.permissions);
  const decide = (permission, details = {}) => {
    switch (permission) {
      case 'fullscreen':
      case 'clipboard-sanitized-write':
        return true;
      case 'notifications':
        return allowed.has('notifications');
      case 'clipboard-read':
        return allowed.has('clipboard');
      case 'geolocation':
        return allowed.has('geolocation');
      case 'media': {
        const types = details.mediaTypes || [];
        if (!types.length) return allowed.has('camera') || allowed.has('microphone');
        return types.every((t) => (t === 'video' ? allowed.has('camera') : t === 'audio' ? allowed.has('microphone') : false));
      }
      default:
        return false;
    }
  };
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isAppUrl(details.requestingUrl) && decide(permission, details));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const from = requestingOrigin || (details && details.requestingUrl);
    return isAppUrl(from) && decide(permission, details || {});
  });
}

module.exports = { isExternalUrl, lockDownContents, applyPermissions };
