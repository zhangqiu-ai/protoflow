// Engine-provided Electron window that shows one frozen prototype page, so an Electron target's prototype reference
// is rendered by the same Electron/Chromium build as the application it is compared with.
const { app, BrowserWindow, session } = require('electron');

let quitting = false;
app.whenReady().then(() => {
  if (quitting) return;
  const window = new BrowserWindow({
    width: Number(process.env.PROTOFLOW_VIEWER_WIDTH), height: Number(process.env.PROTOFLOW_VIEWER_HEIGHT), useContentSize: true,
    // macOS otherwise clamps windows to the screen's work area, which would shrink the requested viewport.
    enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  window.loadURL(process.env.PROTOFLOW_VIEWER_URL);
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
