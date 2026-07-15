// Standalone test harness for the streaming pipeline. Runs in Node (electron's
// module is required by lib/process but we only use the child-process paths).
// Validates: segmentation, per-segment RIFE interpolation, fmp4 encoding, and
// final concat — for BOTH realtime (startStream) and export (startJob) modes.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ffmpeg = path.join(__dirname, '..', 'bin', 'macos', 'ffmpeg');
const rife = require('../lib/process');

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
  } catch (e) {
    console.error('Command failed:', cmd, args.join(' '));
    throw e;
  }
}

async function probe(p) {
  return rife.probeVideo(p);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rife-test-'));
  const clip = path.join(tmp, 'src.mp4');
  // 4s, 30fps, 320x240, with motion so interpolation has something to do.
  // 30fps -> 2x realtime = 60fps, matching the 60 target so both modes align.
  run(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-pix_fmt', 'yuv420p', clip,
  ]);
  const sp = await probe(clip);
  console.log('Source clip:', clip, `${sp.width}x${sp.height} ${sp.fps.toFixed(2)}fps ${sp.frames}f`, 'dur', sp.duration.toFixed(2));

  // --- realtime mode ---
  const rtOut = path.join(tmp, 'rt_final.mp4');
  let segCount = 0;
  const t0 = Date.now();
  await rife.startStream({
    input: clip, output: rtOut, targetFps: 60, model: 'rife-v4.6', gpu: 'auto', gpuEncode: true,
  }, (evt) => {
    if (evt.type === 'segment') { segCount++; console.log(`  segment ${evt.index} ready`); }
    else if (evt.type === 'stage') console.log('   ', evt.message);
    else if (evt.type === 'error') { console.error('  ERROR', evt.message); process.exit(1); }
    else if (evt.type === 'done') console.log('  realtime done:', evt.output, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'segments', segCount);
  });
  const rt = await probe(rtOut);
  console.log('Realtime final:', `${rt.width}x${rt.height} ${rt.fps.toFixed(2)}fps dur ${rt.duration.toFixed(2)}s frames ${rt.frames}`);

  // --- export mode ---
  const exOut = path.join(tmp, 'export.mp4');
  await rife.startJob({
    input: clip, output: exOut, targetFps: 60, model: 'rife-v4.6', gpu: 'auto', gpuEncode: true,
  }, (evt) => {
    if (evt.type === 'error') { console.error('  EXPORT ERROR', evt.message); process.exit(1); }
    else if (evt.type === 'done') console.log('  export done:', evt.output);
  });
  const ex = await probe(exOut);
  console.log('Export:', `${ex.width}x${ex.height} ${ex.fps.toFixed(2)}fps dur ${ex.duration.toFixed(2)}s frames ${ex.frames}`);

  // Sanity: both should be ~60fps, ~4s, and have far more frames than source (96).
  const ok = rt.frames > 150 && ex.frames > 150
    && Math.abs(rt.duration - 4) < 0.6
    && Math.abs(ex.duration - 4) < 0.6
    && Math.abs(rt.fps - 60) < 2;
  console.log(ok ? '\nPIPELINE TEST PASS' : '\nPIPELINE TEST FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
