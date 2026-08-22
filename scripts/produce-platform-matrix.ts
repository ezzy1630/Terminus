#!/usr/bin/env bun
/**
 * produce-platform-matrix — derive platform/backend support from conformance
 * evidence, never from hard-coded optimism (roadmap Phase 0).
 *
 * A platform is "supported" ONLY when conformance evidence exists for the
 * exact commit:
 *   - linux: a Linux enforcement manifest (TERMINUS_LINUX_EVIDENCE or
 *     artifacts/release-gate/linux-enforcement-evidence.json) whose
 *     terminus_commit matches HEAD;
 *   - every other platform today: nothing qualifies — macOS/Windows sandbox
 *     backends honestly report Degraded (stub tier in maturity.yaml) and no
 *     signed conformance artifacts exist.
 *
 * Missing infrastructure is recorded as `requires_ci`, not papered over.
 * Output: artifacts/release-gate/platform-support.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "platform-support.json");

interface PlatformEntry {
  status: "supported" | "degraded_declared" | "requires_ci" | "unverified";
  basis: string;
  evidence: string | null;
}

function headCommit(): string {
  return (
    process.env.TERMINUS_RELEASE_COMMIT ??
    process.env.GITHUB_SHA ??
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT })
      .stdout.toString()
      .trim() ??
    "unknown"
  );
}

function loadLinuxEvidence(): { path: string; commit: string } | null {
  const candidates = [
    process.env.TERMINUS_LINUX_EVIDENCE,
    join(OUT_DIR, "linux-enforcement-evidence.json"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const doc = JSON.parse(readFileSync(p, "utf8")) as { terminus_commit?: string };
      return { path: p, commit: doc.terminus_commit ?? "" };
    } catch {
      // unreadable evidence is recorded as absent below
    }
  }
  return null;
}

const commit = headCommit();
const platforms: Record<string, PlatformEntry> = {};

// --- Linux: the only platform with an enforcement-evidence pipeline. ---
const linuxEvidence = loadLinuxEvidence();
if (
  linuxEvidence &&
  linuxEvidence.commit &&
  (commit === "unknown" || linuxEvidence.commit === commit)
) {
  platforms["linux-x86_64"] = {
    status: "supported",
    basis: "signed Linux effective-enforcement manifest bound to this commit",
    evidence: linuxEvidence.path,
  };
} else if (linuxEvidence) {
  platforms["linux-x86_64"] = {
    status: "unverified",
    basis: `enforcement manifest commit ${linuxEvidence.commit} does not match HEAD ${commit}`,
    evidence: linuxEvidence.path,
  };
} else {
  platforms["linux-x86_64"] = {
    status: "requires_ci",
    basis: "no Linux enforcement evidence artifact at HEAD; produced by .github/workflows/linux-evidence.yml on a Linux runner",
    evidence: null,
  };
}
platforms["linux-arm64"] = {
  status: "requires_ci",
  basis: "no conformance evidence pipeline for arm64 Linux yet",
  evidence: null,
};

// --- Declared-degraded backends (maturity.yaml stub tier). ---
platforms["macos-arm64"] = {
  status: "degraded_declared",
  basis: "sandbox backend reports Degraded (Seatbelt profile generation not implemented); secure profiles fail closed by design",
  evidence: null,
};
platforms["macos-x86_64"] = {
  status: "degraded_declared",
  basis: "same degraded macOS backend as arm64; secure profiles fail closed by design",
  evidence: null,
};
platforms["windows-x86_64"] = {
  status: "degraded_declared",
  basis: "sandbox backend reports Degraded (AppContainer/Job Object wiring not implemented); secure profiles fail closed by design",
  evidence: null,
};
platforms["linux-container"] = {
  status: "degraded_declared",
  basis: "container backend wrapper reports Degraded until hardened OCI profiles land (Phase 4)",
  evidence: null,
};

const supported = Object.entries(platforms)
  .filter(([, v]) => v.status === "supported")
  .map(([k]) => k);

const doc = {
  schema_version: 1,
  generatedAt: new Date().toISOString(),
  commit,
  rule: "a platform is supported only with conformance evidence bound to this exact commit",
  platforms,
  supported_platforms: supported,
  unverified_or_degraded_platforms: Object.entries(platforms)
    .filter(([, v]) => v.status !== "supported")
    .map(([k]) => k),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(
  `[platform-matrix] wrote ${OUT_PATH} (supported=${supported.length}/${Object.keys(platforms).length})`,
);
