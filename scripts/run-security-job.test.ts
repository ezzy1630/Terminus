import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SecurityJobResult {
  readonly schema_version: number;
  readonly job: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly classification:
    | "none"
    | "product_failure"
    | "dependency_failure"
    | "non_promotable_environment";
  readonly promotable: boolean;
  readonly candidate_commit: string;
  readonly release_version: string | null;
  readonly runner: {
    readonly os: string;
    readonly arch: string;
  };
  readonly exit_code: number;
  readonly generated_at: string;
}

const root = join(import.meta.dir, "..");
const script = join(import.meta.dir, "run-security-job.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(
  job: string,
  failureClassification: Exclude<SecurityJobResult["classification"], "none">,
  promotable: boolean,
  command: readonly string[],
  releaseVersion?: string,
): { readonly exitCode: number; readonly result: SecurityJobResult } {
  const directory = mkdtempSync(join(tmpdir(), "terminus-security-job-"));
  temporaryDirectories.push(directory);
  const resultPath = join(directory, "result.json");
  const process = Bun.spawnSync(
    [
      "bash",
      script,
      job,
      resultPath,
      failureClassification,
      String(promotable),
      "--",
      ...command,
    ],
    {
      cwd: root,
      env: { ...Bun.env, TERMINUS_RELEASE_VERSION: releaseVersion ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const result = JSON.parse(
    readFileSync(resultPath, "utf8"),
  ) as SecurityJobResult;
  return { exitCode: process.exitCode, result };
}

describe("run-security-job", () => {
  test("records a successful command without a failure classification", () => {
    const { exitCode, result } = run(
      "dependency-audit",
      "dependency_failure",
      true,
      ["bash", "-c", "exit 0"],
      "1.2.3",
    );

    expect(exitCode).toBe(0);
    expect(result).toMatchObject({
      schema_version: 1,
      job: "dependency-audit",
      status: "passed",
      classification: "none",
      promotable: true,
      release_version: "1.2.3",
      exit_code: 0,
    });
    expect(result.candidate_commit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  test("preserves product failures after writing the result", () => {
    const { exitCode, result } = run("cargo-fuzz", "product_failure", false, [
      "bash",
      "-c",
      "exit 7",
    ]);

    expect(exitCode).toBe(7);
    expect(result).toMatchObject({
      status: "failed",
      classification: "product_failure",
      promotable: false,
      exit_code: 7,
    });
  });

  test("marks an incapable runner as non-promotable instead of a product failure", () => {
    const { exitCode, result } = run(
      "linux-preflight",
      "non_promotable_environment",
      false,
      ["bash", "-c", "exit 23"],
    );

    expect(exitCode).toBe(23);
    expect(result).toMatchObject({
      status: "not_run",
      classification: "non_promotable_environment",
      promotable: false,
      exit_code: 23,
    });
  });

  test("rejects an invalid release identity before executing the command", () => {
    const directory = mkdtempSync(join(tmpdir(), "terminus-security-job-"));
    temporaryDirectories.push(directory);
    const resultPath = join(directory, "result.json");
    const commandMarker = join(directory, "command-ran");
    const process = Bun.spawnSync(
      [
        "bash",
        script,
        "release-security",
        resultPath,
        "product_failure",
        "true",
        "--",
        "touch",
        commandMarker,
      ],
      {
        cwd: root,
        env: { ...Bun.env, TERMINUS_RELEASE_VERSION: "not-semver" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(process.exitCode).toBe(64);
    expect(existsSync(commandMarker)).toBe(false);
    expect(existsSync(resultPath)).toBe(false);
  });
});
