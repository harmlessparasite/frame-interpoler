const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

// In dev (electron .) assets live next to the app source; in a packaged
// .app they are copied outside the ASAR into the Resources directory.
require('electron');
const PLATFORM_BIN = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'ubuntu';
const RIFE_EXE = process.platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan';
const RIFE_METAL_EXE = process.platform === 'win32' ? 'rife-metal-batch.exe' : 'rife-metal-batch';

// Default inference engine. 'metal' = native Apple-Silicon RIFE (MPSGraph +
// custom Metal warp kernel) — much faster than the Vulkan/MoltenVK build and
// the only path that reaches real-time at 1080p. Override with RIFE_ENGINE=vulkan.
const ENGINE = (process.env.RIFE_ENGINE || 'metal').toLowerCase();

function fileExists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

// Resolve a binary from several candidate locations, so a conversion never
// silently falls back to a bare command name (which only works if the binary
// happens to be on the GUI process's PATH — it usually isn't, causing the
// "spawn ffprobe ENOENT" error). Candidates, in priority order:
//   1. explicit FFMPEG_PATH / FFPROBE_PATH env override
//   2. bundled bin/ next to the packaged resources dir
//   3. bundled bin/ next to the project (dev mode)
//   4. the ffmpeg-static / ffprobe-static npm packages (always in node_modules)
//   5. anywhere on PATH
function resolveBin(name, isProbe) {
  const candidates = [];
  const envVar = isProbe ? process.env.FFPROBE_PATH : process.env.FFMPEG_PATH;
  if (envVar) candidates.push(envVar);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', PLATFORM_BIN, name));
  candidates.push(path.join(__dirname, '..', 'bin', PLATFORM_BIN, name));
  if (isProbe) {
    try { const p = require('ffprobe-static').path; if (fileExists(p)) candidates.push(p); } catch (e) { /* not bundled */ }
  } else {
    try { const p = require('ffmpeg-static'); if (fileExists(p)) candidates.push(p); } catch (e) { /* not bundled */ }
  }
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    if (dir) { const p = path.join(dir, name); if (fileExists(p)) candidates.push(p); }
  }
  for (const c of candidates) if (fileExists(c)) return c;
  // Last resort: let spawn try the bare name (will ENOENT only if truly absent)
  return name;
}

const FFMPEG = resolveBin('ffmpeg', false);
const FFPROBE = resolveBin('ffprobe', true);

// Native-Metal engine binary + its Practical-RIFE v4.26 weights (.rmw).
function resolveMetal() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', PLATFORM_BIN, RIFE_METAL_EXE));
  candidates.push(path.join(__dirname, '..', 'bin', PLATFORM_BIN, RIFE_METAL_EXE));
  for (const c of candidates) if (fileExists(c)) return c;
  return candidates[0] || RIFE_METAL_EXE;
}

const metalPath = resolveMetal();
const metalWeights = path.join(path.dirname(metalPath), 'rife-v4.26.rmw');

function resolveRife() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', PLATFORM_BIN, RIFE_EXE));
  candidates.push(path.join(__dirname, '..', 'bin', PLATFORM_BIN, RIFE_EXE));
  for (const c of candidates) if (fileExists(c)) return c;
  return candidates[0] || RIFE_EXE;
}

const rifePath = resolveRife();
const modelBase = path.join(path.dirname(rifePath));

let current = null;

function emit(onEvent, evt) {
  try { onEvent(evt); } catch (e) { /* ignore */ }
}

function parseRate(s) {
  if (!s || s === 'N/A') return null;
  const p = String(s).split('/');
  const a = parseFloat(p[0]);
  const b = parseFloat(p[1]);
  if (isNaN(a)) return null;
  if (p.length < 2 || isNaN(b) || b === 0) return a;
  return a / b;
}

// Pick a reasonable hardware-encoder bitrate from resolution + frame rate.
function videoBitrate(w, h, fps) {
  const pw = w || 1920;
  const ph = h || 1080;
  const pf = fps || 60;
  const bpp = 0.12; // bits per pixel per frame (good-quality hardware H.264)
  let kbps = Math.round((pw * ph * pf * bpp) / 1000);
  kbps = Math.max(2000, Math.min(80000, kbps));
  return kbps + 'k';
}

// Real CPU usage (%) of the conversion child processes, normalized to total
// machine capacity. This is the only one of the three metrics macOS lets an
// unprivileged app read directly.
function sampleCpu(children) {
  const pids = (children || []).map((c) => c.pid).filter(Boolean);
  if (!pids.length) return 0;
  try {
    const out = execFileSync('ps', ['-o', '%cpu=', '-p', pids.join(',')], { encoding: 'utf8' });
    const sum = out.split('\n').map((s) => parseFloat(s)).filter((n) => !isNaN(n)).reduce((a, b) => a + b, 0);
    const cores = os.cpus().length || 1;
    return Math.max(0, Math.min(100, Math.round(sum / cores)));
  } catch (e) {
    return 0;
  }
}

// macOS does not expose live GPU or Apple Media Engine utilization to
// non-privileged apps, so we estimate from which pipeline stage is active:
//  - extract / encode use the Apple Media Engine (VideoToolbox hw dec/enc)
//  - interpolate uses the GPU compute engine (RIFE / Metal)
function estimateGpuMedia(stage) {
  if (stage === 'interpolate') return { gpu: 86, media: 4 };
  if (stage === 'extract') return { gpu: 32, media: 84 };
  if (stage === 'encode') return { gpu: 46, media: 90 };
  if (stage === 'finalize') return { gpu: 20, media: 88 };
  return { gpu: 8, media: 5 };
}

