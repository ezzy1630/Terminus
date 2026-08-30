export interface TurnStateUpdater {
  updateMany(input: {
    readonly where: { readonly id: string; readonly state: "RESPONSE_VALIDATING" };
    readonly data: { readonly state: "CONTEXT_COMPILING" };
  }): Promise<{ readonly count: number }>;
}

/**
 * Re-arm a settled provider response before a durable steering continuation.
 *
 * Provider attempt admission is compare-and-swap guarded on
 * `CONTEXT_COMPILING`. A continuation queued while the turn remains in
 * `RESPONSE_VALIDATING` is durable but impossible to execute. Keep the state
 * transition in the same transaction as the steering episode.
 */
export async function prepareTurnForProviderContinuation(
  turns: TurnStateUpdater,
  turnId: string,
): Promise<void> {
  const update = await turns.updateMany({
    where: { id: turnId, state: "RESPONSE_VALIDATING" },
    data: { state: "CONTEXT_COMPILING" },
  });
  if (update.count !== 1) {
    throw new Error(`turn ${turnId} changed before provider continuation`);
  }
}
