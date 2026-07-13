"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const UNUSED_PRIVACY_KEYS = [
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

function deletePlistKey(infoPlist, keyPath) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${keyPath}`, infoPlist], {
      stdio: "ignore",
    });
  } catch {
    // Electron versions differ in their default Info.plist. Missing keys are
    // already in the desired state and should not fail a package build.
  }
}

/**
 * Keep the shipped macOS privacy declaration aligned with actual features.
 * Electron's stock bundle declares camera, microphone, and Bluetooth usage
 * even though Terminus requests none of those capabilities.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productName = context.packager.appInfo.productFilename;
  const infoPlist = path.join(context.appOutDir, `${productName}.app`, "Contents", "Info.plist");

  for (const key of UNUSED_PRIVACY_KEYS) deletePlistKey(infoPlist, key);
  deletePlistKey(infoPlist, "NSAppTransportSecurity:NSAllowsArbitraryLoads");
};

