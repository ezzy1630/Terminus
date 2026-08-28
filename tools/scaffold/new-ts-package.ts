#!/usr/bin/env bun
/**
 * new-ts-package — scaffold a new TypeScript package under packages/<name>.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. This script
 * creates the directory structure and stub files for a new package.
 *
 * Usage: bun run tools/scaffold/new-ts-package.ts <name>
 * Then add the new package to:
 *   - pnpm-workspace.yaml (already covered by `packages/*` glob)
 *   - tsconfig.packages.json paths (manual; this script prints a reminder)
 *   - .github/CODEOWNERS (manual; this script prints a reminder)
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const name = process.argv[2];

if (!name) {
  console.error("Usage: bun run tools/scaffold/new-ts-package.ts <name>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`Invalid package name "${name}": must be kebab-case (lowercase, hyphens).`);
  process.exit(1);
}

const pkgDir = join(ROOT, "packages", name);
if (existsSync(pkgDir)) {
  console.error(`packages/${name} already exists`);
  process.exit(1);
}

const pkgName = `@terminus/${name}`;

mkdirSync(join(pkgDir, "src"), { recursive: true });

writeFileSync(
  join(pkgDir, "package.json"),
  JSON.stringify(
    {
      name: pkgName,
      version: "0.1.0",
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      scripts: {
        build: "tsc -p tsconfig.json",
        lint: "eslint src",
        test: "bun test",
      },
      dependencies: {},
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(pkgDir, "tsconfig.json"),
  JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: { composite: true, outDir: "dist", rootDir: "src" },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(pkgDir, "src", "index.ts"),
  `/**\n * ${pkgName} — scaffold.\n *\n * TODO: replace this stub with the package's public API.\n */\nexport const PACKAGE_NAME = "${pkgName}";\n`,
);

writeFileSync(
  join(pkgDir, "README.md"),
  `# ${pkgName}\n\nTODO: one-paragraph description of what this package does and who consumes it.\n\n## Public API\n\nTODO: list the exported types, functions, and constants.\n\n## Invariants\n\nTODO: list the invariants this package enforces.\n`,
);

writeFileSync(
  join(pkgDir, "AGENTS.md"),
  `# ${pkgName} — local rules\n\n## Non-negotiable\n\n- TODO: list the architectural constraints enforced by SPEC and ADRs.\n- TODO: list forbidden imports (see \`tools/boundary-check.ts\`).\n\n## Style\n\n- TODO: list package-specific style conventions.\n\n## What NOT to add\n\n- TODO: list anti-patterns specific to this package.\n`,
);

writeFileSync(
  join(pkgDir, "src", `${name}.test.ts`),
  `import { test, expect } from "bun:test";\nimport { PACKAGE_NAME } from "./index";\n\ntest("PACKAGE_NAME is exported", () => {\n  expect(PACKAGE_NAME).toBe("${pkgName}");\n});\n`,
);

console.log(`[new-ts-package] created packages/${name}/`);
console.log(`[new-ts-package] TODO:`);
console.log(`  - add \`${pkgName}\` to tsconfig.packages.json paths`);
console.log(`  - add \`packages/${name}/\` to .github/CODEOWNERS`);
console.log(`  - add the package to the workspace dependency graph as needed`);
