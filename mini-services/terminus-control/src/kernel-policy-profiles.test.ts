import { describe, expect, test } from "bun:test";
import {
  authorizesWorkspaceDevelopment,
  configuredTokenMayAuthorize,
  WHOLE_WORKSPACE_SCOPE_GLOB,
} from "./kernel-policy-profiles.js";

describe("configured kernel token policy gate", () => {
  test("allows only the curated default policy shortcut", () => {
    expect(configuredTokenMayAuthorize(undefined)).toBe(true);
    expect(configuredTokenMayAuthorize(["secure-local-default"])).toBe(true);
    expect(configuredTokenMayAuthorize(["workspace-development"])).toBe(false);
    expect(configuredTokenMayAuthorize(["secure-local-default", "workspace-development"])).toBe(false);
  });
});

describe("workspace development capability scope", () => {
  test("requires explicit whole-workspace read and write authority", () => {
    expect(authorizesWorkspaceDevelopment({
      read_paths: [WHOLE_WORKSPACE_SCOPE_GLOB],
      write_paths: [WHOLE_WORKSPACE_SCOPE_GLOB],
    })).toBe(true);

    expect(authorizesWorkspaceDevelopment({
      read_paths: [WHOLE_WORKSPACE_SCOPE_GLOB],
      write_paths: ["src/**"],
    })).toBe(false);

    expect(authorizesWorkspaceDevelopment({
      read_paths: ["src/**"],
      write_paths: [WHOLE_WORKSPACE_SCOPE_GLOB],
    })).toBe(false);
  });

  test("does not infer whole-workspace authority from a requested cwd", () => {
    expect(authorizesWorkspaceDevelopment({
      read_paths: ["src/**"],
      write_paths: ["src/**"],
    })).toBe(false);
  });
});
