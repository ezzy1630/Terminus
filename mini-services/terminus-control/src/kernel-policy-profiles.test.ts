import { describe, expect, test } from "bun:test";
import {
  authorizesWorkspaceDevelopment,
  WHOLE_WORKSPACE_SCOPE_GLOB,
} from "./kernel-policy-profiles.js";

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
