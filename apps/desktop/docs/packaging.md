# Terminus Desktop — Packaging Guide

This document describes how to build, sign, notarize, and package the
Terminus desktop application for macOS.

## Current verification evidence

On 2026-07-13, the Apple Silicon application bundle was built from the
repository root with:

```bash
pnpm --filter @terminus/desktop build:electron
pnpm --filter @terminus/desktop package:dir
codesign --verify --deep --strict apps/desktop/release/mac-arm64/Terminus.app
```

`electron-builder` rebuilt `node-pty` for arm64, produced
`apps/desktop/release/mac-arm64/Terminus.app`, and signed it with the available
distribution identity. Strict deep signature verification passed. Notarization
was skipped because notarization credentials/options were not configured; this
is still required for external distribution. A fresh manual launch and visual
walkthrough are also required before declaring the packaged-app gate complete.

## 1. Prerequisites

- macOS 13 or later (Ventura or newer).
- Node.js 22+ and Bun 1.3+ (install via `mise install` or
  `brew install bun`).
- Apple Developer ID Application certificate (for distribution
  outside the Mac App Store).
- Apple Developer ID Installer certificate (optional, for pkg
  installers).
- `xcrun notarytool` credentials (App Store Connect API key or Apple
  ID with app-specific password) for notarization.
- `create-dmg` (installed automatically by electron-builder).

## 2. Build

The desktop app is a Vite + React 19 renderer plus an Electron 33
main process. The build produces a `dist/` directory (renderer) and a
`dist-electron/` directory (compiled main + preload).

```bash
cd apps/desktop

# Install dependencies (only needed once or after package.json changes).
bun install

# Type-check the renderer + tests.
bunx tsc --noEmit -p tsconfig.json

# Run the test suite (unit + integration if the control plane is up).
bunx vitest run

# Build the renderer (Vite) + compile the Electron main (tsc).
bun run build
```

The `bun run build` script in `package.json` runs `tsc -b && vite build`.
The `tsc -b` step uses the project references in `tsconfig.json` and
`electron/tsconfig.json` to compile the main process TypeScript to
`dist-electron/`. The `vite build` step bundles the renderer into
`dist/`.

Outputs:

- `dist/index.html` — Vite entry HTML.
- `dist/assets/index-<hash>.js` — the renderer bundle.
- `dist/assets/index-<hash>.css` — the renderer styles.
- `dist-electron/main.js` — the Electron main process.
- `dist-electron/preload.js` — the Electron preload script.

## 3. Package

`electron-builder` produces the macOS app bundle, DMG, and zip.

```bash
cd apps/desktop

# Produce release/Terminus-0.1.0-arm64.dmg and release/Terminus-0.1.0-arm64.zip
bun run package

# Or produce just the .app bundle (faster, no DMG):
bun run package:dir
```

The `package` script in `package.json` runs:

```
electron-builder --mac --arm64
```

The build configuration lives in `package.json` under the `"build"`
key:

```json
{
  "build": {
    "appId": "dev.terminus.desktop",
    "productName": "Terminus",
    "directories": { "output": "release" },
    "afterPack": "electron/after-pack.cjs",
    "mac": {
      "icon": "assets/icon.icns",
      "category": "public.app-category.developer-tools",
      "target": [
        { "target": "dmg", "arch": ["arm64", "x64"] },
        { "target": "zip", "arch": ["arm64", "x64"] }
      ],
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "electron/entitlements.mac.plist",
      "entitlementsInherit": "electron/entitlements.mac.plist"
    },
    "files": ["dist/**/*", "dist-electron/**/*"]
  }
}
```

The checked-in `assets/icon.svg` is the editable source for the native
`assets/icon.icns` bundle. The `afterPack` hook also removes Electron's
generic camera, microphone, Bluetooth, and arbitrary-network privacy keys
from the final `Info.plist`; Terminus must not advertise capabilities it does
not use.

This produces both arm64 (Apple Silicon) and x64 (Intel) builds. For
a faster build during development, target only the host architecture:

```bash
bunx electron-builder --mac --arm64 --dir
```

Outputs (under `release/`):

- `mac-arm64/Terminus.app` — the app bundle.
- `Terminus-0.1.0-arm64.dmg` — the disk image installer.
- `Terminus-0.1.0-arm64-mac.zip` — the zipped app bundle (used for
  notarization).

## 4. Entitlements

