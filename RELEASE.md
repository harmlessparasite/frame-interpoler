# Frame Interpoler

A native macOS (Apple Silicon) app that converts videos to smooth 60+ fps
locally using the open-source RIFE AI frame-interpolation model. No cloud, no
terminal, no SVP — just drop a video and watch it become fluid.

## Highlights

- **Real-time smooth playback** — hit *Play real-time* to watch your video
  interpolated live. Segments are buffered into one continuous, gapless
  MediaSource stream (no re-loading every couple of seconds). Runs on the
  native Apple **Metal** RIFE engine (Practical-RIFE v4.26) and auto-downscales
  sources above 1080p so playback keeps pace.
- **Full-quality export** — *Start conversion* produces a full-resolution 60
  fps (or 48/120 fps) MP4 using VideoToolbox GPU encoding.
- **Batch queue** — drop or pick multiple files; they convert one after another.
  Remove any queued/finished item with the `✕` button, or stop the one in
  progress.
- **Save the stream** — keep a copy of the real-time result as a 60 fps file
  from inside the player.
- **Live utilization** — CPU / GPU / Media Engine graphs stay live even when
  idle. Click *Live GPU* (one-time sudo) for real hardware readings instead of
  estimates.

## What's new in this release

- **Renamed the app to "Frame Interpoler."**
- **Full-screen real-time player** — new `⛶` button in the player controls
  toggles native full-screen playback of the smooth stream.
- **Remove items from the queue** — each queue row now has a `✕` button. It
  removes queued/finished items; for the item currently processing it stops the
  job and removes it.

## Reliability fixes

- **Out-of-memory handling** — the interpolator no longer dies silently with
  `exit null`. The RAM disk for intermediate frames is now reserved for
  real-time mode only (and only on machines with ≥12 GB RAM); full-resolution
  export always writes to the SSD. A killed segment is retried once after
  memory is reclaimed, and a clear "out of memory" message is shown on failure.
- **Trailing-segment crash fixed** — conversion no longer fails at the end with
  *"interpolation needs at least 2 source frames but found 0 in this segment."*
  Over-estimated frame counts are now reconciled against what was actually
  extracted; empty tail segments are skipped and short ones keep correct timing.
- **Real error reporting** — the interpolator's stderr/stdout tail is captured
  and surfaced, so failures explain themselves instead of showing a bare
  `exit null`.

## System requirements

- macOS on Apple Silicon (M1/M2/M3/M4).
- The app is currently distributed **unsigned** (no Developer ID / notarization).
  On first launch, if macOS blocks it, allow it from System Settings → Privacy &
  Security, or run:
  `xattr -dr com.apple.quarantine "/Applications/Frame Interpoler.app"`

## Installing

1. Download `Frame Interpoler-<version>-arm64.dmg`.
2. Open it and drag **Frame Interpoler** to Applications.
3. Launch it. If Gatekeeper complains, see the note above.
