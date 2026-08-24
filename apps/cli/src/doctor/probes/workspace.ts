import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResult } from "../types.js";

export function probeWorkspace(rootDir: string): ProbeResult[] {
  const results: ProbeResult[] = [];

  // 1. Git Repository Probe (using direct filesystem inspection)
  const gitDir = join(rootDir, ".git");
  const isGitRepo = existsSync(gitDir);
  let headRef = "unknown";

  if (isGitRepo) {
    try {
      const headFile = join(gitDir, "HEAD");
      if (existsSync(headFile)) {
        const headContent = readFileSync(headFile, "utf8").trim();
        if (headContent.startsWith("ref:")) {
          headRef = headContent.slice(4).trim();
        } else {
          headRef = headContent.slice(0, 8);
        }
      }
    } catch {
      headRef = "unknown";
    }

    results.push({
      id: "workspace.git",
      name: "Git Repository & Workspace Identity",
      status: "pass",
      message: `Git workspace detected (${headRef})`,
      details: { isGitRepo, headRef },
      isProductionInvariant: true,
    });
  } else {
    results.push({
      id: "workspace.git",
      name: "Git Repository & Workspace Identity",
      status: "warn",
      message: "Not inside a valid Git repository work tree",
      recommendation: "Run within a version-controlled Git repository for immutable revision binding",
      isProductionInvariant: true,
    });
  }

  // 2. Core Tool Packages
  const aciPkg = join(rootDir, "packages", "aci");
  const verificationPkg = join(rootDir, "packages", "verification");
  const contextCompilerPkg = join(rootDir, "packages", "context-compiler");

  const aciExists = existsSync(aciPkg);
  const verificationExists = existsSync(verificationPkg);
  const contextCompilerExists = existsSync(contextCompilerPkg);

  if (aciExists && verificationExists && contextCompilerExists) {
    results.push({
      id: "workspace.tools",
      name: "Core Tool & Runtime Packages",
      status: "pass",
      message: "packages/aci, packages/verification, and packages/context-compiler present",
      details: { aciExists, verificationExists, contextCompilerExists },
      isProductionInvariant: true,
    });
  } else {
    results.push({
      id: "workspace.tools",
      name: "Core Tool & Runtime Packages",
      status: "fail",
      message: `Missing runtime packages: aci=${aciExists}, verification=${verificationExists}, context=${contextCompilerExists}`,
      recommendation: "Ensure core packages are intact in workspace",
      isProductionInvariant: true,
    });
  }

  return results;
}