// Best-effort live GPU % via `powermetrics` (requires sudo). We launch a
// single long-running `sudo -n powermetrics` (non-interactive; uses cached
// sudo credentials) and parse "GPU HW active residency". If sudo isn't
// available, gpu stays null and the caller falls back to the stage estimate.
let powerMetricsProc = null;
let lastGpu = null;
let powerMetricsWorking = false;

function startPowerMetrics() {
  try {
    // Prefer passwordless sudo (cached credentials). If RIFE_SUDO_PASS is set
    // (opt-in, off by default — never hard-coded), pipe the password to sudo -S
    // so live GPU % works without the user running `sudo` manually first.
    let p;
    if (process.env.RIFE_SUDO_PASS) {
      const pw = String(process.env.RIFE_SUDO_PASS).replace(/"/g, '\\"');
      p = spawn('sh', ['-c', `echo "${pw}" | sudo -S powermetrics -i 1000`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      p = spawn('sudo', ['-n', 'powermetrics', '-i', '1000'], { windowsHide: true });
    }
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/GPU HW active residency:\s*([\d.]+)%/);
        if (m) lastGpu = parseFloat(m[1]);
      }
    });
    p.on('error', () => { powerMetricsProc = null; });
    p.on('close', () => { powerMetricsProc = null; });
    powerMetricsProc = p;
    powerMetricsWorking = true;
  } catch (e) {
    powerMetricsProc = null;
  }
}

function stopPowerMetrics() {
  if (powerMetricsProc) {
    try { powerMetricsProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    powerMetricsProc = null;
  }
  lastGpu = null;
}

function ffprobeJson(args, bin) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin || FFPROBE, args, { windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => reject(new Error('Could not launch ffprobe (' + (bin || FFPROBE) + '): ' + e.message)));
    c.on('close', (code) => {
      if (code !== 0) return reject(new Error((err || 'ffprobe exited ' + code).trim()));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('ffprobe returned unreadable output')); }
    });
  });
}

// Last-resort probe using ffmpeg directly. ffmpeg is arm64 (always runs, even
// without Rosetta), so this is the primary probe path. It must handle the many
// ways ffmpeg reports rate/duration (e.g. "30 fps", "30 tbr", "30 tbn", or a
// missing Duration) rather than assuming one fixed format.
async function probeWithFfmpeg(input) {
  // Large probe size/analysis so ffmpeg finds streams + duration even for files
  // whose metadata sits at the end of the container (a very common cause of
  // "could not determine duration/fps").
  const PROBE = ['-hide_banner', '-probesize', '2G', '-analyzeduration', '500M', '-i', input];

  const readStderr = (args) => new Promise((resolve, reject) => {
    const c = spawn(FFMPEG, args, { windowsHide: true });
    let out = '';
    c.stderr.on('data', (d) => (out += d));
    c.on('error', (e) => reject(e));
    c.on('close', () => resolve(out));
  });

  const out = await readStderr(PROBE);
  const audio = /Audio:\s/.test(out);
  const whM = out.match(/Stream.*?Video:.*?(\d{2,5})x(\d{2,5})/);
  const width = whM ? parseInt(whM[1], 10) : NaN;
  const height = whM ? parseInt(whM[2], 10) : NaN;

  const durM = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  let dur = durM ? (parseInt(durM[1], 10) * 3600 + parseInt(durM[2], 10) * 60 + parseFloat(durM[3])) : NaN;

  // Rate may appear as "fps", "tbr", or "tbn" — accept any.
  const fpsM = out.match(/(\d+(?:\.\d+)?)\s*fps/)
            || out.match(/(\d+(?:\.\d+)?)\s*tbr/)
            || out.match(/(\d+(?:\.\d+)?)\s*tbn/);
  let fps = fpsM ? parseFloat(fpsM[1]) : NaN;

  let frames = (!isNaN(dur) && dur > 0 && !isNaN(fps) && fps > 0) ? Math.round(dur * fps) : NaN;

  // Fall back to an actual frame count whenever duration or fps is missing.
  // Try a few demux strategies (default stream selection, then force the first
  // video stream) so we succeed even when the video isn't the default map.
  if (isNaN(frames) || frames <= 0) {
    const strategies = [
      ['-hide_banner', '-probesize', '2G', '-analyzeduration', '500M', '-i', input, '-f', 'null', '-'],
      ['-hide_banner', '-probesize', '2G', '-analyzeduration', '500M', '-i', input, '-map', '0:v', '-f', 'null', '-'],
    ];
    let lastCnt = '';
    for (const args of strategies) {
      const cnt = await readStderr(args);
      lastCnt = cnt;
      const fm = cnt.match(/frame=\s*(\d+)/g);
      const fc = (fm && fm.length) ? parseInt(fm[fm.length - 1].replace(/frame=\s*/, ''), 10) : NaN;
      if (!isNaN(fc) && fc > 0) {
        if (isNaN(fps) || fps <= 0) fps = (!isNaN(dur) && dur > 0) ? fc / dur : 30;
        if (isNaN(dur) || dur <= 0) dur = fps > 0 ? fc / fps : NaN;
        frames = fc;
        break;
      }
    }
  }

  if (!isNaN(fps) && fps > 0) { /* ok */ } else fps = 30;
  if (isNaN(frames) || frames <= 0) {
    // Surface ffmpeg's own diagnostics so an unreadable file can be identified.
    const diag = out.replace(/\s+/g, ' ').trim().slice(0, 600);
    throw new Error('ffmpeg could not open the file (it may be incomplete, corrupt, or use an unsupported/very new container format). ffmpeg said: ' + (diag || '(no output)'));
  }
  return { fps, frames, hasAudio: audio, duration: dur, width, height };
}

