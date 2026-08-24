#!/usr/bin/env bun
/**
 * Reject release evidence produced from an uncommitted or mismatched source
 * snapshot. A Git commit identifies bytes only when the working tree is clean.
 */
import { join } from "node:path";

export type ReleaseSourceSnapshot = {
  expectedCommit: string;
  actualCommit: string;
  clean: boolean;
};

const ROOT = join(import.meta.dir, "..");

function releaseCommitFromEnvironment(): string | null {
  for (const name of ["TERMINUS_RELEASE_COMMIT", "GITHUB_SHA"] as const) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function runGit(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || `exit ${result.exitCode}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.toString();
}

export function inspectReleaseSource(root = ROOT): ReleaseSourceSnapshot {
  const actualCommit = runGit(root, ["rev-parse", "HEAD"]).trim();
  const expectedCommit = releaseCommitFromEnvironment() ?? actualCommit;
  const porcelain = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    expectedCommit,
    actualCommit,
    clean: porcelain.length === 0,
  };
}

export function validateReleaseSource(snapshot: ReleaseSourceSnapshot): string[] {
  const errors: string[] = [];
  if (!snapshot.actualCommit) errors.push("Git HEAD could not be resolved");
  if (!snapshot.expectedCommit) errors.push("the expected release commit is empty");
  if (
    snapshot.actualCommit &&
    snapshot.expectedCommit &&
    snapshot.actualCommit !== snapshot.expectedCommit
  ) {
    errors.push(
      `checked-out HEAD ${snapshot.actualCommit} does not match release commit ${snapshot.expectedCommit}`,
    );
  }
  if (!snapshot.clean) {
    errors.push(
      "working tree is dirty; commit or isolate the candidate before producing commit-bound release evidence",
    );
  }
  return errors;
}

export function requireCleanReleaseSource(root = ROOT): ReleaseSourceSnapshot {
  const snapshot = inspectReleaseSource(root);
  const errors = validateReleaseSource(snapshot);
  if (errors.length > 0) throw new Error(`release source is invalid: ${errors.join("; ")}`);
  return snapshot;
}

function main(): void {
  const snapshot = inspectReleaseSource();
  const errors = validateReleaseSource(snapshot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[release-source-check] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[release-source-check] OK — clean source at ${snapshot.actualCommit}`);
}

if (import.meta.main) main();
