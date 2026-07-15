const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectInput: () => ipcRenderer.invoke('select-input'),
  selectInputs: () => ipcRenderer.invoke('select-inputs'),
  selectOutput: (def) => ipcRenderer.invoke('select-output', def),
  startJob: (opts) => ipcRenderer.send('start-job', opts),
  startStream: (opts) => ipcRenderer.send('start-stream', opts),
  cancelJob: () => ipcRenderer.send('cancel-job'),
  // Remove a realtime stream's temp directory (called when the player closes).
  streamCleanup: (dir) => ipcRenderer.send('stream-cleanup', dir),
  // Electron strips File.path under contextIsolation, so expose the safe API.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onJobEvent: (cb) => ipcRenderer.on('job-event', (_e, evt) => cb(evt)),
  onMetrics: (cb) => ipcRenderer.on('metrics-event', (_e, evt) => cb(evt)),
  pauseJob: () => ipcRenderer.send('pause-job'),
  resumeJob: () => ipcRenderer.send('resume-job'),
  enableGpu: (password) => ipcRenderer.invoke('enable-gpu', password),
  // In-app player — save a streamed/played video to a permanent file
  previewSave: (src, defaultName) => ipcRenderer.invoke('preview-save', { src, defaultName }),
  // Real-time streaming player events
  onStreamEvent: (cb) => ipcRenderer.on('stream-event', (_e, evt) => cb(evt)),
  // Read a finished segment's bytes so the renderer can append it to a
  // MediaSource buffer for gapless real-time playback.
  readSegment: (path) => ipcRenderer.invoke('read-segment', path),
});
