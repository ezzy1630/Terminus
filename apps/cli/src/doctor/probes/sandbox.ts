import { existsSync } from "node:fs";
import type { ProbeResult } from "../types.js";

export function probeSandbox(): ProbeResult[] {
  const results: ProbeResult[] = [];
  const platform = process.platform;
  const arch = process.arch;

  // 1. Host Platform Identification
  results.push({
    id: "sandbox.platform",
    name: "Host Platform Identification",
    status: "pass",
    message: `Running on ${platform}-${arch}`,
    details: { platform, arch },
    isProductionInvariant: false,
  });

  // 2. OS-Level Containment Mechanisms
  if (platform === "linux") {
    const hasUserNs = existsSync("/proc/self/ns/user");
    const hasMntNs = existsSync("/proc/self/ns/mnt");
    const hasBwrap =
      existsSync("/usr/bin/bwrap") ||
      existsSync("/bin/bwrap") ||
      existsSync("/usr/local/bin/bwrap");

    if (hasBwrap && hasUserNs && hasMntNs) {
      results.push({
        id: "sandbox.containment",
        name: "Linux Namespaces & Bubblewrap Containment",
        status: "pass",
        message: "Linux user/mount namespaces and bubblewrap binary are available",
        details: { hasBwrap, hasUserNs, hasMntNs },
        isProductionInvariant: true,
      });
    } else {
      results.push({
        id: "sandbox.containment",
        name: "Linux Namespaces & Bubblewrap Containment",
        status: "warn",
        message: `Incomplete Linux isolation: bwrap=${hasBwrap}, userNs=${hasUserNs}, mntNs=${hasMntNs}`,
        recommendation: "Install `bubblewrap` (bwrap) and ensure user namespaces are enabled",
        details: { hasBwrap, hasUserNs, hasMntNs },
        isProductionInvariant: true,
      });
    }
  } else if (platform === "darwin") {
    const hasSandboxExec =
      existsSync("/usr/bin/sandbox-exec") ||
      existsSync("/bin/sandbox-exec");

    results.push({
      id: "sandbox.containment",
      name: "macOS Seatbelt Sandbox Containment",
      status: "warn",
      message: hasSandboxExec
        ? "macOS sandbox-exec is available (Seatbelt profiles are preview/experimental per ADR-0035)"
        : "macOS sandbox-exec binary not found",
      details: { platform: "darwin", hasSandboxExec, status: "degraded_declared" },
      recommendation: "macOS Seatbelt backend is experimental; production profile requires Linux namespace enforcement evidence",
      isProductionInvariant: true,
    });
  } else {
    results.push({
      id: "sandbox.containment",
      name: "OS Containment Boundary",
      status: "warn",
      message: `Platform ${platform} has no native sandbox implementation (classified as stub/degraded)`,
      details: { platform, status: "unsupported" },
      recommendation: "Use Linux with bubblewrap for production-grade effect isolation",
      isProductionInvariant: true,
    });
  }

  return results;
}
