#!/usr/bin/env bun
/**
 * new-rust-crate — scaffold a new Rust crate under crates/<name>.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. This script
 * creates the directory structure and stub files for a new crate.
 *
 * Usage: bun run tools/scaffold/new-rust-crate.ts <name>
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const name = process.argv[2];

if (!name) {
  console.error("Usage: bun run tools/scaffold/new-rust-crate.ts <name>");
  process.exit(1);
}
if (!/^forge-[a-z0-9-]+$/.test(name)) {
  console.error(`Invalid crate name "${name}": must start with "forge-" and be kebab-case.`);
  console.error("Examples: forge-tracing, forge-quota, forge-http-server.");
  process.exit(1);
}

const crateDir = join(ROOT, "crates", name);
if (existsSync(crateDir)) {
  console.error(`crates/${name} already exists`);
  process.exit(1);
}

mkdirSync(join(crateDir, "src"), { recursive: true });
mkdirSync(join(crateDir, "tests"), { recursive: true });

writeFileSync(
  join(crateDir, "Cargo.toml"),
  `[package]
name = "${name}"
version.workspace = true
edition.workspace = true
license.workspace = true
rust-version.workspace = true
description = "TODO: one-line description of ${name}."

[lints]
workspace = true

[dependencies]
# TODO: add workspace dependencies (thiserror, serde, tokio, etc.) as needed.
`,
);

writeFileSync(
  join(crateDir, "src", "lib.rs"),
  `//! ${name} — scaffold.
//!
//! TODO: replace this stub with the crate's public API. Keep the module-level
//! doc up to date with the crate's purpose and the SPEC sections it implements.

#![forbid(unsafe_code)]
`,
);

writeFileSync(
  join(crateDir, "src", "error.rs"),
  `//! Error types for ${name}.

use thiserror::Error;

/// Errors emitted by ${name}.
#[derive(Debug, Error)]
pub enum Error {
    /// TODO: replace with real error variants.
    #[error("not yet implemented")]
    NotImplemented,
}
`,
);

writeFileSync(
  join(crateDir, "tests", "smoke.rs"),
  `//! Smoke test for ${name}.

#[test]
fn crate_links() {
    // TODO: replace with a real smoke test that exercises the public API.
    assert_eq!(2 + 2, 4);
}
`,
);

writeFileSync(
  join(crateDir, "README.md"),
  `# ${name}\n\nTODO: one-paragraph description of what this crate does and which Forge components consume it.\n\n## Public API\n\nTODO: list the public types, traits, and functions.\n\n## Invariants\n\nTODO: list the invariants this crate enforces.\n`,
);

writeFileSync(
  join(crateDir, "AGENTS.md"),
  `# ${name} — local rules\n\n## Non-negotiable\n\n- \`#![forbid(unsafe_code)]\` is required (workspace.lints.rust).\n- No \`unwrap_used\`, \`expect_used\`, or \`panic\` (workspace.lints.clippy).\n- TODO: list crate-specific architectural constraints.\n\n## Style\n\n- TODO: list crate-specific style conventions.\n\n## What NOT to add\n\n- TODO: list anti-patterns specific to this crate.\n`,
);

console.log(`[new-rust-crate] created crates/${name}/`);
console.log(`[new-rust-crate] TODO:`);
console.log(`  - add \`${name} = { path = "crates/${name}" }\` to [workspace.dependencies] in root Cargo.toml`);
console.log(`  - add \`crates/${name}/\` to .github/CODEOWNERS`);
