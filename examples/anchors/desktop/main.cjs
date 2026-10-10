// Electron main process: one window that loads the renderer's hash-routed screens.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

let quitting = false;
app.whenReady().then(() => {
  if (quitting) return;
  // enableLargerThanScreen: macOS otherwise clamps the window (and the viewport ProtoFlow measures) to the screen.
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, enableLargerThanScreen: true, webPreferences: { contextIsolation: true, sandbox: true } });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'), { hash: '/tasks' });
});
app.on('window-all-closed', () => app.quit());

// Finish asynchronous session cleanup while the main loop is still running, then use Electron's normal quit path.
let quitReady = false;
let closingConnections = false;
app.on('before-quit', event => {
  quitting = true;
  if (quitReady || !app.isReady()) return;
  event.preventDefault();
  if (closingConnections) return;
  closingConnections = true;
  session.defaultSession.closeAllConnections().then(() => {
    quitReady = true;
    app.quit();
  }).catch(error => {
    // Keep the application open if cleanup fails, so a failed shutdown cannot masquerade as a clean exit.
    closingConnections = false;
    console.error('Could not finish session cleanup:', error);
  });
});
