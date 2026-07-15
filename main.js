const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { startJob, startStream, cancelJob, pauseJob, resumeJob, getMetrics, startPowerMetrics, releaseRam } = require('./lib/process');

// Allow the in-app <video> player to autoplay with sound (no user gesture needed
// after the user clicked "Preview").
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 760,
    minHeight: 640,
    title: 'Frame Interpoler',
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();

  // Live resource monitoring runs for the whole app session (not just during a
  // job) so the CPU/GPU/Media Engine graphs stay live even when idle.
  startPowerMetrics();
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('metrics-event', getMetrics());
    }
  }, 1000);

  ipcMain.handle('select-input', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'ts'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('select-inputs', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'ts'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('select-output', async (_e, defaultPath) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultPath || 'output_60fps.mp4',
      filters: [{ name: 'MP4 (H.264)', extensions: ['mp4'] }],
    });
    return res.canceled ? null : res.filePath;
  });

  ipcMain.on('start-job', (_e, opts) => {
    startJob(opts, (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('job-event', evt);
      }
    });
  });

  // Real-time streaming mode: each finished segment is pushed to the renderer as
  // a 'segment' event so it can start playing almost immediately.
  ipcMain.on('start-stream', (_e, opts) => {
    startStream(opts, (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-event', evt);
      }
    });
  });

  ipcMain.on('stream-cleanup', (_e, dir) => {
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  // Return a finished segment's bytes for gapless MediaSource playback.
  ipcMain.handle('read-segment', async (_e, segPath) => {
    try {
      const buf = await fs.promises.readFile(segPath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
      return null;
    }
  });

  ipcMain.on('cancel-job', () => cancelJob());
  ipcMain.on('pause-job', () => pauseJob());
  ipcMain.on('resume-job', () => resumeJob());

  // Cache sudo credentials (one time) so live GPU % via powermetrics works
  // without the user manually running `sudo` in Terminal. The password is used
  // only to cache creds and is never stored.
  ipcMain.handle('enable-gpu', async (_e, password) => {
    try {
      execFileSync('sudo', ['-S', '-v'], { input: password + '\n', stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (e) { /* wrong password or sudo unavailable — fall back to estimate */ }
    startPowerMetrics();
    return true;
  });

  // ---- save a streamed/played video to a permanent file ----
  ipcMain.handle('preview-save', async (_e, { src, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || 'output_60fps.mp4',
      filters: [{ name: 'MP4 (H.264)', extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return null;
    try {
      fs.copyFileSync(src, res.filePath);
      return res.filePath;
    } catch (err) {
      return { error: err.message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  releaseRam(); // detach the RAM disk we mounted for intermediate frames
});
