'use strict';
/**
 * Entry point of the standalone ARQBeam.exe (see build-exe.js). Runs server.js unchanged.
 *
 * A double-clicked exe owns its console window, which closes the instant the process exits, so
 * a startup error would flash past unread. Like start.bat's `pause`, keep the window open on a
 * failure until Enter is pressed.
 */
const realExit = process.exit;
let closing = false;

process.exit = function exit(code = process.exitCode) {
  if (!code || !process.stdin.isTTY) return realExit.call(process, code);
  if (closing) return;
  closing = true;
  console.error('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => realExit.call(process, code));
};

const crash = (err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

require('../server.js');