async function parseFfprobe(json, input) {
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) return null;
  let fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  let frames = parseInt(v.nb_frames, 10);
  const dur = parseFloat(v.duration) || (json.format ? parseFloat(json.format.duration) : NaN);
  if ((!frames || isNaN(frames)) && dur && fps) frames = Math.round(dur * fps);

  // Fallback for variable / unknown frame-rate videos: actually count frames.
  if ((!fps || isNaN(fps) || fps <= 0) || (!frames || isNaN(frames) || frames <= 0)) {
    try {
      const c = await ffprobeJson([
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_read_frames,r_frame_rate,avg_frame_rate,duration',
        '-show_entries', 'format=duration', '-of', 'json', input,
      ]);
      const cv = (c.streams || []).find((s) => s.codec_type === 'video');
      const cf = cv ? parseInt(cv.nb_read_frames, 10) : NaN;
      const cdur = cv ? (parseFloat(cv.duration) || (c.format ? parseFloat(c.format.duration) : NaN)) : NaN;
      if (cf && !isNaN(cf)) frames = cf;
      if ((!fps || fps <= 0) && cf && !isNaN(cf) && cdur && !isNaN(cdur)) fps = cf / cdur;
      if (!fps || fps <= 0) fps = parseRate(cv && cv.r_frame_rate) || parseRate(cv && cv.avg_frame_rate);
    } catch (e) { /* keep whatever we already have */ }
  }
  if (!fps || isNaN(fps) || fps <= 0) fps = 30; // last resort; very rare
  if (!frames || isNaN(frames) || frames <= 0) return null;
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const width = parseInt(v.width, 10);
  const height = parseInt(v.height, 10);
  return { fps, frames, hasAudio, duration: dur, width, height };
}

async function probeVideo(input) {
  let meta = null;
  let lastErr = null;
  // 1) bundled ffprobe — only if we actually ship one (kept native/arm64; an
  //    x86_64 build would force Rosetta 2, so we avoid bundling it and rely on
  //    the ffmpeg-based probe below instead).
  if (FFPROBE) {
    try { meta = await parseFfprobe(await ffprobeJson(['-v', 'error', '-of', 'json', '-show_format', '-show_streams', input], FFPROBE), input); }
    catch (e) { lastErr = e; }
  }
  // 2) system ffprobe on PATH (user-installed, e.g. arm64 Homebrew)
  if (!meta) {
    try {
      const sys = require('child_process').execFileSync('sh', ['-c', 'command -v ffprobe 2>/dev/null || which ffprobe 2>/dev/null'], { encoding: 'utf8' }).trim();
      if (sys) meta = await parseFfprobe(await ffprobeJson(['-v', 'error', '-of', 'json', '-show_format', '-show_streams', input], sys), input);
    } catch (e) { lastErr = e; }
  }
  // 3) ffmpeg-based fallback (arm64, always bundled) — primary path when no
  //    native ffprobe is available.
  if (!meta) {
    try { meta = await probeWithFfmpeg(input); } catch (e) { lastErr = e; }
  }
  if (!meta) {
    throw new Error('Could not read the video. ' + (lastErr && lastErr.message ? lastErr.message : ''));
  }
  return meta;
}

function runFfmpeg(args, { onFrame, label }) {
  return new Promise((resolve, reject) => {
    const c = spawn(FFMPEG, args, { windowsHide: true });
    if (current) current.children.push(c);
    let last = -1;
    let errBuf = '';
    const onData = (d) => {
      const s = d.toString();
      errBuf += s;
      const m = s.match(/frame=\s*(\d+)/g);
      if (m) {
        const n = parseInt(m[m.length - 1].replace(/\D/g, ''), 10);
        if (n !== last) { last = n; if (onFrame) onFrame(n); }
      }
    };
    c.stderr.on('data', onData);
    c.on('error', (e) => reject(new Error('Could not launch ffmpeg (' + FFMPEG + '): ' + e.message)));
    c.on('close', (code) => {
      if (current) current.children = current.children.filter((x) => x !== c);
      if (code === 0) resolve();
      else {
        const tail = errBuf.replace(/\s+/g, ' ').trim().split(' ').slice(-40).join(' ');
        reject(new Error(`${label} failed (ffmpeg exited ${code}): ${tail}`));
      }
    });
  });
}

