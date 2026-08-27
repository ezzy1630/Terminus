/** Shared ports used by the control-plane services.
 *
 * The services do not own a database connection or an HTTP server. The
 * composition root supplies these narrow ports so transaction ownership stays
 * visible at each call site.
 */

export type MutationRunner = <TResult>(
  operation: () => Promise<TResult>,
) => Promise<TResult>;

export interface ServiceEventInput {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifactRefs?: readonly string[];
}

export type ServiceEventAppender<TTransaction> = (
  event: ServiceEventInput,
  mutation: (transaction: TTransaction) => Promise<void>,
) => Promise<void>;
