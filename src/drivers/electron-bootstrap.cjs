// Electron's -r modules execute synchronously before loading the application's main entry point. The command-line
// switch alone does not establish app.getPath('userData'); override both app files and Chromium session storage.
const { app } = require('electron');
const { realpathSync } = require('node:fs');
const path = require('node:path');

const profile = process.env.PROTOFLOW_ELECTRON_USER_DATA;
if (!profile || !path.isAbsolute(profile)) throw new Error('ProtoFlow requires an absolute private Electron profile');
const directory = realpathSync(profile);
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.commandLine.appendSwitch('user-data-dir', directory);
