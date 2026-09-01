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
 *   - macOS: a successful strict Seatbelt job result plus an effective-control
 *     probe matrix for the same candidate and runner architecture;
 *   - Windows remains declared degraded until native enforcement evidence
 *     exists.
 *
 * Missing infrastructure is recorded as `requires_ci`, not papered over.
 * Output: artifacts/release-gate/platform-support.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH =
  process.env.TERMINUS_PLATFORM_MATRIX_OUTPUT ??
  join(OUT_DIR, "platform-support.json");

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

interface LinuxEvidence {
  readonly path: string;
  readonly commit: string;
  readonly releaseVersion: string;
}

function loadLinuxEvidence(): LinuxEvidence | null {
  const candidates = [
    process.env.TERMINUS_LINUX_EVIDENCE,
    join(OUT_DIR, "linux-enforcement-evidence.json"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (!isRecord(doc)) continue;
      return {
        path: p,
        commit:
          typeof doc.terminus_commit === "string" ? doc.terminus_commit : "",
        releaseVersion:
          typeof doc.release_version === "string" ? doc.release_version : "",
      };
    } catch {
      // unreadable evidence is recorded as absent below
    }
  }
  return null;
}

interface MacOsEvidence {
  readonly path: string;
  readonly probesPath: string;
  readonly commit: string;
  readonly architecture: "macos-arm64" | "macos-x86_64" | null;
  readonly valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function macOsPlatform(architecture: unknown): MacOsEvidence["architecture"] {
  if (typeof architecture !== "string") return null;
  switch (architecture.toLowerCase()) {
    case "arm64":
    case "aarch64":
      return "macos-arm64";
    case "x64":
    case "x86_64":
      return "macos-x86_64";
    default:
      return null;
  }
}

function isStableSemver(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)
  );
}

function hasStrictMacOsProbes(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schema !== "terminus.platform-matrix.v1" ||
    !Array.isArray(value.rows)
  ) {
    return false;
  }
  const requiredProbes = [
    "filesystem_escape",
    "ambient_secret_denial",
    "network_egress",
  ] as const;
  return value.rows.some((row) => {
    if (
      !isRecord(row) ||
      row.platform !== "Macos" ||
      row.backend !== "macos" ||
      row.status !== "enforced" ||
      !Array.isArray(row.probes)
    ) {
      return false;
    }
    const probes: unknown[] = row.probes;
    return requiredProbes.every((requiredProbe) =>
      probes.some(
        (probe) =>
          isRecord(probe) &&
          probe.probe === requiredProbe &&
          probe.verdict === "enforced",
      ),
    );
  });
}

function loadMacOsEvidence(): MacOsEvidence | null {
  const path =
    process.env.TERMINUS_MACOS_EVIDENCE ??
    join(OUT_DIR, "macos-enforcement.json");
  const probesPath =
    process.env.TERMINUS_MACOS_PROBES ??
    join(OUT_DIR, "macos-platform-probes.json");
  if (!existsSync(path)) return null;

  try {
    const result = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const probes = existsSync(probesPath)
      ? (JSON.parse(readFileSync(probesPath, "utf8")) as unknown)
      : null;
    if (!isRecord(result)) {
      return { path, probesPath, commit: "", architecture: null, valid: false };
    }
    const runner = isRecord(result.runner) ? result.runner : {};
    const commit =
      typeof result.candidate_commit === "string"
        ? result.candidate_commit
        : "";
    const expectedVersion = process.env.TERMINUS_RELEASE_VERSION;
    return {
      path,
      probesPath,
      commit,
      architecture: macOsPlatform(runner.arch),
      valid:
        result.schema_version === 1 &&
        result.job === "macos-enforcement" &&
        result.status === "passed" &&
        result.classification === "none" &&
        result.promotable === true &&
        result.exit_code === 0 &&
        isStableSemver(result.release_version) &&
        typeof runner.os === "string" &&
        runner.os.toLowerCase() === "macos" &&
        (expectedVersion === undefined ||
          result.release_version === expectedVersion) &&
        hasStrictMacOsProbes(probes),
    };
  } catch {
    return { path, probesPath, commit: "", architecture: null, valid: false };
  }
}

const commit = headCommit();
const platforms: Record<string, PlatformEntry> = {};

// --- Linux: signed enforcement evidence from the dedicated runner. ---
const linuxEvidence = loadLinuxEvidence();
const expectedVersion = process.env.TERMINUS_RELEASE_VERSION;
if (
  linuxEvidence?.commit &&
  (commit === "unknown" || linuxEvidence.commit === commit) &&
  (expectedVersion === undefined ||
    linuxEvidence.releaseVersion === expectedVersion)
) {
  platforms["linux-x86_64"] = {
    status: "supported",
    basis: "signed Linux effective-enforcement manifest bound to this commit",
    evidence: linuxEvidence.path,
  };
} else if (linuxEvidence) {
  platforms["linux-x86_64"] = {
    status: "unverified",
    basis:
      linuxEvidence.commit !== commit
        ? `enforcement manifest commit ${linuxEvidence.commit} does not match HEAD ${commit}`
        : `enforcement manifest release ${linuxEvidence.releaseVersion} does not match ${expectedVersion}`,
    evidence: linuxEvidence.path,
  };
} else {
  platforms["linux-x86_64"] = {
    status: "requires_ci",
    basis:
      "no Linux enforcement evidence artifact at HEAD; produced by .github/workflows/linux-evidence.yml on a Linux runner",
    evidence: null,
  };
}
platforms["linux-arm64"] = {
  status: "requires_ci",
  basis: "no conformance evidence pipeline for arm64 Linux yet",
  evidence: null,
};

// --- macOS: candidate-bound live Seatbelt tests and effective probes. ---
const macOsEvidence = loadMacOsEvidence();
for (const platform of ["macos-arm64", "macos-x86_64"] as const) {
  if (
    macOsEvidence?.valid &&
    macOsEvidence.architecture === platform &&
    macOsEvidence.commit &&
    (commit === "unknown" || macOsEvidence.commit === commit)
  ) {
    platforms[platform] = {
      status: "supported",
      basis: `strict Seatbelt tests and effective-control probes bound to this commit (${macOsEvidence.probesPath})`,
      evidence: macOsEvidence.path,
    };
  } else if (macOsEvidence?.architecture === platform) {
    platforms[platform] = {
      status: "unverified",
      basis: macOsEvidence.valid
        ? `macOS evidence commit ${macOsEvidence.commit} does not match HEAD ${commit}`
        : "macOS evidence is incomplete, failed, or lacks enforced effective-control probes",
      evidence: macOsEvidence.path,
    };
  } else {
    platforms[platform] = {
      status: "requires_ci",
      basis: `no strict candidate-bound Seatbelt evidence for ${platform}`,
      evidence: null,
    };
  }
}

// --- Declared-degraded backends without strict evidence pipelines. ---
platforms["windows-x86_64"] = {
  status: "degraded_declared",
  basis:
    "sandbox backend reports Degraded (AppContainer/Job Object wiring not implemented); secure profiles fail closed by design",
  evidence: null,
};
platforms["linux-container"] = {
  status: "degraded_declared",
  basis:
    "container backend wrapper reports Degraded until hardened OCI profiles land (Phase 4)",
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

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(
  `[platform-matrix] wrote ${OUT_PATH} (supported=${supported.length}/${Object.keys(platforms).length})`,
);
