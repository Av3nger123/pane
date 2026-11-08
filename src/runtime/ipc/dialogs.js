'use strict';
// pane.dialog: open, save, message (confirm is built on message).

const { dialog } = require('electron');
const { CHANNELS } = require('./channels');
const { normalizeDialog } = require('../../core/validate');

function wireDialogs({ handle, dev }) {
  const testAnswers = dev ? readTestAnswers() : null;
  handle(CHANNELS.DIALOG, async (win, kind, opts) => {
    const options = normalizeDialog(kind, opts);
    if (testAnswers && kind in testAnswers) {
      console.log(`[pane] test mode: answered the ${kind} dialog with ${JSON.stringify(testAnswers[kind])}`);
      return testAnswers[kind];
    }
    if (kind === 'open') {
      const r = await dialog.showOpenDialog(win, options);
      return r.canceled ? [] : r.filePaths;
    }
    if (kind === 'save') {
      const r = await dialog.showSaveDialog(win, options);
      return r.canceled || !r.filePath ? null : r.filePath;
    }
    return (await dialog.showMessageBox(win, options)).response;
  });
}

// For end-to-end tests, under `pane dev` only: PANE_TEST_DIALOGS answers
// dialogs instead of showing them, e.g.
//   PANE_TEST_DIALOGS='{"message":0,"save":"/tmp/out.md","open":["/tmp/in.md"]}'
function readTestAnswers() {
  const raw = process.env.PANE_TEST_DIALOGS;
  if (!raw) return null;
  try {
    const answers = JSON.parse(raw);
    return answers && typeof answers === 'object' ? answers : null;
  } catch {
    console.error('[pane] PANE_TEST_DIALOGS is not valid JSON; showing real dialogs');
    return null;
  }
}

module.exports = { wireDialogs };