The entitlements file at `electron/entitlements.mac.plist` requests
the minimum set of capabilities needed by Terminus:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-libsystem-validation</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <false/>
</dict>
</plist>
```

| Entitlement | Why |
| ----------- | --- |
| `cs.allow-jit` | Electron's V8 uses JIT compilation for JavaScript. Required. |
| `cs.allow-unsigned-executable-memory` | Electron loads unsigned native modules (e.g. context isolation bridge). Required. |
| `cs.disable-libsystem-validation` | Allows Electron to load its own bundled libraries without per-library signature checks. Required. |
| `network.client` | Terminus talks to the control plane at `http://127.0.0.1:3050` and the kernel at `:3040`. Required. |
| `network.server` | Terminus does not listen on any port. Explicitly `false`. |

The app does **not** request:

- `cs.disable-library-validation` (kept enabled — we want library
  validation where possible).
- `files.user-selected.read-write` (the desktop app doesn't directly
  read user-selected files; the harness does that via the kernel).
- `device.audio-input` / `device.camera` (not used by Terminus).
- `apple-events` (not used).

Electron's stock application bundle includes camera, microphone, Bluetooth,
and unrestricted-network usage descriptions. The `electron/after-pack.cjs`
hook removes those unused declarations and the broad
`NSAllowsArbitraryLoads` flag before signing. Localhost exceptions remain for
the Terminus control plane. Verify this on every packaged artifact with:

```bash
plutil -p release/mac-arm64/Terminus.app/Contents/Info.plist | \
  rg 'NS(Camera|Microphone|Bluetooth)|NSAllowsArbitraryLoads'
```

Expected: no output.

## 5. Code signing

### 5.1 Set up environment variables

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # app-specific password
export APPLE_TEAM_ID="ABC1234567"
export CSC_LINK="file:///path/to/DeveloperIDApplication.p12"  # or keychain name
export CSC_KEY_PASSWORD="your-p12-password"
```

For CI, store these as secrets. For local signing, the Apple Developer
ID Application certificate is usually in the login keychain —
`electron-builder` will find it automatically if `CSC_NAME` is set to
the certificate's name (e.g. `"Developer ID Application: You (ABC1234567)"`).

### 5.2 Sign the app

`electron-builder` signs the app bundle automatically when it detects
a signing identity. To force signing:

```bash
export CSC_NAME="Developer ID Application: You (ABC1234567)"
bun run package
```

The output should include:

```
signing         file=release/mac-arm64/Terminus.app
```

To verify the signature:

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Terminus.app
```

Expected: `Terminus.app: valid on disk` and `Terminus.app: satisfies its
Designated Requirement`.

To inspect the entitlements:

```bash
codesign -d --entitlements - release/mac-arm64/Terminus.app
```

## 6. Notarization

### 6.1 Submit for notarization

After signing, submit the zipped app bundle to Apple's notary service:

```bash
# Submit the zip via notarytool (recommended — uses App Store Connect API key).
xcrun notarytool submit release/Terminus-0.1.0-arm64-mac.zip \
  --keychain-profile "terminus-notarize" \
  --wait
```

The `--keychain-profile` is created once via:

```bash
xcrun notarytool store-credentials "terminus-notarize" \
  --apple-id "you@example.com" \
  --team-id "ABC1234567" \
  --password "app-specific-password"
```

The `--wait` flag blocks until notarization completes (typically
2–10 minutes). On success, you'll see `status: Accepted`.

### 6.2 Staple the notarization ticket

```bash
xcrun stapler staple release/mac-arm64/Terminus.app
xcrun stapler verify release/mac-arm64/Terminus.app
```

Expected: `The validate action worked!`.

### 6.3 Verify the full chain

```bash
spctl --assess --type execute --verbose release/mac-arm64/Terminus.app
```

Expected: `release/mac-arm64/Terminus.app: accepted` with
`source=Notarized Developer ID`.

### 6.4 Automate via electron-builder

`electron-builder` can perform notarization automatically if the
environment variables are set. Add to `package.json`:

```json
{
  "build": {
    "mac": {
      "notarize": {
        "teamId": "ABC1234567"
      }
    }
  }
}
```

Then `bun run package` will sign + notarize + staple in one step.

## 7. Build the DMG

`electron-builder` produces the DMG as part of the `package` step. To
customize the DMG layout (background, icon positions), add to
`package.json`:

```json
{
  "build": {
    "dmg": {
      "title": "Terminus ${version}",
      "contents": [
        { "x": 130, "y": 220 },
        { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
      ]
    }
  }
}
```

The default DMG is fine for most uses.

## 8. Test the packaged app

```bash
# Open the packaged app (it will use the production Electron binary).
open release/mac-arm64/Terminus.app
```

Verify:

- The app launches without a "downloaded from the internet" warning
  (if notarization succeeded).
