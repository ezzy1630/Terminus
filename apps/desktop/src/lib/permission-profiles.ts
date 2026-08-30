/**
 * Terminus Desktop — how much a project's tasks may do without asking.
 *
 * Three levels, and the project holds exactly one of them. It is a per-session
 * setting rather than a per-turn one because it is a standing decision about a
 * codebase — "this repo is a scratchpad, go ahead" versus "this one is
 * production, ask me" — and re-answering it on every message is how an
 * operator ends up clicking through approvals without reading them.
 *
 * The ids here are the control plane's, not this client's. The labels are only
 * ever a rendering of an id the server already holds: an earlier version of the
 * composer invented the phrase "Full access" for the profile
 * `secure-local-default`, which was a claim about the policy that the session
 * had never made. Now `full-access` is a real id with real semantics, and the
 * chip's tooltip still carries the raw value so the label can always be checked
 * against what was actually stored.
 */
import type { PermissionProfileId } from "../types";

export interface PermissionProfile {
  id: PermissionProfileId;
  label: string;
  /** One line on what this level actually permits. Never marketing copy. */
  description: string;
}

/**
 * Ordered most permissive first, which is also least-interrupting first. The
 * menu reads as a descent into caution rather than an arbitrary list.
 */
export const PERMISSION_PROFILES: readonly PermissionProfile[] = [
  {
    id: "full-access",
    label: "Full workspace access",
    description: "Runs commands and edits this workspace without asking; host access stays sandboxed",
  },
  {
    id: "auto",
    label: "Auto",
    description: "Works in the workspace freely; asks before network access",
  },
  {
    id: "ask",
    label: "Ask for approval",
    description: "Asks before every edit, command, or fetch",
  },
];

/**
 * What a project runs as when it has not said otherwise.
 *
 * Deliberately the most permissive level: it is what the control plane applies
 * to a session that names no profile, and a client that displayed a *safer*
 * level than the one actually in force would be lying in the one place an
 * operator checks before letting an agent loose.
 */
export const DEFAULT_PERMISSION_PROFILE: PermissionProfileId = "full-access";

/**
 * Read whatever the session is holding as one of the three levels.
 *
 * Legacy ids (`secure-local-default`) and anything unrecognised resolve to the
 * default rather than to a made-up fourth state, because the control plane
 * will run those sessions at the default too. {@link isKnownPermissionProfile}
 * is how a caller can still tell that it was interpreting rather than reading.
 */
export function resolvePermissionProfile(raw: string | null | undefined): PermissionProfileId {
  const value = raw?.trim().toLowerCase() ?? "";
  const match = PERMISSION_PROFILES.find((profile) => profile.id === value);
  return match?.id ?? DEFAULT_PERMISSION_PROFILE;
}

/** Whether the stored value is one this client actually recognises. */
export function isKnownPermissionProfile(raw: string | null | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  return PERMISSION_PROFILES.some((profile) => profile.id === value);
}

export function permissionProfile(id: PermissionProfileId): PermissionProfile {
  // The union makes this total; the fallback exists so a widened id from an
  // older stored value can never throw inside a render.
  return PERMISSION_PROFILES.find((profile) => profile.id === id) ?? PERMISSION_PROFILES[0]!;
}

export function permissionProfileLabel(id: PermissionProfileId): string {
  return permissionProfile(id).label;
}

/**
 * Whether this level deserves the caution colour.
 *
 * Only full access does. Painting all three orange would spend the one
 * semantic colour this chip owns on states that are working exactly as asked,
 * and an operator who sees amber on every project stops reading it.
 */
export function permissionProfileIsCaution(id: PermissionProfileId): boolean {
  return id === "full-access";
}
