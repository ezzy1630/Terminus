import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PlatformMatrix {
  readonly platforms: Record<
    string,
    {
      readonly status:
        "supported" | "degraded_declared" | "requires_ci" | "unverified";
      readonly basis: string;
      readonly evidence: string | null;
    }
  >;
  readonly supported_platforms: readonly string[];
}

const script = join(import.meta.dir, "produce-platform-matrix.ts");
const temporaryDirectories: string[] = [];
const candidate = "a".repeat(40);
const strictProbes = [
  { probe: "filesystem_escape", verdict: "enforced" },
  { probe: "ambient_secret_denial", verdict: "enforced" },
  { probe: "network_egress", verdict: "enforced" },
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runMacOsCase(
  commit: string,
  options: {
    readonly runnerOs?: string;
    readonly probes?: readonly {
      readonly probe: string;
      readonly verdict: string;
    }[];
    readonly releaseVersion?: string;
  } = {},
): PlatformMatrix {
  const directory = mkdtempSync(join(tmpdir(), "terminus-platform-matrix-"));
  temporaryDirectories.push(directory);
  const evidence = join(directory, "macos-enforcement.json");
  const probes = join(directory, "macos-platform-probes.json");
  const output = join(directory, "platform-support.json");

  writeJson(evidence, {
    schema_version: 1,
    job: "macos-enforcement",
    status: "passed",
    classification: "none",
    promotable: true,
    candidate_commit: commit,
    release_version: options.releaseVersion ?? "1.2.3",
    runner: { os: options.runnerOs ?? "macOS", arch: "ARM64" },
    exit_code: 0,
  });
  writeJson(probes, {
    schema: "terminus.platform-matrix.v1",
    rows: [
      {
        platform: "Macos",
        backend: "macos",
        status: "enforced",
        probes: options.probes ?? strictProbes,
      },
    ],
  });

  const process = Bun.spawnSync(["bun", "run", script], {
    env: {
      ...Bun.env,
      TERMINUS_RELEASE_COMMIT: candidate,
      TERMINUS_RELEASE_VERSION: "1.2.3",
      TERMINUS_MACOS_EVIDENCE: evidence,
      TERMINUS_MACOS_PROBES: probes,
      TERMINUS_PLATFORM_MATRIX_OUTPUT: output,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(process.exitCode).toBe(0);
  return JSON.parse(readFileSync(output, "utf8")) as PlatformMatrix;
}

function runLinuxCase(releaseVersion: string): PlatformMatrix {
  const directory = mkdtempSync(join(tmpdir(), "terminus-platform-matrix-"));
  temporaryDirectories.push(directory);
  const evidence = join(directory, "linux-enforcement.json");
  const output = join(directory, "platform-support.json");

  writeJson(evidence, {
    terminus_commit: candidate,
    release_version: releaseVersion,
  });
  const process = Bun.spawnSync(["bun", "run", script], {
    env: {
      ...Bun.env,
      TERMINUS_RELEASE_COMMIT: candidate,
      TERMINUS_RELEASE_VERSION: "1.2.3",
      TERMINUS_LINUX_EVIDENCE: evidence,
      TERMINUS_MACOS_EVIDENCE: join(directory, "missing-macos-evidence.json"),
      TERMINUS_PLATFORM_MATRIX_OUTPUT: output,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(process.exitCode).toBe(0);
  return JSON.parse(readFileSync(output, "utf8")) as PlatformMatrix;
}

describe("produce-platform-matrix macOS evidence", () => {
  test("supports only the architecture proven by strict candidate evidence", () => {
    const result = runMacOsCase(candidate);

    expect(result.platforms["macos-arm64"]?.status).toBe("supported");
    expect(result.platforms["macos-x86_64"]?.status).toBe("requires_ci");
    expect(result.supported_platforms).toContain("macos-arm64");
  });

  test("rejects a strict result bound to another candidate", () => {
    const result = runMacOsCase("b".repeat(40));

    expect(result.platforms["macos-arm64"]?.status).toBe("unverified");
    expect(result.supported_platforms).not.toContain("macos-arm64");
  });

  test("rejects an enforced row that omits a required control", () => {
    const result = runMacOsCase(candidate, {
      probes: [
        strictProbes[0],
        strictProbes[1],
        { probe: "unrelated_probe", verdict: "enforced" },
      ],
    });

    expect(result.platforms["macos-arm64"]?.status).toBe("unverified");
  });

  test("rejects evidence from a non-macOS runner or another release", () => {
    const wrongRunner = runMacOsCase(candidate, { runnerOs: "Linux" });
    const wrongVersion = runMacOsCase(candidate, { releaseVersion: "1.2.4" });

    expect(wrongRunner.platforms["macos-arm64"]?.status).toBe("unverified");
    expect(wrongVersion.platforms["macos-arm64"]?.status).toBe("unverified");
  });
});

describe("produce-platform-matrix Linux evidence", () => {
  test("requires the exact release identity", () => {
    const matching = runLinuxCase("1.2.3");
    const wrongVersion = runLinuxCase("1.2.4");

    expect(matching.platforms["linux-x86_64"]?.status).toBe("supported");
    expect(wrongVersion.platforms["linux-x86_64"]?.status).toBe("unverified");
  });
});
