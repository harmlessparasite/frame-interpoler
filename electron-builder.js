// electron-builder configuration for RIFE 60fps Converter.
// Notarization runs automatically when Apple credentials are exported:
//   export APPLE_ID="you@me.com"
//   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
//   export APPLE_TEAM_ID="XXXXXXXXXX"
// Without them the app builds & signs locally (Developer ID optional) but is
// not notarized, so Gatekeeper will block it on other machines.
const hasAppleCreds = !!(process.env.APPLE_ID && (process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_API_KEY));

module.exports = {
  appId: 'com.rife60.converter',
  productName: 'Frame Interpoler',
  icon: 'build/icon.icns',
  // Ship only our own source + the bundled binaries. node_modules is excluded
  // entirely (we bundle ffmpeg/ffprobe/rife ourselves via extraResources, so the
  // ffmpeg-static/ffprobe-static npm binaries must NOT be packaged — they add
  // ~280 MB of redundant cross-platform binaries).
  files: ['**/*', '!bin/**', '!node_modules/**'],
  extraResources: ['bin/**'],
  mac: {
    category: 'public.app-category.video',
    target: [{ target: 'dmg', arch: 'arm64' }],
    // Notarization-ready: hardened runtime + gatekeeper assessment disabled.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Auto-discovers a "Developer ID Application" cert; enable notarize when creds exist.
    notarize: hasAppleCreds ? { teamId: process.env.APPLE_TEAM_ID } : false,
  },
  directories: { output: 'dist' },
};
