# Frame Interpoler

A native macOS (Apple Silicon) app that converts videos to smooth **60+ fps**
locally using the open-source **RIFE** AI frame-interpolation model. No cloud,
no terminal, no SVP — just drop a video and watch it become fluid.

![release](https://img.shields.io/badge/release-v1.0.0-blue)

## Features

- **Real-time smooth playback** — hit *Play real-time* to watch your video
  interpolated live. Segments are buffered into one continuous, gapless
  MediaSource stream (no re-loading every couple of seconds). Runs on the
  native Apple **Metal** RIFE engine (Practical-RIFE v4.26) and auto-downscales
  sources above 1080p so playback keeps pace.
- **Full-quality export** — *Start conversion* produces a full-resolution 60 fps
  (or 48/120 fps) MP4 using VideoToolbox GPU encoding.
- **Batch queue** — drop or pick multiple files; they convert one after another.
  Remove any queued/finished item with the `✕` button, or stop the one in
  progress.
- **Full-screen player** — the `⛶` button toggles native full-screen playback
  of the real-time stream.
- **Save the stream** — keep a copy of the real-time result as a 60 fps file
  from inside the player.
- **Live utilization** — CPU / GPU / Media Engine graphs stay live even when
  idle. Click *Live GPU* (one-time sudo) for real hardware readings.

## Download

Get the latest `.dmg` from the
[Releases](https://github.com/harmlessparasite/frame-interpoler/releases) page
and drag **Frame Interpoler** to Applications.

> The app is distributed **unsigned** (no Developer ID / notarization). On first
> launch, if macOS blocks it, allow it from **System Settings → Privacy &
> Security**, or run:
>
> ```sh
> xattr -dr com.apple.quarantine "/Applications/Frame Interpoler.app"
> ```

## Requirements

- macOS on Apple Silicon (M1/M2/M3/M4).
- ~600 MB free space for the bundled RIFE engine and models.

## Building from source

```sh
git clone https://github.com/harmlessparasite/frame-interpoler.git
cd frame-interpoler
npm install
bash download-assets.sh   # fetches bin/macos (rife-metal-batch, ffmpeg, models)
npm run pack              # unsigned .app in dist/mac-arm64
npm run dist              # signed-less .dmg in dist/
```

## Project layout

| Path | Purpose |
| --- | --- |
| `main.js` | Electron main process, IPC, dialogs. |
| `renderer.js` | UI, queue, and the gapless MSE real-time player. |
| `index.html` | App markup and styles. |
| `preload.js` | Context-isolated bridge to the main process. |
| `lib/process.js` | Conversion pipeline (extract → interpolate → encode → concat). |
| `bin/macos/` | Bundled native binaries and RIFE models (git-ignored). |
| `electron-builder.js` | Packaging / DMG configuration. |

## License

MIT
