/**
 * Permission profiles — what a session lets the agent do without asking.
 *
 * A session carries `default_permission_profile`. Until now the value was
 * stored, echoed on the wire, and consumed by nothing: every tool call was
 * authorized the moment the task contract's scope admitted it, whatever the
 * profile said. The composer showed "secure-local-default" as if it meant
 * something. This module is what the value means.
 *
 * Three levels, mirroring the Codex app's control:
 *
 *   full-access  Edits files and runs commands in the sandboxed workspace
 *                without asking. The default.
 *   auto         Works freely inside the workspace; asks before anything
 *                that leaves it (network fetches).
 *   ask          Asks before every edit, command, or fetch. Reads, searches
 *                and job polls never need approval — they change nothing.
 *
 * The task contract's scope still bounds everything: a profile can only add
 * an approval step in front of a call the contract already permits, never
 * widen what the contract allows.
 */
import type { ParsedStandaloneToolCall } from "./agent-tools.js";

export const PERMISSION_PROFILES = ["full-access", "auto", "ask"] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "full-access";

/**
 * The profile id every session was created with before profiles meant
 * anything. It behaved as full access, so that is what it maps to.
 */
export const LEGACY_PERMISSION_PROFILE = "secure-local-default";

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return typeof value === "string" && (PERMISSION_PROFILES as readonly string[]).includes(value);
}

/**
 * Resolve a stored profile id to a level.
 *
 * The legacy id resolves to full access because that is how it behaved. Any
 * other unknown value fails closed to `ask`: a profile we cannot interpret
 * must not silently grant the widest permission.
 */
export function normalizePermissionProfile(raw: string | null | undefined): PermissionProfile {
  if (isPermissionProfile(raw)) return raw;
  if (raw === null || raw === undefined || raw === LEGACY_PERMISSION_PROFILE) return DEFAULT_PERMISSION_PROFILE;
  return "ask";
}

/** Whether this call must wait for the user under this profile. */
export function approvalRequiredFor(profile: PermissionProfile, call: ParsedStandaloneToolCall): boolean {
  switch (profile) {
    case "full-access":
      return false;
    case "auto":
      return call.toolId === "web_fetch";
    case "ask":
      if (call.toolId === "capability") return false;
      // `write` creates or replaces a whole file: the same authority as
      // `patch`, so it sits behind the same approval.
      return call.toolId === "patch"
        || call.toolId === "write"
        || call.toolId === "exec"
        || call.toolId === "web_fetch";
  }
}

export interface PermissionProfileDescription {
  readonly id: PermissionProfile;
  readonly label: string;
  readonly summary: string;
}

export function describePermissionProfile(profile: PermissionProfile): PermissionProfileDescription {
  switch (profile) {
    case "full-access":
      return {
        id: profile,
        label: "Full workspace access",
        summary: "Runs commands and edits this workspace without asking; host access stays sandboxed.",
      };
    case "auto":
      return { id: profile, label: "Auto", summary: "Works in the workspace freely; asks before network access." };
    case "ask":
      return { id: profile, label: "Ask for approval", summary: "Asks before every edit, command, or fetch." };
  }
}

/**
 * The sentence shown on the approval card: why the agent stopped.
 *
 * Written for the person deciding, not for a log. It names the level they
 * chose so the request never reads as the harness second-guessing them.
 */
export function approvalReasonFor(profile: PermissionProfile, call: ParsedStandaloneToolCall): string {
  const level = describePermissionProfile(profile).label;
  switch (call.toolId) {
    case "patch":
    case "write":
      return `Your permission level is "${level}", so the agent needs your approval before editing a file.`;
    case "exec":
      return `Your permission level is "${level}", so the agent needs your approval before running a command.`;
    case "web_fetch":
      return `Your permission level is "${level}", so the agent needs your approval before fetching from the network.`;
    default:
      return `Your permission level is "${level}", so the agent needs your approval before this action.`;
  }
}

/** Short verb phrase for the approval card's title. */
export function approvalActionFor(call: ParsedStandaloneToolCall): string {
  switch (call.toolId) {
    case "capability":
      return "Activate workspace tools";
    case "patch":
      return `Edit ${call.arguments.path}`;
    case "write":
      return `Write ${call.arguments.path}`;
    case "exec": {
      const shell = call.arguments.shell;
      const command = shell !== undefined
        ? shell.script
        : [call.arguments.program ?? "", ...call.arguments.args].join(" ").trim();
      return command.length > 0 ? `Run ${command}` : "Run a command";
    }
    case "web_fetch":
      return `Fetch ${call.arguments.url}`;
    case "read":
      return `Read ${call.arguments.path}`;
    case "grep":
      return `Search for ${call.arguments.pattern}`;
    case "glob":
      return `List ${call.arguments.pattern}`;
    case "exec_poll":
      return `Poll job ${call.arguments.background_id}`;
    case "inspect":
      return call.arguments.action === "symbol"
        ? `Inspect symbol ${call.arguments.query}`
        : "Inspect repository map";
    case "recall": {
      switch (call.arguments.action) {
        case "browse":
          return "Browse earlier turns";
        case "search":
          return `Search this task for ${call.arguments.query}`;
        case "read":
          return `Read turn ${call.arguments.turn_sequence}`;
        case "compaction_browse":
          return call.arguments.query === undefined
            ? "Browse compacted turn context"
            : `Search compacted turn context for ${call.arguments.query}`;
        case "compaction_read":
          return `Read compacted episode ${call.arguments.episode_id}`;
      }
    }
  }
}
