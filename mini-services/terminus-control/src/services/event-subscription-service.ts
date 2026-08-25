export interface EventCursorRecord {
  readonly eventId: string;
  readonly aggregateSequence: number;
}

export interface EventCursorExpired {
  readonly requestedCursor: string;
  readonly oldestRetainedEventId: string;
}

export interface EventSubscriptionDependencies<TEvent extends EventCursorRecord> {
  /** Subscribe to events that have already crossed the durable publish boundary. */
  readonly subscribeLive: (
    filter: (event: TEvent) => boolean,
    push: (event: TEvent) => void,
  ) => () => void;
  /** Read only committed event rows. */
  readonly latestEventId: () => Promise<string | null>;
  readonly oldestEventId: () => Promise<string | null>;
  /** Distinguish a retained cursor from a fabricated/future cursor. */
  readonly eventExists: (eventId: string) => Promise<boolean>;
  readonly replay: (
    sinceEventId: string,
    throughEventId: string,
    filter: (event: TEvent) => boolean,
    push: (event: TEvent) => void,
  ) => Promise<void>;
  /** Persist stream progress in its own short writer transaction. */
  readonly persistCursor: (
    streamName: string,
    lastEventId: string,
    lastSequence: number,
  ) => Promise<void>;
}

export interface EventSubscriptionRequest<TEvent extends EventCursorRecord> {
  readonly streamName: string;
  readonly cursor: string | null;
  readonly filter: (event: TEvent) => boolean;
  readonly onEvent: (event: TEvent) => void;
  readonly onCursorExpired?: (expired: EventCursorExpired) => void;
  readonly signal?: AbortSignal;
}

export interface EventSubscriptionHandle {
  readonly close: () => Promise<void>;
  readonly lastEventId: () => string | null;
}

/**
 * Coordinates durable replay and live delivery for one SSE subscriber.
 *
 * Transaction boundary: this service never publishes an event. The publisher
 * must commit the semantic event and its projection before `subscribeLive`
 * can observe it. Replay reads committed rows; cursor progress is a separate
 * best-effort transaction that must not hold the stream open.
 */
export class EventSubscriptionService<TEvent extends EventCursorRecord> {
  constructor(
    private readonly dependencies: EventSubscriptionDependencies<TEvent>,
    private readonly limits: { readonly maxBufferedEvents?: number; readonly maxSentEventIds?: number } = {},
  ) {}

  async open(request: EventSubscriptionRequest<TEvent>): Promise<EventSubscriptionHandle> {
    let replaying = true;
    let closed = false;
    let aborted = false;
    let lastEventId = request.cursor;
    let lastSequence = 0;
    const sent = new Set<string>();
    const buffered = new Map<string, TEvent>();
    const maxBufferedEvents = this.limits.maxBufferedEvents ?? 10_000;
    const maxSentEventIds = this.limits.maxSentEventIds ?? 100_000;
    if (maxBufferedEvents <= 0 || maxSentEventIds <= 0) {
      throw new Error("event subscription limits must be positive");
    }

    let unsubscribe: (() => void) | null = null;
    const abort = (): void => {
      aborted = true;
      unsubscribe?.();
    };
    request.signal?.addEventListener("abort", abort, { once: true });

    const deliver = (event: TEvent): void => {
      if (closed || aborted || sent.has(event.eventId)) return;
      if (sent.size >= maxSentEventIds) {
        aborted = true;
        unsubscribe?.();
        return;
      }
      sent.add(event.eventId);
      lastEventId = event.eventId;
      lastSequence = event.aggregateSequence;
      request.onEvent(event);
    };

    unsubscribe = this.dependencies.subscribeLive(request.filter, (event) => {
      if (replaying) {
        if (!buffered.has(event.eventId) && buffered.size >= maxBufferedEvents) {
          aborted = true;
          unsubscribe?.();
          return;
        }
        buffered.set(event.eventId, event);
      }
      else deliver(event);
    });

    try {
      if (request.signal?.aborted) abort();
      if (aborted) throw new Error("event subscription aborted before replay");
      const highWater = await this.dependencies.latestEventId();
      if (request.cursor !== null) {
        const oldest = await this.dependencies.oldestEventId();
        const known = await this.dependencies.eventExists(request.cursor);
        if (!known && oldest !== null && request.cursor < oldest) {
          lastEventId = oldest;
          request.onCursorExpired?.({
            requestedCursor: request.cursor,
            oldestRetainedEventId: oldest,
          });
        } else if (!known && highWater !== null && request.cursor > highWater) {
          throw new Error(`event cursor ${request.cursor} is newer than the latest retained event ${highWater}`);
        } else if (!known) {
          throw new Error(`event cursor ${request.cursor} is not retained`);
        } else if (highWater !== null) {
          await this.dependencies.replay(request.cursor, highWater, request.filter, deliver);
        }
      }

      for (const event of [...buffered.values()].sort((left, right) =>
        left.eventId === right.eventId ? 0 : left.eventId < right.eventId ? -1 : 1)) {
        deliver(event);
      }
      buffered.clear();
      if (aborted) throw new Error("event subscription aborted during replay");
      replaying = false;
    } catch (error: unknown) {
      unsubscribe?.();
      request.signal?.removeEventListener("abort", abort);
      throw error;
    }

    return {
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        request.signal?.removeEventListener("abort", abort);
        if (lastEventId !== null) {
          await this.dependencies.persistCursor(request.streamName, lastEventId, lastSequence);
        }
      },
      lastEventId: (): string | null => lastEventId,
    };
  }
}
