import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "run-release-evals.sh");

type EvalReport = {
  tier: string;
  status: string;
  pass: boolean;
  generatedAt: string;
  mode: string;
  reason: string;
};

function runProbe(allowPending: boolean): { exitCode: number; report: EvalReport } {
  const outputDir = mkdtempSync(join(tmpdir(), "terminus-release-eval-"));
  const outputPath = join(outputDir, "eval-release.json");
  const environment = { ...process.env, TERMINUS_RELEASE_EVAL_OUTPUT: outputPath };
  delete environment.TERMINUS_RELEASE_ALLOW_PENDING_LIVE_EVAL;
  if (allowPending) environment.TERMINUS_RELEASE_ALLOW_PENDING_LIVE_EVAL = "1";

  try {
    const process = Bun.spawnSync(["bash", SCRIPT], {
      cwd: ROOT,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: process.exitCode ?? 1,
      report: JSON.parse(readFileSync(outputPath, "utf8")) as EvalReport,
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

describe("release eval producer", () => {
  test("strict mode blocks when live runners and exact pins are unavailable", () => {
    const result = runProbe(false);

    expect(result.exitCode).not.toBe(0);
    expect(result.report).toMatchObject({
      tier: "release",
      status: "blocked",
      pass: false,
      mode: "forge_evals.baselines",
    });
    expect(result.report.reason).toContain("live baseline runner");
  });

  test("explicit M12 mode records pending live evaluation without passing it", () => {
    const result = runProbe(true);

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      tier: "release",
      status: "pending_live_eval",
      pass: false,
      mode: "forge_evals.baselines",
    });
    expect(result.report.reason).toContain("remains pending");
  });
});
