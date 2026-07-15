#!/usr/bin/env bash
# Downloads the official rife-ncnn-vulkan release (universal x86_64+arm64 binary)
# and its models into bin/macos so the Electron app can run natively on Apple Silicon.
set -euo pipefail
cd "$(dirname "$0")"

PLATFORM="macos"
BIN="bin/$PLATFORM"
mkdir -p "$BIN"

# Latest stable release that ships the rife-v4.6 model used by default.
TAG="20221029"
URL="https://github.com/nihui/rife-ncnn-vulkan/releases/download/${TAG}/rife-ncnn-vulkan-${TAG}-macos.zip"

echo "Downloading rife-ncnn-vulkan (macOS)…"
curl -L -o /tmp/rife-ncnn-vulkan.zip "$URL"

echo "Extracting…"
TMP="$(mktemp -d)"
unzip -o /tmp/rife-ncnn-vulkan.zip -d "$TMP" >/dev/null
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'rife-ncnn-vulkan-*' | head -n1)"
cp -R "$SRC/." "$BIN/"

chmod +x "$BIN/rife-ncnn-vulkan"
# Remove the quarantine flag so macOS Gatekeeper allows the unsigned binary to run.
xattr -dr com.apple.quarantine "$BIN" 2>/dev/null || true

rm -rf "$TMP" /tmp/rife-ncnn-vulkan.zip

# Bundle static ffmpeg + ffprobe (so the GUI app does not depend on a system
# ffmpeg on PATH). Sourced from the ffmpeg-static / ffprobe-static npm packages.
echo "Bundling ffmpeg / ffprobe…"
cp node_modules/ffmpeg-static/ffmpeg "$BIN/ffmpeg"
cp "$(node -e "console.log(require('ffprobe-static').path)" 2>/dev/null)" "$BIN/ffprobe"
chmod +x "$BIN/ffmpeg" "$BIN/ffprobe"
xattr -dr com.apple.quarantine "$BIN/ffmpeg" "$BIN/ffprobe" 2>/dev/null || true

echo "Done. Engine + models + ffmpeg/ffprobe are in $BIN"
echo "Tip: if macOS still blocks it, run:  xattr -dr com.apple.quarantine \"$PWD/$BIN\""
