import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResult } from "../types.js";

export function probeMaturity(rootDir: string): ProbeResult[] {
  const results: ProbeResult[] = [];
  const maturityPath = join(rootDir, "maturity.yaml");

  if (existsSync(maturityPath)) {
    try {
      const content = readFileSync(maturityPath, "utf8");
      // Count tier occurrences in maturity.yaml
      const tiers = {
        production: (content.match(/tier:\s*production/g) || []).length,
        preview: (content.match(/tier:\s*preview/g) || []).length,
        experimental: (content.match(/tier:\s*experimental/g) || []).length,
        stub: (content.match(/tier:\s*stub/g) || []).length,
        fixture: (content.match(/tier:\s*fixture/g) || []).length,
      };
      const total = tiers.production + tiers.preview + tiers.experimental + tiers.stub + tiers.fixture;

      results.push({
        id: "maturity.registry",
        name: "Component Maturity Registry",
        status: "pass",
        message: `Maturity registry active (${total} components: ${tiers.production} prod, ${tiers.preview} preview, ${tiers.experimental} exp, ${tiers.stub} stub, ${tiers.fixture} fixture)`,
        details: { total, tiers },
        isProductionInvariant: false,
      });

      if (tiers.production === 0) {
        results.push({
          id: "maturity.production_gate",
          name: "Phase 0 Production Maturity Gate",
          status: "pass",
          message: "Registry honestly reports 0 production components (pending live conformance at HEAD)",
          details: { productionCount: 0, phase: "Phase 0 (truth & freeze)" },
          isProductionInvariant: false,
        });
      }
    } catch (err) {
      results.push({
        id: "maturity.registry",
        name: "Component Maturity Registry",
        status: "warn",
        message: `Failed to parse maturity.yaml: ${err instanceof Error ? err.message : String(err)}`,
        isProductionInvariant: false,
      });
    }
  } else {
    results.push({
      id: "maturity.registry",
      name: "Component Maturity Registry",
      status: "fail",
      message: "maturity.yaml not found in repository root",
      recommendation: "Ensure maturity.yaml is present",
      isProductionInvariant: true,
    });
  }

  return results;
}
