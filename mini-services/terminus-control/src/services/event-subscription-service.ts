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
    push: (event: TEvent) => void | Promise<void>,
  ) => Promise<void>;
  /** Persist stream progress in its own short writer transaction. */
  readonly persistCursor: (
    streamName: string,
    lastEventId: string,
    lastSequence: number,
  ) => Promise<void>;
}

export interface EventSubscriptionLimits {
  readonly maxBufferedEvents?: number;
  readonly maxPendingEvents?: number;
  readonly maxSentEventIds?: number;
}

export interface EventSubscriptionRequest<TEvent extends EventCursorRecord> {
  readonly streamName: string;
  readonly cursor: string | null;
  readonly filter: (event: TEvent) => boolean;
  readonly onEvent: (event: TEvent) => void | Promise<void>;
  readonly onCursorExpired?: (expired: EventCursorExpired) => void | Promise<void>;
  /** Report a post-open delivery failure so the transport can close explicitly. */
  readonly onError?: (error: Error) => void | Promise<void>;
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
    private readonly limits: EventSubscriptionLimits = {},
  ) {}

  async open(request: EventSubscriptionRequest<TEvent>): Promise<EventSubscriptionHandle> {
    let replaying = true;
    let closed = false;
    let aborted = false;
    let failure: Error | null = null;
    let lastEventId = request.cursor;
    let lastSequence = 0;
    const sent = new Set<string>();
    const buffered = new Map<string, TEvent>();
    const pending = new Map<string, TEvent>();
    const maxBufferedEvents = this.limits.maxBufferedEvents ?? 10_000;
    const maxPendingEvents = this.limits.maxPendingEvents ?? maxBufferedEvents;
    const maxSentEventIds = this.limits.maxSentEventIds ?? 100_000;
    if (
      !Number.isSafeInteger(maxBufferedEvents)
      || !Number.isSafeInteger(maxPendingEvents)
      || !Number.isSafeInteger(maxSentEventIds)
      || maxBufferedEvents <= 0
      || maxPendingEvents <= 0
      || maxSentEventIds <= 0
    ) {
      throw new Error("event subscription limits must be positive");
    }

    let unsubscribe: (() => void) | null = null;
    let liveDrainActive = false;
    let liveDrain: Promise<void> = Promise.resolve();
    let resolveAborted: (() => void) | undefined;
    const abortedPromise = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });

    const notifyError = (error: Error): void => {
      const callback = request.onError;
      if (!callback) return;
      void Promise.resolve(callback(error)).catch(() => undefined);
    };

    const stop = (error?: Error): void => {
      if (error && failure === null) {
        failure = error;
        notifyError(error);
      }
      if (aborted) return;
      aborted = true;
      resolveAborted?.();
      unsubscribe?.();
    };

    const abort = (): void => { stop(); };
    if (request.signal?.aborted) stop();
    request.signal?.addEventListener("abort", abort, { once: true });

    const deliver = async (event: TEvent): Promise<void> => {
      if (closed || aborted || sent.has(event.eventId)) return;
      if (sent.size >= maxSentEventIds) {
        const error = new Error(`event subscription exceeded the ${maxSentEventIds}-event limit`);
        stop(error);
        throw error;
      }
      if (lastEventId !== null && event.eventId <= lastEventId) {
        const error = new Error(`event subscription received event ${event.eventId} out of order after ${lastEventId}`);
        stop(error);
        throw error;
      }
      sent.add(event.eventId);
      lastEventId = event.eventId;
      lastSequence = event.aggregateSequence;
      try {
        await request.onEvent(event);
      } catch (error: unknown) {
        const deliveryError = error instanceof Error ? error : new Error(String(error));
        stop(deliveryError);
        throw deliveryError;
      }
    };

    const failOverflow = (phase: "replay" | "live"): void => {
      stop(new Error(`event subscription ${phase} buffer exceeded its configured limit`));
    };

    const drainPending = async (): Promise<void> => {
      // skipcq: JS-0092
      while (!closed && !aborted && pending.size > 0) {
        const event = [...pending.values()].sort((left, right) =>
          left.eventId === right.eventId ? 0 : left.eventId < right.eventId ? -1 : 1)[0];
        if (!event) break;
        pending.delete(event.eventId);
        await deliver(event);
      }
    };

    const schedulePending = (): void => {
      if (liveDrainActive || closed || aborted) return;
      liveDrainActive = true;
      liveDrain = drainPending().catch((error: unknown) => {
        const deliveryError = error instanceof Error ? error : new Error(String(error));
        stop(deliveryError);
      }).finally(() => {
        liveDrainActive = false;
        if (!closed && !aborted && pending.size > 0) schedulePending();
      });
    };

    unsubscribe = this.dependencies.subscribeLive(request.filter, (event) => {
      if (replaying) {
        if (sent.has(event.eventId) || buffered.has(event.eventId)) return;
        if (buffered.size >= maxBufferedEvents) {
          failOverflow("replay");
          return;
        }
        buffered.set(event.eventId, event);
        return;
      }
      if (sent.has(event.eventId) || pending.has(event.eventId)) return;
      if (pending.size >= maxPendingEvents) {
        failOverflow("live");
        return;
      }
      pending.set(event.eventId, event);
      schedulePending();
    });

    const awaitAbortable = async <T>(operation: Promise<T>): Promise<T> => {
      if (aborted) throw new Error("event subscription aborted");
      return Promise.race([
        operation,
        abortedPromise.then(() => { throw new Error("event subscription aborted"); }),
      ]);
    };

    try {
      if (request.signal?.aborted) abort();
      if (aborted) throw new Error("event subscription aborted before replay");
      const highWater = await awaitAbortable(this.dependencies.latestEventId());
      if (request.cursor !== null) {
        const oldest = await awaitAbortable(this.dependencies.oldestEventId());
        const known = await awaitAbortable(this.dependencies.eventExists(request.cursor));
        if (!known && oldest !== null && request.cursor < oldest) {
          lastEventId = oldest;
          await awaitAbortable(Promise.resolve(request.onCursorExpired?.({
            requestedCursor: request.cursor,
            oldestRetainedEventId: oldest,
          })));
        } else if (!known && highWater !== null && request.cursor > highWater) {
          throw new Error(`event cursor ${request.cursor} is newer than the latest retained event ${highWater}`);
        } else if (!known) {
          throw new Error(`event cursor ${request.cursor} is not retained`);
        } else if (highWater !== null) {
          await awaitAbortable(this.dependencies.replay(request.cursor, highWater, request.filter, deliver));
        }
      }

      // Keep replay mode active while draining. Async transport writes can
      // yield to a publisher; any event arriving during the drain must stay
      // in the buffer and be included before the live phase begins.
      while (buffered.size > 0) {
        const events = [...buffered.values()].sort((left, right) =>
          left.eventId === right.eventId ? 0 : left.eventId < right.eventId ? -1 : 1);
        for (const event of events) {
          if (!buffered.delete(event.eventId)) continue;
          await awaitAbortable(deliver(event));
        }
      }
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
        stop();
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
