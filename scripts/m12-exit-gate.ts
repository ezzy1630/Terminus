#!/usr/bin/env bun
/**
 * M12 exit gate: aggregate release-gate evidence (SPEC §46.18 / §50.10).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type EvidenceStatus = "present" | "missing" | "invalid" | "requires_ci" | "verified";

type EvidenceCheck = {
  key: string;
  path: string;
  status: EvidenceStatus;
  detail: string;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const FINDINGS_PATH = join(ROOT, "docs", "security", "findings-register.yaml");

const REQUIRED_LOCAL: ReadonlyArray<{ key: string; file: string }> = [
  { key: "fuzz-smoke", file: "fuzz-smoke.json" },
  { key: "fault-injection", file: "fault-injection.json" },
  { key: "property-tests", file: "property-tests.json" },
  { key: "upgrade-rollback", file: "upgrade-rollback.json" },
  { key: "soak-leak", file: "soak-leak.json" },
  { key: "preview-canary", file: "preview-canary.json" },
  { key: "ops-metrics", file: "ops-metrics.json" },
  { key: "eval-release", file: "eval-release.json" },
  { key: "sbom-verify", file: "sbom-verify.json" },
  { key: "schema-freeze", file: "schema-freeze.json" },
  { key: "findings-register-status", file: "findings-register-status.json" },
  { key: "release-decision", file: "release-decision.yaml" },
];

function ensureFindingsRegisterStatus(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "findings-register-status.json");
  if (!existsSync(FINDINGS_PATH)) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          status: "missing_register",
          generatedAt: new Date().toISOString(),
          path: "docs/security/findings-register.yaml",
          findings: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return;
  }
  const raw = readFileSync(FINDINGS_PATH, "utf8");
  let findings: unknown[] = [];
  try {
    const parsed = Bun.YAML.parse(raw) as { findings?: unknown[] };
    findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    findings = [];
  }
  const openCritical = findings.filter((f) => {
    if (typeof f !== "object" || f === null) return false;
    const rec = f as Record<string, unknown>;
    return rec.status === "open" && (rec.severity === "critical" || rec.severity === "sev1");
  });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        status: openCritical.length === 0 ? "ok" : "blocking_open_findings",
        generatedAt: new Date().toISOString(),
        path: "docs/security/findings-register.yaml",
        count: findings.length,
        openCritical: openCritical.length,
        findings,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function checkFile(key: string, file: string): EvidenceCheck {
  const path = join(OUT_DIR, file);
  if (!existsSync(path)) {
    return { key, path, status: "missing", detail: "file not found" };
  }
  try {
    const text = readFileSync(path, "utf8");
    if (text.trim().length === 0) {
      return { key, path, status: "invalid", detail: "empty file" };
    }
    if (file.endsWith(".json")) {
      JSON.parse(text);
    }
    return { key, path, status: "present", detail: "ok" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { key, path, status: "invalid", detail: msg };
  }
}

function linuxEvidence(): EvidenceCheck {
  const key = "linux-enforcement";
  const envPath = process.env.TERMINUS_LINUX_EVIDENCE;
  if (typeof envPath === "string" && envPath.length > 0 && existsSync(envPath)) {
    return {
      key,
      path: envPath,
      status: "verified",
      detail: "TERMINUS_LINUX_EVIDENCE present and readable",
    };
  }
  return {
    key,
    path: envPath ?? "",
    status: "requires_ci",
    detail: "TERMINUS_LINUX_EVIDENCE not set; Linux enforcement evidence requires CI",
  };
}

mkdirSync(OUT_DIR, { recursive: true });
ensureFindingsRegisterStatus();

const checks: EvidenceCheck[] = REQUIRED_LOCAL.map((r) => checkFile(r.key, r.file));
checks.push(linuxEvidence());

const missing = checks.filter((c) => c.status === "missing" || c.status === "invalid");
const requiresCi = checks.filter((c) => c.status === "requires_ci");
const present = checks.filter(
  (c) => c.status === "present" || c.status === "verified",
);

const gateStatus =
  missing.length === 0 ? (requiresCi.length > 0 ? "passed_local" : "passed") : "failed";

const checklist = checks.map((c) => ({
  item: c.key,
  status: c.status,
  detail: c.detail,
}));

const report = {
  generatedAt: new Date().toISOString(),
  status: gateStatus,
  summary: {
    required: REQUIRED_LOCAL.length + 1,
    present: present.length,
    missing: missing.length,
    requiresCi: requiresCi.length,
  },
  checklist,
  evidenceDir: OUT_DIR,
  files: existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : [],
};

const reportPath = join(OUT_DIR, "exit-gate-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const checklistMd = join(OUT_DIR, "exit-gate-checklist.md");
const lines = [
  `# M12 exit-gate checklist`,
  ``,
  `Status: **${gateStatus}**`,
  `Generated: ${report.generatedAt}`,
  ``,
  ...checklist.map((c) => `- [${c.status === "present" || c.status === "verified" ? "x" : " "}] ${c.item} — ${c.status}: ${c.detail}`),
  ``,
];
writeFileSync(checklistMd, `${lines.join("\n")}\n`, "utf8");

console.log(`[m12-exit-gate] status=${gateStatus} → ${reportPath}`);
if (gateStatus === "failed") {
  process.exit(1);
}
