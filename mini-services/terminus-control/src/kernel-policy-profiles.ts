export const SECURE_LOCAL_SANDBOX_PROFILE_ID = "secure-local-default";
export const WORKSPACE_DEVELOPMENT_POLICY_PROFILE_ID = "workspace-development";
export const WHOLE_WORKSPACE_SCOPE_GLOB = "**";

export interface WorkspaceScopeProjection {
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
}

/**
 * Arbitrary local processes can reach every path exposed by the OS sandbox,
 * not only their initial cwd. The broad development policy is therefore
 * available only when the task contract explicitly grants the whole
 * workspace for both reads and writes.
 */
export function authorizesWorkspaceDevelopment(scope: WorkspaceScopeProjection): boolean {
  return scope.read_paths.includes(WHOLE_WORKSPACE_SCOPE_GLOB)
    && scope.write_paths.includes(WHOLE_WORKSPACE_SCOPE_GLOB);
}
