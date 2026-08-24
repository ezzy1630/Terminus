import { join } from "node:path";
import type {
  DoctorCategoryReport,
  DoctorOptions,
  DoctorReport,
  DoctorReportSummary,
  ProbeResult,
  SystemProfile,
} from "./types.js";
import { probeDatabase } from "./probes/database.js";
import { probeKernel } from "./probes/kernel.js";
import { probeSandbox } from "./probes/sandbox.js";
import { probeProviders } from "./probes/provider.js";
import { probeWorkspace } from "./probes/workspace.js";
import { probeMaturity } from "./probes/maturity.js";

export * from "./types.js";

function findRepoRoot(): string {
  if (process.env.TERMINUS_ROOT) return process.env.TERMINUS_ROOT;
  // Default to current working directory or traverse up
  return process.cwd();
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const rootDir = findRepoRoot();
  const profile: SystemProfile = (options.profile as SystemProfile) ?? (process.env.TERMINUS_PROFILE as SystemProfile) ?? "native";
  const gatewayUrl = options.gatewayUrl ?? process.env.TERMINUS_GATEWAY;

  const categories: DoctorCategoryReport[] = [
    {
      name: "database",
      title: "Database & Schema Storage",
      probes: probeDatabase(rootDir),
    },
    {
      name: "kernel",
      title: "Rust Kernel & Protocol",
      probes: await probeKernel(rootDir, gatewayUrl),
    },
    {
      name: "sandbox",
      title: "OS Sandboxing & Containment",
      probes: probeSandbox(),
    },
    {
      name: "providers",
      title: "Providers & Credentials",
      probes: probeProviders(rootDir),
    },
    {
      name: "workspace",
      title: "Workspace & Tools Runtime",
      probes: probeWorkspace(rootDir),
    },
    {
      name: "maturity",
      title: "Component Maturity & Governance",
      probes: probeMaturity(rootDir),
    },
  ];

  // Calculate summary counts
  let total = 0;
  let passed = 0;
  let warned = 0;
  let failed = 0;
  let skipped = 0;

  const violations: string[] = [];

  for (const cat of categories) {
    for (const p of cat.probes) {
      total++;
      if (p.status === "pass") passed++;
      else if (p.status === "warn") warned++;
      else if (p.status === "fail") failed++;
      else if (p.status === "skip") skipped++;

      // Check production invariants
      if (profile === "production" && p.isProductionInvariant && (p.status === "fail" || p.status === "warn")) {
        violations.push(`${cat.name}/${p.id}: ${p.message}`);
      }
    }
  }

  let overallStatus: DoctorReportSummary["status"] = "healthy";
  if (failed > 0 || violations.length > 0) {
    overallStatus = "failing";
  } else if (warned > 0) {
    overallStatus = "degraded";
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    platform: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
    },
    summary: {
      total,
      passed,
      warned,
      failed,
      skipped,
      status: overallStatus,
    },
    categories,
    invariants: {
      passed: violations.length === 0,
      violations,
    },
  };
}

export function formatDoctorReportText(report: DoctorReport, verbose = false): string {
  const lines: string[] = [];

  lines.push("╔════════════════════════════════════════════════════════════════════════════╗");
  lines.push("║                            TERMINUS SYSTEM DOCTOR                          ║");
  lines.push("╚════════════════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Profile:  ${report.profile.toUpperCase()}`);
  lines.push(`Platform: ${report.platform.os}-${report.platform.arch} (Node: ${report.platform.nodeVersion}${report.platform.bunVersion ? `, Bun: ${report.platform.bunVersion}` : ""})`);
  lines.push(`Time:     ${report.generatedAt}`);
  lines.push("");

  for (const cat of report.categories) {
    lines.push(`─── ${cat.title} ───`);
    for (const probe of cat.probes) {
      const badge =
        probe.status === "pass"
          ? "[ PASS ]"
          : probe.status === "warn"
          ? "[ WARN ]"
          : probe.status === "fail"
          ? "[ FAIL ]"
          : "[ SKIP ]";

      lines.push(`  ${badge} ${probe.name}`);
      lines.push(`           ${probe.message}`);

      if (probe.recommendation && (probe.status === "warn" || probe.status === "fail")) {
        lines.push(`           ↳ Recommendation: ${probe.recommendation}`);
      }

      if (verbose && probe.details) {
        lines.push(`           ↳ Details: ${JSON.stringify(probe.details)}`);
      }
    }
    lines.push("");
  }

  lines.push("══════════════════════════════════════════════════════════════════════════════");
  lines.push(`SUMMARY: ${report.summary.passed} passed, ${report.summary.warned} warned, ${report.summary.failed} failed, ${report.summary.skipped} skipped (Total: ${report.summary.total})`);
  lines.push(`OVERALL STATUS: ${report.summary.status.toUpperCase()}`);

  if (!report.invariants.passed) {
    lines.push("");
    lines.push("PRODUCTION INVARIANT VIOLATIONS:");
    for (const v of report.invariants.violations) {
      lines.push(`  ❌ ${v}`);
    }
  }

  lines.push("══════════════════════════════════════════════════════════════════════════════");
  return lines.join("\n");
}