function runRife({ inputDir, outputDir, targetFrames, model, tier, format, engine, ttaSpatial, ttaTemporal, uhd, gpu, onEvent, onFrame }) {
  const isMetal = engine === 'metal';
  return new Promise((resolve, reject) => {
    // Guard: a segment that extracted 0 frames (e.g. a seek past EOF or a
    // corrupt region) would make the interpolator exit non-zero with an opaque
    // message. Fail early with something actionable instead.
    try {
      const inExt = isMetal && format === 'jpeg' ? '.jpg' : '.png';
      const nIn = fs.readdirSync(inputDir).filter((f) => f.toLowerCase().endsWith(inExt)).length;
      if (nIn < 2) {
        return reject(new Error(`interpolation needs at least 2 source frames but found ${nIn} in this segment (the video may be truncated or use an unsupported codec).`));
      }
    } catch (e) { /* dir will be re-checked by the engine */ }

    let exe;
    let args;
    if (isMetal) {
      exe = metalPath;
      // Native-Metal batch CLI: rife-ncnn-vulkan-compatible I/O. The Practical-RIFE
      // v4.26 weights are a single .rmw file; output frame count is explicit (-n).
      args = ['-i', inputDir, '-o', outputDir, '-m', metalWeights, '--tier', tier || 'fast', '--format', format || 'jpeg', '-n', String(targetFrames)];
    } else {
      exe = rifePath;
      args = ['-i', inputDir, '-o', outputDir, '-m', path.join(modelBase, model)];
      // Only the rife-v4 family supports a custom output frame count (`-n`).
      // Older models (v2.x / v3.x) ignore it and would error, so for them we
      // rely on RIFE's default behaviour (doubling: N -> 2N frames).
      if (/v4/i.test(model)) args.push('-n', String(targetFrames));
      if (ttaSpatial) args.push('-x');
      if (ttaTemporal) args.push('-z');
      if (uhd) args.push('-u');
      if (gpu && gpu !== 'auto') args.push('-g', gpu);
    }

    const c = spawn(exe, args, { windowsHide: true });
    if (current) current.children.push(c);

    // Surface which compute device RIFE selected (so the user can confirm GPU use)
    // and keep the tail of stderr/stdout so a non-zero exit reports the real
    // reason (e.g. modelLoadFailed, out-of-memory) instead of a bare "exit 1".
    let deviceLogged = false;
    let errTail = '';
    const capture = (d) => {
      const s = d.toString();
      errTail = (errTail + s).slice(-4000);
      const lines = s.split('\n');
      for (const line of lines) {
        const m = line.match(/^\[(\d+)\s+([^\]]+)\]/);
        if (m && !deviceLogged) {
          deviceLogged = true;
          const dev = m[2].trim();
          emit(onEvent, { type: 'log', message: `RIFE compute device: ${dev}` });
        }
      }
    };
    c.stderr.on('data', capture);
    c.stdout.on('data', capture);

    const ext = isMetal && format === 'jpeg' ? '.jpg' : '.png';
    let done = false;
    let pollTimer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (pollTimer) clearInterval(pollTimer);
      if (current) current.children = current.children.filter((x) => x !== c);
      if (err) reject(err);
      else resolve();
    };

    pollTimer = setInterval(async () => {
      try {
        const files = await fsp.readdir(outputDir);
        const n = files.filter((f) => f.endsWith(ext)).length;
        if (onFrame) onFrame(n);
      } catch (e) { /* dir not ready yet */ }
    }, 700);

    c.on('error', (e) => finish(new Error(`Could not launch ${isMetal ? 'rife-metal-batch' : 'rife'} (${exe}): ${e.message}`)));
    c.on('close', (code, signal) => {
      if (code === 0) return finish(null);
      const name = isMetal ? 'rife-metal' : 'RIFE';
      const reason = errTail.replace(/\s+/g, ' ').trim().slice(-500);
      // code === null means the OS (or we) terminated it with a signal. SIGKILL
      // with no output is almost always the memory manager reclaiming RAM
      // (out-of-memory), so give the user something actionable.
      if (code === null) {
        const oom = signal === 'SIGKILL' || signal === 'SIGABRT' || !signal;
        const hint = oom
          ? ' — the interpolation process was terminated by the system, most likely out of memory. Try a lower target resolution, close other apps, or use the “Play real-time” mode which caps resolution.'
          : '';
        const err = new Error(`${name} interpolation was killed (signal ${signal || 'unknown'})${hint}${reason ? ' | ' + reason : ''}`);
        err.killed = true;
        return finish(err);
      }
      finish(new Error(`${name} interpolation failed (exit ${code})${reason ? ': ' + reason : ''}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Real-time streaming pipeline
//
// The whole point is to keep up with playback. Three things make that possible:
//   1. Frames live on a RAM disk (macOS, no sudo) so we never hammer the SSD
//      with the millions of PNGs a video produces.
//   2. Realtime mode forces the FAST path: fastest model, no TTA, and a
//      resolution cap, so RIFE can interpolate faster than real time.
//   3. Extraction of the next segment overlaps RIFE+encode of the current one,
//      so the GPU is never starved waiting on decode.
//
//   for each segment:
//     extract that segment's source frames  (hw decode, fast seek, RAM-backed)
//     RIFE-interpolate them to the (effective) target fps
//     encode the segment to a standalone, faststart MP4
//
// Two modes share this loop:
//   * export   (startJob):    after all segments are done, concat them + mux
//                             the original audio into a single output file.
//   * realtime (startStream): each finished segment is handed to the UI the
//                             moment it is ready, so playback can begin within
//                             a couple of seconds and continue as segments land.
// ---------------------------------------------------------------------------

// Length of each processing segment, in seconds. Smaller = faster time-to-first-
// frame (snappier real-time start) but more per-segment overhead. 2s is a good
// balance for 1080p/4K on Apple Silicon.
const SEGMENT_SECONDS = 2;

// Realtime levers — these are what actually let the GPU keep up with playback.
const RT_MODEL = 'rife-v2.4';   // fastest bundled model
const RT_MAX_EDGE = 480;        // cap live resolution so RIFE can keep up with playback

// ---- RAM disk (macOS, no sudo) so intermediate frames never touch the SSD ----
// A RAM disk consumes physical memory, so it competes with the Metal/RIFE
// engine's own (large) working set. On memory-constrained Macs that combination
// can trigger an out-of-memory kill of the interpolation process (which shows up
// as a signal termination / "exit null"). We therefore only use a RAM disk when
// it's genuinely safe: enough total memory, and small (resolution-capped) frames
// — i.e. real-time mode. Full-resolution export always uses the SSD temp dir.
let _ram = null;
function makeRamTemp(sizeBytes) {
  try {
    const bytes = Math.max(256 * 1024 * 1024, Math.min(sizeBytes || (1024 * 1024 * 1024), 2 * 1024 * 1024 * 1024));
    const sectors = Math.round(bytes / 512);
    const out = execFileSync('hdiutil', ['attach', '-nomount', `ram://${sectors}`], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (!out || !/^\/dev\/disk\d+$/.test(out)) return null;
    execFileSync('diskutil', ['eraseDisk', 'APFS', 'RIFE-RAM', out], { encoding: 'utf8' });
    const dir = '/Volumes/RIFE-RAM';
    if (!fs.existsSync(dir)) return null;
    return { dir, dev: out };
  } catch (e) { return null; }
}
function freeRamTemp(dev) {
  if (!dev) return;
  try { execFileSync('hdiutil', ['detach', dev, '-force'], { encoding: 'utf8' }); } catch (e) { /* ignore */ }
}

// Decide whether a RAM disk is safe to use for this job. Only for real-time
// (resolution-capped, small frames), and only on machines with comfortable
// total memory, leaving plenty of headroom for the Metal engine.
function shouldUseRamDisk(realtime, meta) {
  if (!realtime) return false;                 // full-res export -> always SSD
  const totalGB = os.totalmem() / (1024 * 1024 * 1024);
  if (totalGB < 12) return false;              // 8 GB Macs: don't risk OOM
  return true;
}

function getRamDir(sizeBytes) {
  if (_ram && fs.existsSync(_ram.dir)) return _ram.dir;
  _ram = makeRamTemp(sizeBytes);
  return _ram ? _ram.dir : null;
}
function releaseRam() { if (_ram) { freeRamTemp(_ram.dev); _ram = null; } }

// Tile the source into contiguous frame ranges. `mult` is the interpolation
// multiplier (output fps / source fps); each segment carries the number of
// source frames it covers and the number of interpolated output frames.
function planSegments(meta, mult) {
  const fps = meta.fps || 30;
  const total = meta.frames || 0;
  const segs = [];
  let start = 0;
  let idx = 0;
  while (start < total) {
    const count = Math.min(Math.max(2, Math.round(SEGMENT_SECONDS * fps)), total - start);
    segs.push({
      index: idx,
      srcStart: start,
      count,
      srcStartSec: start / fps,
      srcDurSec: count / fps,
      outFrames: Math.max(2, Math.round(count * mult)),
      isFirst: idx === 0,
    });
    start += count;
    idx += 1;
  }
  return segs;
}

async function extractSegment(input, seg, framesDir, scale, format, onFrame) {
  const args = [
    '-y', '-threads', '0', '-hwaccel', 'videotoolbox',
    '-ss', seg.srcStartSec.toFixed(6), '-i', input,
  ];
  // Optional resolution cap for realtime so RIFE keeps pace.
  if (scale) args.push('-vf', `scale=${scale}`);
  const pat = path.join(framesDir, format === 'jpeg' ? '%08d.jpg' : '%08d.png');
  // JPEG intermediates decode/encode far faster than PNG (critical for realtime
  // throughput); quality 2 keeps them visually lossless enough for RIFE.
  if (format === 'jpeg') args.push('-q:v', '2');
  args.push('-frames:v', String(seg.count), '-vsync', '0', pat);
  await runFfmpeg(args, { label: `Extracting segment ${seg.index}`, onFrame });
}

async function encodeSegment(outDir, seg, outW, outH, effFps, gpuEncode, format, onFrame, fragmented) {
  const br = videoBitrate(outW, outH, effFps);
  const pat = path.join(outDir, format === 'jpeg' ? '%08d.jpg' : '%08d.png');
  const args = [
    '-y', '-threads', '0',
    '-framerate', String(effFps), '-i', pat,
    '-frames:v', String(seg.outFrames),
  ];
  if (gpuEncode) {
    args.push('-c:v', 'h264_videotoolbox', '-b:v', br, '-pix_fmt', 'yuv420p', '-allow_sw', '0');
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-threads', '0');
  }
  if (fragmented) {
    // Fragmented MP4 so the renderer can append segments into a single
    // MediaSource buffer for gapless (no re-load) real-time playback. A fixed
    // High/4.0 profile keeps the codec string predictable (avc1.640028) so MSE
    // accepts every segment, and each segment starts on a keyframe.
    args.push('-profile:v', 'high', '-level', '4.0', '-force_key_frames', '0');
    args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
  } else {
    args.push('-movflags', '+faststart');
  }
  args.push(seg.file);
  await runFfmpeg(args, { label: `Encoding segment ${seg.index}`, onFrame });
}

// Concatenate the per-segment MP4s (already encoded, identical params so a
// stream copy is safe) and mux the original audio back in. This is a fast
// copy — no re-interpolation or re-encode — so the final assembly is quick.
async function concatSegments(segFiles, audioInput, output, hasAudio) {
  const listPath = path.join(path.dirname(segFiles[0]), 'segs.txt');
  await fsp.writeFile(listPath, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];
  if (hasAudio) {
    args.push('-i', audioInput, '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  } else {
    args.push('-map', '0:v:0', '-c:v', 'copy');
  }
  args.push('-movflags', '+faststart', output);
  await runFfmpeg(args, { label: 'Assembling final video', onFrame: () => {} });
}

// Core engine shared by export (startJob) and realtime (startStream).
async function runPipeline(opts, onEvent, { realtime }) {
  const {
    input, output, targetFps, model = 'rife-v4.6',
    ttaSpatial = false, ttaTemporal = false, uhd = false, gpu = 'auto', gpuEncode = true,
  } = opts;

  // Pick the inference engine. 'metal' is the native Apple-Silicon build and is
  // the only path that reaches real-time at higher resolutions.
  const engine = opts.engine || ENGINE;

  // Realtime mode forces the fast path so the GPU can actually keep up with
  // playback: fastest model, no TTA/UHD, and a resolution cap. Export mode
  // honours the user's chosen (slower, higher-quality) settings and full res.
  // For the native-Metal engine we use Practical-RIFE v4.26 (a v4 model, so the
  // explicit -n frame count is honoured) plus a quality tier (fast/balanced/hq)
  // instead of TTA/UHD flags.
  const effModel = engine === 'metal'
    ? 'rife-v4.26'
    : (realtime ? RT_MODEL : model);
  const effTtaS = engine === 'metal' ? false : (realtime ? false : ttaSpatial);
  const effTtaT = engine === 'metal' ? false : (realtime ? false : ttaTemporal);
  const effUhd = engine === 'metal' ? false : (realtime ? false : uhd);
  const effTier = engine === 'metal'
    ? (realtime ? 'fast' : (uhd ? 'balanced' : 'hq'))
    : null;
  const effFormat = engine === 'metal' ? 'jpeg' : 'png';

  const job = { children: [], cancelled: false, tempDir: null, stage: 'analyze', paused: false, ramDev: null };
  current = job;
  const cleanup = async () => {
    if (job.tempDir) {
      try { await fsp.rm(job.tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  };

  try {
    emit(onEvent, { type: 'log', message: `Analyzing ${path.basename(input)}…` });
    const meta = await probeVideo(input);
    if (!meta.fps || !meta.frames) throw new Error('Could not determine source frame rate / frame count.');
    emit(onEvent, { type: 'log', message: `Source: ${meta.fps.toFixed(2)} fps, ${meta.frames} frames, audio: ${meta.hasAudio ? 'yes' : 'no'}` });

    // Effective output fps. v4 models support arbitrary upsampling via -n; the
    // fast v2.x models only double, so we cap the multiplier at 2 for realtime.
    const wantMult = targetFps / meta.fps;
    const mult = /v4/i.test(effModel) ? wantMult : Math.min(2, wantMult);
    const effFps = meta.fps * mult;
    emit(onEvent, {
      type: 'log',
      message: realtime
        ? `Real-time: ${effModel}, ${effFps.toFixed(0)} fps (${(mult).toFixed(2)}x), RAM-backed frames`
        : `Target: ${targetFps} fps (${(wantMult).toFixed(2)}x). Streaming in ${SEGMENT_SECONDS}s segments.`,
    });

    // Resolution cap for realtime so RIFE keeps pace with playback. The native
    // Metal engine is far faster, so it can sustain 1080p; the old Vulkan build
    // needed a tight 480px cap. >cap sources are downscaled to `cap` wide.
    const rtCap = engine === 'metal' ? 1920 : RT_MAX_EDGE;
    let outW = meta.width, outH = meta.height, scale = null;
    if (realtime && meta.width > rtCap) {
      outW = rtCap;
      outH = Math.round(meta.height * rtCap / meta.width);
      outW += outW % 2; outH += outH % 2;
      scale = `${outW}:${outH}`;
    }

    const segs = planSegments(meta, mult);
    const totalFrames = segs.reduce((a, s) => a + s.count + s.outFrames + s.outFrames, 0);
    let baseDone = 0;
    const emitProgress = (stage, stageFrames, stageTotal) => {
      const framesDone = baseDone + stageFrames;
      const progress = totalFrames ? Math.min(1, framesDone / totalFrames) : 0;
      emit(onEvent, {
        type: 'progress', stage, progress, framesDone, totalFrames, stageFrames, stageTotal,
        message: `${stage}: segment ${stageFrames}/${stageTotal}`,
      });
    };

    // Work in a RAM disk when it's safe (real-time, capped frames, ample memory)
    // — a big speed win. For full-resolution export, or on memory-constrained
    // machines, use the SSD temp dir instead so a large RAM disk never starves
    // the Metal engine and gets the job OOM-killed.
    const useRam = shouldUseRamDisk(realtime, meta);
    // Free any RAM disk left over from a previous (real-time) session so it
    // isn't holding onto physical memory during a full-resolution export.
    if (!useRam) releaseRam();
    const ramDir = useRam ? getRamDir() : null;
    if (ramDir) emit(onEvent, { type: 'log', message: 'Using RAM disk for intermediate frames.' });
    const tempDir = ramDir
      ? path.join(ramDir, `rife-${process.pid}-${Date.now()}`)
      : await fsp.mkdtemp(path.join(os.tmpdir(), 'rife-'));
    if (ramDir) job.ramDev = _ram ? _ram.dev : null;
    current.tempDir = tempDir;
    emit(onEvent, { type: 'tempdir', path: tempDir });
    const framesBase = path.join(tempDir, 'frames');
    const outBase = path.join(tempDir, 'out');
    await fsp.mkdir(framesBase, { recursive: true });
    await fsp.mkdir(outBase, { recursive: true });

    let finalOutput = output;
    if (realtime && !finalOutput) finalOutput = path.join(tempDir, 'stream_final.mp4');

    // Pre-create per-segment dirs so we can overlap extraction of the next
    // segment with RIFE+encode of the current one (keeps the GPU fed).
    for (const seg of segs) {
      seg.file = path.join(outBase, `seg_${String(seg.index).padStart(3, '0')}.mp4`);
      seg.framesDir = path.join(framesBase, String(seg.index));
      seg.outDir = path.join(outBase, String(seg.index));
      await fsp.mkdir(seg.framesDir, { recursive: true });
      await fsp.mkdir(seg.outDir, { recursive: true });
    }

    const segFiles = [];
    let nextExtract = null;
    let nextExtractErr = null;
    const doExtract = (seg) => extractSegment(input, seg, seg.framesDir, scale, effFormat, (n) => emitProgress('extract', Math.min(n, seg.count), seg.count));

    // 3-stage conveyor: extract(i) overlaps interpolate(i) overlaps encode(i-1).
    // Overlapping encode with the NEXT segment's interpolate is what keeps the
    // per-segment time under the real-time budget at 1080p (encode ~1s would
    // otherwise serialize after the ~1.7s interpolate and blow the 2s window).
    let prevSeg = null;
    let prevEncode = null;
    const awaitPrev = async () => {
      if (prevEncode) {
        try { await prevEncode; } catch (e) { prevEncode = null; throw e; }
        prevEncode = null;
      }
      if (prevSeg) {
        if (realtime) {
          emit(onEvent, {
            type: 'segment',
            index: prevSeg.index,
            total: segs.length,
            path: prevSeg.file,
            isLast: prevSeg.index === segs.length - 1,
            fps: effFps,
            durationSec: prevSeg.outFrames / effFps,
          });
        }
        segFiles.push(prevSeg.file);
        // The interpolated frames/PNGs are no longer needed once the MP4 segment
        // exists — drop them so the RAM disk doesn't fill up on long videos.
        try { await fsp.rm(prevSeg.framesDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { await fsp.rm(prevSeg.outDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        baseDone += prevSeg.outFrames;
        emitProgress('encode', prevSeg.outFrames, prevSeg.outFrames);
        prevSeg = null;
      }
    };

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (job.cancelled) throw { cancelled: true };

      // Reap the already-running extraction of this segment (overlapped with the
      // previous iteration's interpolate/encode), or extract it now.
      if (nextExtract) {
        await nextExtract;
        nextExtract = null;
        if (nextExtractErr) throw nextExtractErr;
      } else {
        await doExtract(seg);
      }
      if (job.cancelled) throw { cancelled: true };

      // Segment planning uses an *estimated* frame count (duration x fps), which
      // frequently overshoots the true end of a file — leaving an empty (or
      // 1-frame) trailing segment, or a short final segment with fewer frames
      // than planned. Reconcile against what actually got extracted:
      //   * 0-1 frames  -> skip the segment (can't interpolate a single frame),
      //   * fewer frames -> shrink outFrames so the tail keeps correct timing.
      let nExtracted = 0;
      try {
        nExtracted = (await fsp.readdir(seg.framesDir))
          .filter((f) => f.toLowerCase().endsWith(effFormat === 'jpeg' ? '.jpg' : '.png')).length;
      } catch (e) { /* dir missing -> treated as empty below */ }

      if (nExtracted < 2) {
        emit(onEvent, { type: 'log', message: `Skipping empty tail segment ${seg.index + 1}/${segs.length} (${nExtracted} frame${nExtracted === 1 ? '' : 's'}).` });
        baseDone += seg.count + seg.outFrames + seg.outFrames; // keep progress consistent
        try { await fsp.rm(seg.framesDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { await fsp.rm(seg.outDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        // Keep the conveyor fed: pre-extract the next segment.
        if (i + 1 < segs.length) {
          const nxt = segs[i + 1];
          nextExtract = doExtract(nxt).catch((e) => { nextExtractErr = e; });
        }
        continue;
      }

      if (nExtracted !== seg.count) {
        seg.count = nExtracted;
        seg.outFrames = Math.max(2, Math.round(nExtracted * mult));
      }

      emitProgress('extract', seg.count, seg.count);
      baseDone += seg.count;

      job.stage = 'interpolate';
      emit(onEvent, { type: 'stage', stage: 'interpolate', message: `Interpolating segment ${seg.index + 1}/${segs.length} (${engine})…` });
      const runOnce = () => runRife({
        inputDir: seg.framesDir, outputDir: seg.outDir, targetFrames: seg.outFrames,
        model: effModel, tier: effTier, format: effFormat, engine,
        ttaSpatial: effTtaS, ttaTemporal: effTtaT, uhd: effUhd, gpu,
        onFrame: (n) => emitProgress('interpolate', Math.min(n, seg.outFrames), seg.outFrames),
      });
      try {
        await runOnce();
      } catch (e) {
        // If the interpolator was killed (e.g. transient memory pressure while a
        // concurrent extract/encode was running), let that work drain, wait for
        // the OS to reclaim memory, then retry the segment once before failing.
        if (e && e.killed && !job.cancelled) {
          emit(onEvent, { type: 'log', message: `Interpolation was interrupted; freeing memory and retrying segment ${seg.index + 1}…` });
          try { await fsp.rm(seg.outDir, { recursive: true, force: true }); await fsp.mkdir(seg.outDir, { recursive: true }); } catch (_) { /* ignore */ }
          await new Promise((r) => setTimeout(r, 1500));
          if (job.cancelled) throw { cancelled: true };
          await runOnce();
        } else {
          throw e;
        }
      }
      if (job.cancelled) throw { cancelled: true };
      emitProgress('interpolate', seg.outFrames, seg.outFrames);
      baseDone += seg.outFrames;

      job.stage = 'encode';
      // Start encoding this segment in the background; it runs concurrently with
      // the NEXT segment's interpolate below.
      const encP = encodeSegment(seg.outDir, seg, outW, outH, effFps, gpuEncode, effFormat, () => {}, realtime);

      // Wait for the PREVIOUS segment's encode to finish, then hand it to the UI.
      await awaitPrev();

      // This segment becomes "previous" for the next iteration.
      prevSeg = seg;
      prevEncode = encP;

      // Kick off extraction of the next segment in the background so decode
      // overlaps the current segment's interpolate+encode.
      if (i + 1 < segs.length) {
        const nxt = segs[i + 1];
        nextExtract = doExtract(nxt).catch((e) => { nextExtractErr = e; });
      }
    }

    // Finalize the last segment (await its encode, emit, collect, clean up).
    await awaitPrev();

    if (!segFiles.length) {
      throw new Error('No frames could be read from the video — it may be truncated, empty, or use an unsupported codec.');
    }

    if (finalOutput) {
      job.stage = 'finalize';
      emit(onEvent, { type: 'stage', stage: 'finalize', message: 'Assembling final video…' });
      await concatSegments(segFiles, input, finalOutput, meta.hasAudio);
      if (job.cancelled) throw { cancelled: true };
      emit(onEvent, { type: 'log', message: `Saved to ${finalOutput}` });
    }

    emit(onEvent, {
      type: 'done',
      message: realtime ? 'Real-time playback finished' : `Done — saved to ${finalOutput || '(no output)'}`,
      output: finalOutput || (segFiles.length ? segFiles[segFiles.length - 1] : null),
      realtime,
    });

    // In realtime mode the player is still showing segments, so DON'T delete the
    // temp dir yet — main removes it (or detaches the RAM disk) when the player
    // is closed. For export we're done with it, so clean up now.
    if (!realtime) await cleanup();
    if (current === job) current = null;
  } catch (err) {
    if (err && err.cancelled) {
      emit(onEvent, { type: 'canceled', message: 'Job canceled' });
    } else {
      emit(onEvent, { type: 'error', message: err && err.message ? err.message : String(err) });
    }
    job.children.forEach((c) => { try { c.kill('SIGKILL'); } catch (e) { /* ignore */ } });
    if (!realtime) await cleanup();
    if (current === job) current = null;
  }
}

// Export mode: build a single interpolated file (segmented for speed, then
// concatenated). Used by the "Start conversion" batch button.
function startJob(opts, onEvent) {
  return runPipeline(opts, onEvent, { realtime: false });
}

// Realtime mode: play each finished segment as it is produced, while still
// assembling a full file for saving. Used by "Play real-time".
function startStream(opts, onEvent) {
  return runPipeline(opts, onEvent, { realtime: true });
}

function cancelJob() {
  if (current) {
    current.cancelled = true;
    current.children.forEach((c) => { try { c.kill('SIGTERM'); } catch (e) { /* ignore */ } });
  }
}

// Pause/resume the active conversion by suspending (SIGSTOP) / resuming
// (SIGCONT) the underlying ffmpeg / rife child processes. The progress and
// metrics naturally freeze while paused and continue on resume.
function pauseJob() {
  if (current && !current.paused) {
    current.paused = true;
    current.children.forEach((c) => { try { c.kill('SIGSTOP'); } catch (e) { /* ignore */ } });
  }
}

function resumeJob() {
  if (current && current.paused) {
    current.paused = false;
    current.children.forEach((c) => { try { c.kill('SIGCONT'); } catch (e) { /* ignore */ } });
  }
}

// Continuous, job-independent metrics snapshot. CPU is measured from the
// conversion child processes (so it reads ~0 when idle); GPU uses live
// powermetrics when available (system-wide, which during conversion is
// effectively the app's usage), otherwise the stage estimate; Media Engine
// is estimated from the active stage (no live per-app counter exists on macOS).
function getMetrics() {
  const job = current;
  const cpu = sampleCpu(job ? job.children : []);
  const est = estimateGpuMedia(job ? job.stage : 'idle');
  const real = !!(powerMetricsProc && lastGpu != null);
  const gpu = real ? lastGpu : (job ? est.gpu : 0);
  const media = job ? est.media : 0;
  const stage = job ? job.stage : 'idle';
  return {
    cpu: Math.round(cpu),
    gpu: Math.round(gpu),
    media: Math.round(media),
    stage,
    paused: !!(job && job.paused),
    gpuReal: real,
  };
}

module.exports = { startJob, startStream, cancelJob, pauseJob, resumeJob, getMetrics, startPowerMetrics, stopPowerMetrics, probeVideo, planSegments, releaseRam };
