export const SESSION_STATUSES = ["active", "paused", "archived", "deleted"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Resuming is the inverse of pausing; terminal states are not resurrected. */
export function canResumeSession(status: string): status is "paused" {
  return status === "paused";
}