- The title bar shows the macOS traffic lights at (16, 18).
- The window is sized to 88% of the work area (SPEC §5).
- The control plane health dot in the title bar is green (assumes
  `http://127.0.0.1:3050` is reachable).
- ⌘K opens the command palette.
- ⌘, opens settings.
- ⌘` opens the terminal drawer.
- Theme and density toggles work without restart.

### Latest local verification attempt (2026-07-12)

The arm64 directory build was attempted with:

```bash
PYTHON=/usr/bin/python3 npm_config_python=/usr/bin/python3 bun run package:dir
```

The explicit system Python is required because Homebrew Python 3.14 does not
provide `distutils`, which the current `node-gyp` release still imports. With
`/usr/bin/python3`, the `node-pty` rebuild completes successfully.

The current builder then stalls after reporting:

```text
packaging platform=darwin arch=arm64 electron=33.4.11 appOutDir=...
```

This was reproduced with a fresh Electron download, a clean output directory,
and output on both `/Volumes/Neural` and `/tmp`. Only an intermediate
`Electron.app` is produced; no `Terminus.app` is completed. Packaged launch
verification therefore remains blocked and must not be reported as passing.

## 9. Distribution

### Direct download

Upload `release/Terminus-0.1.0-arm64.dmg` to your distribution URL
(e.g. GitHub Releases). Users on Apple Silicon download the `-arm64`
DMG; users on Intel download the `-x64` DMG. A universal DMG can be
produced by passing `--arch universal` but doubles the size.

### Auto-update (future)

`electron-builder` supports auto-update via `electron-updater`. The
desktop app does not yet wire this up — it's planned for a future
release. The plan:

1. Publish `latest-mac.yml` alongside each release.
2. Add `electron-updater` to the renderer's main process.
3. Check for updates on app launch + every 4 hours.
4. Prompt the user to download + install.

## 10. Troubleshooting

### "Code signature verification failed"

- Ensure the Apple Developer ID Application certificate is in the
  login keychain.
- Run `security find-identity -v -p codesigning` to list available
  identities.
- Set `CSC_NAME` to the exact certificate name.

### "Notarization failed: bundle format is invalid"

- Ensure you're submitting the `.zip` (not the `.dmg`) for
  notarization. The DMG can be notarized but the zip is the canonical
  format.
- Ensure the app bundle is signed before zipping.

### "The app can't be opened because Apple cannot check it for
malicious software"

- Notarization failed or wasn't stapled. Run `xcrun stapler verify`
  and `spctl --assess` to diagnose.

### "Electron failed to load because the file is damaged"

- This usually means Gatekeeper quarantined the app. Run:
  ```bash
  xattr -d com.apple.quarantine release/mac-arm64/Terminus.app
  ```
  This is only for local testing — the quarantine flag is removed by
  notarization for end users.

### Build fails with "lipo: can't open input file"

- The arm64 and x64 builds are conflicting. Delete `release/` and
  `dist-electron/` and try again.

### Vite build picks up the parent Next.js PostCSS config

- Ensure `apps/desktop/postcss.config.mjs` exists (it does — created
  in D5). The Vite config in `vite.config.ts` explicitly disables
  PostCSS plugins via `css: { postcss: { plugins: [] } }` and uses
  the `@tailwindcss/vite` plugin instead.

## 11. CI pipeline (reference)

A minimal GitHub Actions workflow for build + sign + notarize:

```yaml
name: package-macos
on:
  push:
    tags: ["v*"]
jobs:
  macos:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: cd apps/desktop && bun install
      - run: cd apps/desktop && bunx tsc --noEmit -p tsconfig.json
      - run: cd apps/desktop && bunx vitest run
      - run: cd apps/desktop && bun run build
      - name: Import signing certificate
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
        run: |
          echo "$CSC_LINK" | base64 -d > cert.p12
          security create-keychain -p "" build.keychain
          security import cert.p12 -k build.keychain -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" build.keychain
      - name: Package + notarize
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: cd apps/desktop && bun run package
      - uses: actions/upload-artifact@v4
        with:
          name: Terminus-macos
          path: apps/desktop/release/*.dmg
```

## 12. Version policy

The app version lives in `apps/desktop/package.json` as `"version":
"0.1.0"`. Bump it before each release:

- Patch (`0.1.0` → `0.1.1`): bug fixes only.
- Minor (`0.1.0` → `0.2.0`): new features, no breaking changes.
- Major (`0.1.0` → `1.0.0`): breaking changes (UI rework, API
  contract changes).

The DMG filename is `Terminus-<version>-<arch>.dmg` (e.g.
`Terminus-0.1.0-arm64.dmg`). The notarization ticket is bound to the
version — re-notarize after every bump.
