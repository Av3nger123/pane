'use strict';
// Small helpers shared by the CLI commands.

const fs = require('fs');

class UsageError extends Error {}

function size(file) {
  const bytes = fs.statSync(file).size;
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

module.exports = { UsageError, size };
