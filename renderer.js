(function () {
  'use strict';

  const bridge = window.api;

  const $ = (id) => document.getElementById(id);
  const drop = $('drop');
  const queueEl = $('queue');
  const queueCount = $('queueCount');
  const convertBtn = $('convert');
  const cancelBtn = $('cancel');
  const pauseBtn = $('pause');
  const liveGpuBtn = $('liveGpu');
  const clearBtn = $('clear');
  const progressWrap = $('progressWrap');
  const fill = $('fill');
  const stageEl = $('stage');
  const etaEl = $('eta');
  const logEl = $('log');
  const fileLabel = $('fileLabel');
  const metricsHint = $('metricsHint');

  // player (in-app 60 FPS preview)
  const previewBtn = $('previewBtn');
  const playerEl = $('player');
  const playerVideo = $('playerVideo');
  const playerStage = $('playerStage');
  const playerLoading = $('playerLoading');
  const playerStatus = $('playerStatus');
  const playerBarFill = $('playerBarFill');
  const playerPct = $('playerPct');
  const playerPlay = $('playerPlay');
  const playerSeek = $('playerSeek');
  const playerTime = $('playerTime');
  const playerMute = $('playerMute');
  const playerFs = $('playerFs');
  const playerSave = $('playerSave');
  const playerWatch = $('playerWatch');
  const playerClose = $('playerClose');

  // ---- state ----
  let queue = [];          // { input, output, status, progress }
  let processing = false;
  let currentItem = null;
  let jobStart = 0;
  let metricsHintShown = false;
  let paused = false;
  let previewActive = false;
  let preview = null;      // { input, output, status, temp }
  // Real-time stream player state. Segments are appended into a single
  // MediaSource buffer for gapless playback (no per-segment re-load), with a
  // small cushion of pre-buffered segments so brief interpolation slowdowns
  // don't interrupt playback.
  let stream = null;

  // Codec string must match the fragmented-MP4 the encoder produces
  // (H.264 High @ level 4.0 -> avc1.640028).
  const STREAM_MIME = 'video/mp4; codecs="avc1.640028"';
  // How many finished segments to buffer before playback starts (each ~2s).
  const PREBUFFER_SEGMENTS = 3;

  function mseSupported() {
    return typeof window.MediaSource !== 'undefined'
      && window.MediaSource.isTypeSupported(STREAM_MIME);
  }

  // metrics history (percent 0..100)
  const HIST = 60;
  const hist = { cpu: [], gpu: [], media: [] };

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    logEl.textContent += `[${t}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function defaultOutput(p) {
    return p.replace(/\.[^.]+$/, '') + '_60fps.mp4';
  }

  function renderQueue() {
    queueEl.innerHTML = '';
    let done = 0;
    queue.forEach((item, i) => {
      if (item.status === 'done') done++;
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (i + 1) + '. ' + item.input.split('/').pop();
      const pmini = document.createElement('span');
      pmini.className = 'pmini';
      const ip = document.createElement('i');
      ip.style.width = (item.progress || 0) + '%';
      pmini.appendChild(ip);
      const badge = document.createElement('span');
      badge.className = 'badge ' + item.status;
      badge.textContent = item.status;
      const pbtn = document.createElement('button');
      pbtn.className = 'pbtn';
      pbtn.textContent = '▶';
      pbtn.title = 'Preview / Play in app';
      pbtn.addEventListener('click', (e) => { e.stopPropagation(); playItem(item); });
      const rbtn = document.createElement('button');
      rbtn.className = 'rbtn';
      rbtn.textContent = '✕';
      rbtn.title = item.status === 'processing' ? 'Stop & remove' : 'Remove from queue';
      rbtn.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item); });
      li.appendChild(name);
      li.appendChild(pmini);
      li.appendChild(badge);
      li.appendChild(pbtn);
      li.appendChild(rbtn);
      queueEl.appendChild(li);
    });
    queueCount.textContent = queue.length ? `(${done}/${queue.length})` : '';
    fileLabel.textContent = queue.length ? `${queue.length} file${queue.length > 1 ? 's' : ''} queued` : '';
    const idle = !processing && queue.some((q) => q.status === 'queued');
    convertBtn.disabled = !idle || previewActive;
    previewBtn.disabled = processing || previewActive;
  }

  function overallPercent() {
    if (!queue.length) return 0;
    let sum = 0;
    queue.forEach((q) => {
      if (q.status === 'done') sum += 1;
      else if (q === currentItem) sum += (q.progress || 0) / 100;
    });
    return Math.round((sum / queue.length) * 100);
  }

  function updateProgress() {
    const p = overallPercent();
    fill.style.width = p + '%';
  }

  function enqueue(path) {
    if (queue.some((q) => q.input === path && (q.status === 'queued' || q.status === 'processing'))) return;
    queue.push({ input: path, output: defaultOutput(path), status: 'queued', progress: 0, framesDone: 0, totalFrames: 0 });
    renderQueue();
  }

  function removeItem(item) {
    if (item === currentItem) {
      // The item being removed is the one currently processing — stop it first.
      if (bridge.cancelJob) bridge.cancelJob();
    } else if (item.status === 'processing') {
      if (bridge.cancelJob) bridge.cancelJob();
    }
    queue = queue.filter((q) => q !== item);
    renderQueue();
    updateProgress();
  }

  function maybeStart() {
    if (processing) return;
    const item = queue.find((q) => q.status === 'queued');
    if (!item) return;
    startItem(item);
  }

  function startItem(item) {
    processing = true;
    currentItem = item;
    item.status = 'processing';
    item.progress = 0;
    jobStart = Date.now();
    paused = false;
    pauseBtn.textContent = 'Pause';
    renderQueue();
    cancelBtn.disabled = false;
    pauseBtn.disabled = false;
    const opts = {
      input: item.input,
      output: item.output,
      targetFps: parseInt($('targetFps').value, 10),
      model: $('model').value,
      gpu: $('gpu').value,
      ttaSpatial: $('ttaS').checked,
      ttaTemporal: $('ttaT').checked,
      uhd: $('uhd').checked,
      gpuEncode: $('gpuEncode').checked,
    };
    log('Starting: ' + item.input.split('/').pop());
    bridge.startJob(opts);
  }

  function finishItem(status) {
    if (currentItem) { currentItem.status = status; currentItem.progress = status === 'done' ? 100 : currentItem.progress; }
    processing = false;
    cancelBtn.disabled = true;
    pauseBtn.disabled = true;
    paused = false;
    pauseBtn.textContent = 'Pause';
    updateProgress();
    renderQueue();
    currentItem = null;
    maybeStart();
  }

  // ---- drag & drop (whole window accepts; children of #drop ignore pointer) ----
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('dragenter', prevent);
  window.addEventListener('dragover', prevent);
  window.addEventListener('drop', async (e) => {
    prevent(e);
    drop.classList.remove('over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      for (let i = 0; i < files.length; i++) {
        let p = null;
        try { p = await bridge.getPathForFile(files[i]); } catch (err) { /* fall back below */ }
        if (!p && files[i].path) p = files[i].path;
        if (p) enqueue(p);
      }
    }
  });
  drop.addEventListener('dragenter', () => drop.classList.add('over'));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));

  // ---- file picking ----
  drop.addEventListener('click', async () => {
    const paths = await bridge.selectInputs();
    paths.forEach(enqueue);
  });
  $('chooseFiles').addEventListener('click', async () => {
    const paths = await bridge.selectInputs();
    paths.forEach(enqueue);
  });
  clearBtn.addEventListener('click', () => {
    if (processing) bridge.cancelJob();
    queue = [];
    currentItem = null;
    processing = false;
    paused = false;
    pauseBtn.textContent = 'Pause';
    pauseBtn.disabled = true;
    renderQueue();
    updateProgress();
    stageEl.textContent = 'Idle';
    etaEl.textContent = '';
  });

  convertBtn.addEventListener('click', () => maybeStart());
  cancelBtn.addEventListener('click', () => bridge.cancelJob());

  pauseBtn.addEventListener('click', () => {
    if (!processing) return;
    if (!paused) {
      bridge.pauseJob();
      paused = true;
      pauseBtn.textContent = 'Resume';
      stageEl.textContent = 'Paused';
    } else {
      bridge.resumeJob();
      paused = false;
      pauseBtn.textContent = 'Pause';
    }
  });

  liveGpuBtn.addEventListener('click', async () => {
    const pw = window.prompt('Enter your sudo password to enable live GPU % (used once to cache credentials, never stored):');
    if (!pw) return;
    liveGpuBtn.disabled = true;
    liveGpuBtn.textContent = 'Enabling…';
    await bridge.enableGpu(pw);
    liveGpuBtn.textContent = 'Live GPU ✓';
  });

  // ---- job events ----
  bridge.onJobEvent((evt) => {
    if (evt.type === 'log') {
      log(evt.message);
    } else if (evt.type === 'stage') {
      stageEl.textContent = evt.message;
      log(evt.message);
    } else if (evt.type === 'progress') {
      if (currentItem) {
        // progress is frame-accurate (framesDone / totalFrames) from the backend
        currentItem.progress = Math.round((evt.progress || 0) * 100);
        currentItem.framesDone = evt.framesDone;
        currentItem.totalFrames = evt.totalFrames;
        currentItem.stageFrames = evt.stageFrames;
        currentItem.stageTotal = evt.stageTotal;
      }
      updateProgress();
      if (evt.message && !paused) stageEl.textContent = evt.message;
      updateEta();
    } else if (evt.type === 'done') {
      log('✔ ' + evt.message);
      finishItem('done');
      stageEl.textContent = 'Done';
    } else if (evt.type === 'canceled') {
      log('■ ' + evt.message);
      finishItem('canceled');
      stageEl.textContent = 'Canceled';
    } else if (evt.type === 'error') {
      log('✘ ' + evt.message);
      finishItem('error');
      stageEl.textContent = 'Error: ' + evt.message;
    }
  });

  // ETA is derived from real frames done vs remaining and the elapsed time,
  // so it tracks actual throughput instead of a per-stage percentage.
  function updateEta() {
    if (!currentItem || !jobStart) { etaEl.textContent = ''; return; }
    const done = currentItem.framesDone;
    const total = currentItem.totalFrames;
    if (!done || !total || done <= 0) { etaEl.textContent = 'ETA: —'; return; }
    const elapsed = (Date.now() - jobStart) / 1000;
    if (elapsed <= 0) { etaEl.textContent = 'ETA: —'; return; }
    const rate = done / elapsed; // frames per second
    const remain = total - done;
    if (rate <= 0 || remain < 0) { etaEl.textContent = 'ETA: —'; return; }
    const eta = remain / rate;
    const m = Math.floor(eta / 60);
    const s = Math.floor(eta % 60);
    etaEl.textContent = `ETA: ${m}:${String(s).padStart(2, '0')}`;
  }

  // Continuous resource metrics (live even when idle / after a job stops)
  bridge.onMetrics((evt) => {
    pushMetric('cpu', evt.cpu);
    pushMetric('gpu', evt.gpu);
    pushMetric('media', evt.media);
    $('cpuVal').innerHTML = evt.cpu + '<small>%</small>';
    $('gpuVal').innerHTML = evt.gpu + '<small>%</small>' + (evt.gpuReal ? '' : ' <small style="color:var(--warn)">est</small>');
    $('mediaVal').innerHTML = evt.media + '<small>%</small>' + (evt.gpuReal ? '' : ' <small style="color:var(--warn)">est</small>');
    if (evt.gpuReal) {
      metricsHint.textContent = '';
    } else {
      metricsHint.textContent = 'GPU & Media Engine are estimated. Click “Live GPU” (or run sudo -v once) for real measurements.';
    }
    if (evt.paused) stageEl.textContent = 'Paused';
    drawGraphs();
  });

  // ---- metrics graphs ----
  function pushMetric(key, val) {
    const arr = hist[key];
    arr.push(val);
    if (arr.length > HIST) arr.shift();
  }

  const COLORS = { cpu: '#0a84ff', gpu: '#30d158', media: '#ffd60a' };

  function drawGraph(canvas, arr, color) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 200;
    const h = canvas.clientHeight || 56;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
    const n = arr.length;
    if (n === 0) return;
    const step = w / (HIST - 1);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = w - (n - 1 - i) * step;
      const y = h - (arr[i] / 100) * (h - 2) - 1;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(w - (n - 1) * step, h);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color + '26';
    ctx.fill();
  }

  function drawGraphs() {
    drawGraph($('cpuGraph'), hist.cpu, COLORS.cpu);
    drawGraph($('gpuGraph'), hist.gpu, COLORS.gpu);
    drawGraph($('mediaGraph'), hist.media, COLORS.media);
  }

  // redraw on resize
  window.addEventListener('resize', drawGraphs);

  // ---- in-app real-time player ----
  function fmtTime(s) {
    if (!isNaN(s) && !isFinite(s)) s = 0;
    if (!s || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function showPlayer() { playerEl.classList.remove('hidden'); }
  function hidePlayer() { playerEl.classList.add('hidden'); }

  function setPlayerLoading(show, status, pct) {
    if (show) {
      playerLoading.style.display = 'flex';
      playerVideo.style.display = 'none';
      if (status != null) playerStatus.textContent = status;
      if (pct != null) { playerBarFill.style.width = pct + '%'; playerPct.textContent = pct + '%'; }
    } else {
      playerLoading.style.display = 'none';
      playerVideo.style.display = 'block';
    }
  }

  // ---------------------------------------------------------------------------
  // Real-time streaming playback
  //
  // startStream() interpolates the video in short (~2s) segments and emits a
  // 'segment' event for each finished one. Instead of swapping the <video> src
  // per segment (which re-loads and shows a buffering bar every couple of
  // seconds), we append each fragmented-MP4 segment into ONE MediaSource buffer
  // in "sequence" mode, so playback is continuous and gapless. We also wait for
  // a few segments (PREBUFFER_SEGMENTS) before starting, which gives a cushion
  // so short interpolation slowdowns don't interrupt what you're watching.
  //
  // If MediaSource or the codec isn't available we fall back to the older
  // per-segment src-swap playback.
  // ---------------------------------------------------------------------------
  function openStream(input) {
    stream = {
      active: true, tempDir: null, output: null, done: false, total: 0,
      useMse: mseSupported(),
      // MSE path
      mse: null, sb: null, objectUrl: null, appendQueue: [], reading: false,
      pending: {}, nextIndex: 0, readySegs: 0, started: false, ended: false,
      // fallback path
      segments: [], playingIndex: 0,
    };
    preview = { input, output: null, status: 'streaming', temp: true };
    previewActive = true;
    renderQueue();
    showPlayer();
    playerWatch.style.display = '';
    setPlayerLoading(true, 'Starting real-time interpolation…', null);
    playerVideo.removeAttribute('src');
    playerVideo.load();

    if (stream.useMse) setupMse();
    else playerStatus.textContent = 'Buffering the first smooth segment…';

    bridge.startStream({
      input,
      targetFps: parseInt($('targetFps').value, 10),
      model: $('model').value,
      gpu: $('gpu').value,
      ttaSpatial: $('ttaS').checked,
      ttaTemporal: $('ttaT').checked,
      uhd: $('uhd').checked,
      gpuEncode: $('gpuEncode').checked,
    });
  }

  // ---- MediaSource (gapless) path ----
  function setupMse() {
    const mse = new window.MediaSource();
    stream.mse = mse;
    stream.objectUrl = URL.createObjectURL(mse);
    playerVideo.src = stream.objectUrl;
    mse.addEventListener('sourceopen', () => {
      if (!stream || stream.mse !== mse) return;
      try {
        const sb = mse.addSourceBuffer(STREAM_MIME);
        sb.mode = 'sequence'; // lay each segment right after the previous one
        stream.sb = sb;
        sb.addEventListener('updateend', pumpAppendQueue);
        pumpAppendQueue();
      } catch (e) {
        // Codec/SourceBuffer refused — drop to the fallback player.
        stream.useMse = false;
        for (const k of Object.keys(stream.pending)) {
          stream.segments[k] = stream.pending[k];
        }
        tryPlayStream();
      }
    }, { once: true });
  }

  // Read + queue every contiguous segment that's ready, starting at nextIndex,
  // so segments are always appended in order.
  async function drainReadySegments() {
    if (!stream || !stream.useMse || stream.reading) return;
    stream.reading = true;
    try {
      while (stream && stream.pending[stream.nextIndex] != null) {
        const idx = stream.nextIndex;
        const p = stream.pending[idx];
        delete stream.pending[idx];
        const buf = await bridge.readSegment(p);
        if (!stream) return;
        stream.nextIndex = idx + 1;
        if (!buf) continue;
        stream.appendQueue.push(buf);
        stream.readySegs += 1;
        pumpAppendQueue();
        maybeStartPlayback();
      }
    } finally {
      if (stream) stream.reading = false;
    }
    maybeEndStream();
  }

  function pumpAppendQueue() {
    const s = stream;
    if (!s || !s.sb || s.sb.updating) return;
    if (!s.appendQueue.length) { maybeEndStream(); return; }
    const buf = s.appendQueue.shift();
    try {
      s.sb.appendBuffer(buf);
    } catch (e) {
      // Buffer full: evict already-played data, then retry shortly.
      s.appendQueue.unshift(buf);
      try {
        const cur = playerVideo.currentTime || 0;
        if (cur > 6 && s.sb.buffered.length) {
          s.sb.remove(0, Math.max(0, cur - 4));
        }
      } catch (_) { /* ignore */ }
      setTimeout(pumpAppendQueue, 250);
    }
  }

  function maybeStartPlayback() {
    const s = stream;
    if (!s || s.started) return;
    if (s.readySegs >= PREBUFFER_SEGMENTS || s.done) {
      s.started = true;
      setPlayerLoading(false);
      playerStatus.textContent = 'Playing your smooth video…';
      playerVideo.play().catch(() => {});
    } else {
      setPlayerLoading(true, `Building a smooth buffer… (${s.readySegs}/${PREBUFFER_SEGMENTS})`, null);
    }
  }

  function maybeEndStream() {
    const s = stream;
    if (!s || !s.useMse || !s.mse || s.mse.readyState !== 'open') return;
    if (!s.done) return;
    if (s.appendQueue.length || (s.sb && s.sb.updating) || s.reading) return;
    if (s.total && s.nextIndex < s.total) return; // not all segments appended
    try { s.mse.endOfStream(); } catch (e) { /* ignore */ }
    playerStatus.textContent = 'Finished — full smooth video ready.';
    playerWatch.style.display = 'none';
  }

  // ---- fallback (per-segment src-swap) path ----
  function tryPlayStream() {
    if (!stream || !stream.active) return;
    const idx = stream.playingIndex;
    if (idx >= stream.segments.length) {
      if (stream.done) {
        playerStatus.textContent = 'Finished — full smooth video ready.';
        playerWatch.style.display = 'none';
        return;
      }
      setPlayerLoading(true, 'Buffering next segment…', null);
      return;
    }
    const segPath = stream.segments[idx];
    if (!segPath) {
      setPlayerLoading(true, 'Buffering next segment…', null);
      return;
    }
    setPlayerLoading(false);
    playerStatus.textContent = `Playing smooth segment ${idx + 1}…`;
    playerVideo.src = 'file://' + segPath;
    playerVideo.play().catch(() => {});
  }

  // Play an already-converted 60 FPS file directly (no re-interpolation).
  function playFile(input, output) {
    preview = { input, output, status: 'playing', temp: false };
    previewActive = true;
    renderQueue();
    showPlayer();
    setPlayerLoading(false);
    playerStatus.textContent = 'Watching your 60 FPS file in the app';
    playerVideo.src = 'file://' + output;
    playerVideo.play().catch(() => {});
  }

  function playItem(item) {
    if (previewActive) return;
    if (item.status === 'done' && item.output) playFile(item.input, item.output);
    else { if (processing) return; openStream(item.input); }
  }

  bridge.onStreamEvent((evt) => {
    if (!stream) return;
    const preStart = stream.useMse ? !stream.started : (stream.playingIndex === 0 && !stream.segments.length);
    if (evt.type === 'tempdir') {
      stream.tempDir = evt.path;
    } else if (evt.type === 'stage') {
      if (preStart) setPlayerLoading(true, evt.message, null);
    } else if (evt.type === 'progress') {
      if (preStart && evt.progress != null) {
        const pct = Math.round((evt.progress || 0) * 100);
        setPlayerLoading(true, 'Preparing real-time playback…', pct);
      }
    } else if (evt.type === 'segment') {
      stream.total = evt.total || stream.total;
      if (stream.useMse) {
        stream.pending[evt.index] = evt.path;
        drainReadySegments();
      } else {
        stream.segments[evt.index] = evt.path;
        if (evt.index === stream.playingIndex) tryPlayStream();
      }
    } else if (evt.type === 'done') {
      stream.done = true;
      stream.output = evt.output;
      preview = preview || {};
      preview.output = evt.output;
      preview.status = 'playing';
      if (stream.useMse) {
        maybeStartPlayback();
        maybeEndStream();
      } else if (stream.playingIndex >= stream.segments.length) {
        playerStatus.textContent = 'Finished — full smooth video ready.';
        playerWatch.style.display = 'none';
      }
    } else if (evt.type === 'canceled') {
      closePlayer();
    } else if (evt.type === 'error') {
      setPlayerLoading(true, 'Error: ' + evt.message, null);
    }
  });

  function closePlayer() {
    if (bridge.cancelJob) bridge.cancelJob();
    if (stream && stream.tempDir) bridge.streamCleanup(stream.tempDir);
    try { playerVideo.pause(); } catch (e) {}
    if (stream && stream.mse) {
      try { if (stream.mse.readyState === 'open') stream.mse.endOfStream(); } catch (e) {}
    }
    if (stream && stream.objectUrl) {
      try { URL.revokeObjectURL(stream.objectUrl); } catch (e) {}
    }
    playerVideo.removeAttribute('src');
    playerVideo.load();
    stream = null;
    preview = null;
    previewActive = false;
    playerWatch.style.display = '';
    hidePlayer();
    renderQueue();
  }

  previewBtn.addEventListener('click', async () => {
    if (previewActive || processing) return;
    const p = await bridge.selectInput();
    if (p) openStream(p);
  });

  playerClose.addEventListener('click', () => closePlayer());
  playerWatch.addEventListener('click', () => {
    // "watch here" is the default — just make sure it's playing.
    if (playerVideo.paused) playerVideo.play().catch(() => {});
  });
  playerPlay.addEventListener('click', () => {
    if (playerVideo.paused) playerVideo.play().catch(() => {});
    else playerVideo.pause();
  });
  playerMute.addEventListener('click', () => {
    playerVideo.muted = !playerVideo.muted;
    playerMute.textContent = playerVideo.muted ? '🔇' : '🔊';
  });
  playerFs.addEventListener('click', () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (playerStage) {
      if (playerStage.requestFullscreen) playerStage.requestFullscreen();
      else if (playerStage.webkitRequestFullscreen) playerStage.webkitRequestFullscreen();
    }
  });
  function updateFsIcon() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (playerFs) playerFs.textContent = fsEl ? '⤡' : '⛶';
  }
  document.addEventListener('fullscreenchange', updateFsIcon);
  document.addEventListener('webkitfullscreenchange', updateFsIcon);
  playerVideo.addEventListener('timeupdate', () => {
    const d = playerVideo.duration || 0;
    const c = playerVideo.currentTime || 0;
    playerTime.textContent = `${fmtTime(c)} / ${fmtTime(d)}`;
    if (d > 0) playerSeek.value = String((c / d) * 100);
  });
  playerVideo.addEventListener('ended', () => {
    playerPlay.textContent = '⏯';
    // Fallback player only: advance to the next segment. In MediaSource mode the
    // segments are one continuous buffer, so 'ended' just means playback is done.
    if (stream && stream.active && !stream.useMse) {
      stream.playingIndex += 1;
      tryPlayStream();
    } else if (stream && stream.useMse) {
      stream.ended = true;
    }
  });

  // Show a brief "Buffering…" state only if the MediaSource stream genuinely
  // runs out of buffered data mid-playback (interpolation fell behind).
  playerVideo.addEventListener('waiting', () => {
    if (stream && stream.useMse && stream.started && !stream.ended) {
      setPlayerLoading(true, 'Buffering…', null);
    }
  });
  playerVideo.addEventListener('playing', () => {
    if (stream && stream.useMse && stream.started) {
      setPlayerLoading(false);
      playerStatus.textContent = 'Playing your smooth video…';
    }
  });
  playerSeek.addEventListener('input', () => {
    const d = playerVideo.duration || 0;
    if (d > 0) playerVideo.currentTime = (parseFloat(playerSeek.value) / 100) * d;
  });
  playerSave.addEventListener('click', async () => {
    const out = (preview && preview.output) || (stream && stream.output);
    if (!out) { playerStatus.textContent = 'Still rendering — save when finished.'; return; }
    const base = (preview && preview.input ? preview.input : out).split('/').pop().replace(/\.[^.]+$/, '') + '_60fps.mp4';
    playerStatus.textContent = 'Saving…';
    const res = await bridge.previewSave(out, base);
    if (!res) playerStatus.textContent = 'Save canceled';
    else if (res.error) playerStatus.textContent = 'Save failed: ' + res.error;
    else playerStatus.textContent = 'Saved to ' + res.split('/').pop();
  });

  renderQueue();
  updateProgress();
})();
