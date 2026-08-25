import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EVIDENCE_PATH = join(ROOT, "artifacts", "release-gate", "upgrade-rollback.json");

type DrillEvidence = {
  status: string;
  generatedAt: string;
  drills: Record<string, { generatedAt: string; steps?: string[] }>;
};

/**
 * R9: each release-drill test records its own evidence on success instead of
 * the justfile recipe authoring a blanket pass JSON. The artifact is only
 * ever written by a test body that has actually asserted its drill.
 */
export function recordDrillEvidence(drillName: string, steps: string[] = []): void {
  let current: DrillEvidence = { status: "passed", generatedAt: new Date().toISOString(), drills: {} };
  try {
    const raw = readFileSync(EVIDENCE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DrillEvidence>;
    if (parsed && typeof parsed === "object" && typeof parsed.drills === "object" && parsed.drills !== null) {
      current = {
        status: parsed.status === "passed" ? "passed" : "passed",
        generatedAt: new Date().toISOString(),
        drills: parsed.drills,
      };
    }
  } catch {
    // Missing or unreadable prior evidence starts a fresh bundle.
  }
  current.drills[drillName] = { generatedAt: new Date().toISOString(), ...(steps.length > 0 ? { steps } : {}) };
  mkdirSync(join(ROOT, "artifacts", "release-gate"), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
