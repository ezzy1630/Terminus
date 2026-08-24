# Terminus Desktop — Packaging

The desktop artifact is a standalone Electron shell around the Terminus
renderer. The shell owns window presentation and a small trusted native bridge;
the control plane and Rust kernel remain the authority for task effects,
filesystem access, process execution, secrets, and computer-use leases.

The renderer has no Node integration. Packaged windows use context isolation,
`sandbox: true`, and a preload bridge with origin and sender checks. Renderer
navigation and window opening are restricted to the trusted app entry point.

## Prerequisites

- macOS with the repository checkout and Bun dependencies installed.
- Xcode command-line tools for `xcrun`, `codesign`, and `plutil`.
- A Developer ID Application identity only for signed distribution.
- Apple ID, app-specific password, and team ID only for notarized distribution.

Do not package against a live production control plane. Use the local Terminus
control plane and kernel endpoints permitted by the desktop configuration.

## Build and package

From the repository root:

```bash
bun install
bun run --cwd apps/desktop build:electron
bun run --cwd apps/desktop package:dir
```

`build:electron` compiles the Electron main/preload TypeScript and builds the
renderer into `apps/desktop/dist`. `package:dir` builds the matching control and
kernel binaries, stages them under the ignored `node_modules/.cache` directory,
embeds the commit-bound runtime, disables signing-identity discovery, and asks
electron-builder for an unsigned local arm64 `.app` under
`apps/desktop/release/` without creating a DMG. The recipe verifies the
packaged runtime before it succeeds. `package` performs the same process for
arm64 and x64 distribution containers, but those local containers remain
unsigned and are not releases:

```bash
bun run --cwd apps/desktop package
```

Local artifacts record `terminusBuildKind: "local"` in packaged metadata and
`build_kind: "local"` in the runtime manifest. A dirty control manifest remains
truthful and is accepted only under that unsigned local contract. Release CI
sets both values to `release` and rejects dirty source identity.

The ASAR includes only `dist/**/*`, `dist-electron/**/*`, and package metadata.
Renderer libraries are compiled into `dist`; no runtime `node_modules` or
workspace source tree enters the app. electron-builder adds the selected
standalone control and kernel distribution at `Contents/Resources/runtime` as
an external resource. The `afterPack` hook removes unused camera, microphone,
Bluetooth, and arbitrary-transport declarations from the generated Info.plist.

The directory recipe is deliberately unsigned, so local inspection never waits
on a signing keychain:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false bun run --cwd apps/desktop package:dir
```

This is suitable for local artifact inspection only. It is not a release.

## Artifact checks

Run these checks against the exact fresh output. A build passing is not proof
that the bundle is safe or current.

```bash
APP="apps/desktop/release/mac-arm64/Terminus.app"
ASAR="$APP/Contents/Resources/app.asar"
plutil -p "$APP/Contents/Info.plist"
npx asar list "$ASAR"
rg -a -n "node-pty|desktopCapturer|mediaDevices|URL\.createObjectURL|OpenCode|open-code|opencode|TerminalDrawer" "$ASAR" || true
```

The scan should not find retired harness/runtime dependencies. If a match is
intentional, identify the owning source path and review it before distribution;
do not hide it by scanning only generated JavaScript or by accepting a stale
release directory. The ASAR listing should contain only `/dist`,
`/dist-electron`, and `/package.json`; `app.asar.unpacked` should not exist.
Inspect the archive identity and mtime when multiple artifacts exist. Verify
the `ElectronAsarIntegrity` value in Info.plist against the fresh ASAR header;
electron-builder records the header hash, not the whole-file hash.

`package:dir` is deliberately unsigned. A strict `codesign --verify` result is
therefore a signed-release check, not a local directory-build check.

For a signed release, also verify the designated signing identity and
notarization ticket:

```bash
codesign -dv --verbose=4 "$APP" 2>&1 | sed -n '1,24p'
xcrun notarytool submit apps/desktop/release/Terminus-<version>-arm64.zip \
  --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"
DMG="apps/desktop/release/Terminus-<version>-arm64.dmg"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
```

The release workflow injects the validated tag version into Electron metadata,
asserts both architecture-specific artifact names and bundle versions, and
separately submits and staples each DMG after electron-builder notarizes its
enclosed app. These commands require credentials and are distribution gates,
not local-build checks. Never put credentials in this document, shell history,
or artifacts.

## Fresh-surface smoke test

Launch the exact packaged `.app` and verify:

1. The app identity is Terminus and the renderer is the newly built artifact.
2. The native window opens with the integrated draggable title bar, native
   menu, restored bounds, and docked resizable sidebar and inspector.
3. A local control-plane health result is shown truthfully as ready, offline,
   or reconnecting.
4. Project/task loading, conversation, approvals, Changes, inspector,
   Settings, onboarding, and cockpit empty/error states remain operable.
5. The active task updates the native window title and a dropped local folder
   opens the validated project sheet.
6. The packaged app cannot navigate away from the trusted renderer or open an
   untrusted child window.

Record the artifact path, architecture, version, source revision, and exact
checks performed. Do not call an unsigned local directory build a release.

## Troubleshooting

- **Renderer is stale:** remove only the generated `apps/desktop/dist` and
  `dist-electron` outputs through the build recipe, then rerun
  `build:electron`; confirm the bundle mtime and source identity.
- **Builder cannot sign:** install/select the intended Developer ID identity or
  use `package:dir` for local unsigned inspection.
- **Notarization fails:** inspect the notary log, verify the bundle was signed
  before zipping, and rerun the artifact checks after fixing the cause.
- **Control plane is offline:** treat it as an environment state. Do not bake
  credentials, local success fixtures, or a fallback provider into the app.
