import { z } from "zod";
import type { AdapterCapabilityProfile, AdapterResult } from "./types.js";

export function validateCapabilityProfile(
  declared: AdapterCapabilityProfile,
  observed: AdapterCapabilityProfile,
): { readonly ok: boolean; readonly discrepancies: readonly string[] } {
  const discrepancies: string[] = [];
  const keys: readonly (keyof AdapterCapabilityProfile)[] = [
    "exactContextVisibility",
    "toolInterception",
    "filesystemEnforcement",
    "networkEnforcement",
    "secretIsolation",
    "sessionResume",
    "typedResults",
    "artifactExport",
    "cancellation",
    "modelSelection",
    "nativeCompaction",
  ];
  for (const k of keys) {
    if (declared[k] !== observed[k]) {
      discrepancies.push(`${k}: declared=${declared[k]} observed=${observed[k]}`);
    }
  }
  return { ok: discrepancies.length === 0, discrepancies };
}

const adapterResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed", "budget_exhausted", "policy_denied"]),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  commit: z.string().nullable(),
  tests: z.array(
    z.object({
      command: z.string(),
      status: z.enum(["passed", "failed", "skipped", "error"]),
      evidence: z.string().nullable(),
      sourceRevision: z.string(),
    }),
  ),
  findings: z.array(z.string()),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()),
  artifacts: z.array(z.unknown()),
  actualBudget: z.record(z.string(), z.unknown()),
});

export function validateAdapterResult(
  result: unknown,
  allowRetry: boolean,
):
  | { readonly ok: true; readonly result: AdapterResult }
  | { readonly ok: false; readonly reason: string; readonly mayRetry: boolean } {
  const parsed = adapterResultSchema.safeParse(result);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((i) => i.message).join("; ") || "schema validation failed",
      mayRetry: allowRetry,
    };
  }
  return { ok: true, result: parsed.data as unknown as AdapterResult };
}
