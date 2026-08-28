import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..");

const visibleSurfaces = [
  "SPEC.md",
  "README.md",
  "CONTRIBUTING.md",
  "terminus.config.yaml",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/components/theme-provider.tsx",
  "apps/cli/src/index.ts",
  "apps/tui/src/index.ts",
  "apps/tui/src/app.ts",
  "apps/ide-acp/src/index.ts",
] as const;

const staleProductName = /\bForge\b/;
const failures: string[] = [];

for (const relativePath of visibleSurfaces) {
  const lines = (await readFile(join(ROOT, relativePath), "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    if (staleProductName.test(line)) {
      failures.push(`${relativePath}:${index + 1}:${line.trim()}`);
    }
  }
}

if (failures.length > 0) {
  console.error("[branding-check] visible surfaces still use the former product name:");
  for (const failure of failures) console.error(failure);
  console.error("Compatibility identifiers belong outside visible product copy; see ADR-0052.");
  process.exit(1);
}

console.log(`[branding-check] Terminus identity verified across ${visibleSurfaces.length} visible surfaces`);
