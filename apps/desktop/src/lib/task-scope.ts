/**
 * Terminus Desktop — the workspace scope every task is created with.
 *
 * `POST /v1/tasks` defaults `allowed_scope` to `{}`, and the resulting
 * contract has `changePolicy.mayExpandScope: false`. A task created without a
 * scope therefore has no read, write, or exec authority over its own
 * workspace, for its whole life: `kernelContextForTask` refuses every
 * capability request with "task <id> contract grants no workspace paths for
 * the requested operation", which the control plane reports as an opaque
 * `EXEC_FAILED` / `DIFF_FAILED`.
 *
 * The user picked this project and opened it; the honest scope for an
 * interactive coding task on it is the project. What the agent may then *do*
 * — and what needs an approval first — is the permission profile's job, not
 * the contract's. This matches the scope the eval harness submits
 * (`python/forge_evals/.../terminus_harness.py`).
 */
import type { TaskAllowedScope } from "../types";

export const WORKSPACE_TASK_SCOPE: TaskAllowedScope = {
  // "**" matches every path including the workspace root ".", which is what
  // the diff and exec routes ask for.
  read_paths: ["**"],
  write_paths: ["**"],
  // Network and third-party effects are not implied by opening a project.
  external_systems: [],
};
