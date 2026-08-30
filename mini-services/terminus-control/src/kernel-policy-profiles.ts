export const SECURE_LOCAL_SANDBOX_PROFILE_ID = "secure-local-default";
export const WORKSPACE_DEVELOPMENT_POLICY_PROFILE_ID = "workspace-development";
export const WHOLE_WORKSPACE_SCOPE_GLOB = "**";

/**
 * Development bootstrap tokens are valid only for the curated default
 * policy. Non-default policy requests must go through the broker, which binds
 * the requested policy into the signed task capability.
 */
export function configuredTokenMayAuthorize(policyProfileIds: readonly string[] | undefined): boolean {
  return (policyProfileIds ?? []).every((profileId) => profileId === SECURE_LOCAL_SANDBOX_PROFILE_ID);
}

export interface WorkspaceScopeProjection {
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
}

/**
 * Arbitrary local processes can reach every path exposed by the OS sandbox,
 * not only their initial cwd. This is the authorization predicate for the
 * dormant broad-policy binding; it is not a default and must not be used by
 * native standalone dispatch until the isolated promotion gate is complete.
 * The policy is therefore available only when the task contract explicitly
 * grants the whole workspace for both reads and writes.
 */
export function authorizesWorkspaceDevelopment(scope: WorkspaceScopeProjection): boolean {
  return scope.read_paths.includes(WHOLE_WORKSPACE_SCOPE_GLOB)
    && scope.write_paths.includes(WHOLE_WORKSPACE_SCOPE_GLOB);
}
