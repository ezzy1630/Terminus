#!/usr/bin/env bun
/**
 * new-eval — scaffold a new eval task under evals/tasks/<suite>/<task>/.
 *
 * SPEC §45.7 mandates scaffolds include README, AGENTS, tests, ownership,
 * lint config, observability placeholders, and CI registration. Eval tasks
 * follow the task-package format documented in SPEC §41.4.
 *
 * Usage: bun run tools/scaffold/new-eval.ts <suite> <task>
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const suite = process.argv[2];
const task = process.argv[3];

if (!suite || !task) {
  console.error("Usage: bun run tools/scaffold/new-eval.ts <suite> <task>");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(suite)) {
  console.error(`Invalid suite id "${suite}": must be kebab-case.`);
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(task)) {
  console.error(`Invalid task id "${task}": must be kebab-case.`);
  process.exit(1);
}

const taskDir = join(ROOT, "evals", "tasks", suite, task);
if (existsSync(taskDir)) {
  console.error(`evals/tasks/${suite}/${task} already exists`);
  process.exit(1);
}

mkdirSync(join(taskDir, "grader"), { recursive: true });
mkdirSync(join(taskDir, "hidden"), { recursive: true });

writeFileSync(
  join(taskDir, "task.yaml"),
  `task:
  id: ${suite}/${task}
  suite: ${suite}
  version: 1
  source_commit: TODO_40_char_hex_commit
  image_digest: sha256:TODO_64_char_hex_digest
  timeout_seconds: 300
  budget:
    model_micros: 500000
    compute_seconds: 120
    wall_clock_seconds: 300
    human_approvals: 0
  allowed_network: []
  secrets: []
  grader_version: ${suite}-1.0
  risk_class: low
  acceptance_criteria:
    - id: TODO_criterion_id
      statement: TODO acceptance criterion statement.
      required: true
  non_goals:
    - TODO non-goal.
`,
);

writeFileSync(
  join(taskDir, "policy.yaml"),
  `policy:
  sandbox_profile: secure-local-default
  command: policies/command/default.yaml
  network: policies/network/default.yaml
  secrets: policies/secrets/default.yaml
  risk_class: low
  approval:
    external_state: prompt
    secret_use: prompt_unless_pregranted
    scope_expansion: prompt
  budget_overrides: {}
`,
);

writeFileSync(
  join(taskDir, "prompt.md"),
  `# ${suite}/${task}\n\nTODO: write the task prompt that will be projected to the model.\nState the objective, the acceptance criterion, and any constraints.\n`,
);

writeFileSync(
  join(taskDir, "setup.sh"),
  `#!/usr/bin/env bash\n# Setup script for the ${suite}/${task} task.\n# Runs in the eval sandbox BEFORE the agent starts.\nset -euo pipefail\n\n# TODO: create the initial workspace state.\necho "setup placeholder"\n`,
);

writeFileSync(
  join(taskDir, "grader", "run.py"),
  `#!/usr/bin/env python3\n"""Grader for the ${suite}/${task} task.\n\nRun by the eval harness AFTER the agent declares the task complete.\nExit code 0 = PASS, non-zero = FAIL.\n"""\nfrom __future__ import annotations\n\nimport sys\n\n\ndef fail(msg: str) -> None:\n    print(f"FAIL: {msg}", file=sys.stderr)\n    sys.exit(1)\n\n\ndef main() -> None:\n    # TODO: implement the grading logic. Check the acceptance criteria from\n    # task.yaml, run any hidden tests under hidden/, and exit 0 on success.\n    fail("grader not yet implemented")\n\n\nif __name__ == "__main__":\n    main()\n`,
);

writeFileSync(
  join(taskDir, "hidden", "test_hidden.py"),
  `# Hidden tests — never projected to model context. Run by the grader.\n# TODO: implement hidden tests for the ${suite}/${task} task.\n`,
);

writeFileSync(
  join(taskDir, "expected-properties.yaml"),
  `expected:\n  outcome: completed\n  changed_files: []\n  tests: []\n  verification_plan: []\n  cost_usd_max: 0.05\n  turns_max: 3\n  rejection_triggers:\n    - TODO rejection trigger.\n`,
);

writeFileSync(
  join(taskDir, "environment.lock"),
  `# Pinned environment for ${suite}/${task}.\n# TODO: replace with a real lockfile content (image digest, tool versions).\n`,
);

writeFileSync(
  join(taskDir, "README.md"),
  `# ${suite}/${task}\n\nTODO: describe the task's objective, difficulty, and which SPEC §41 cohort it belongs to.\n`,
);

console.log(`[new-eval] created evals/tasks/${suite}/${task}/`);
console.log(`[new-eval] TODO:`);
console.log(`  - fill in task.yaml (commit, image_digest, acceptance_criteria)`);
console.log(`  - implement setup.sh, grader/run.py, hidden/test_hidden.py`);
console.log(`  - add the task to evals/suites/${suite}.yaml if it should run as part of a suite`);
