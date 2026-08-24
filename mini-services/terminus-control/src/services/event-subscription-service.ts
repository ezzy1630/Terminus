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
  ) {}

  async open(request: EventSubscriptionRequest<TEvent>): Promise<EventSubscriptionHandle> {
    let replaying = true;
    let closed = false;
    let lastEventId = request.cursor;
    let lastSequence = 0;
    const sent = new Set<string>();
    const buffered = new Map<string, TEvent>();

    const deliver = (event: TEvent): void => {
      if (closed || sent.has(event.eventId)) return;
      sent.add(event.eventId);
      lastEventId = event.eventId;
      lastSequence = event.aggregateSequence;
      request.onEvent(event);
    };

    const unsubscribe = this.dependencies.subscribeLive(request.filter, (event) => {
      if (replaying) buffered.set(event.eventId, event);
      else deliver(event);
    });

    try {
      const highWater = await this.dependencies.latestEventId();
      if (request.cursor !== null) {
        const oldest = await this.dependencies.oldestEventId();
        if (oldest !== null && request.cursor < oldest) {
          lastEventId = oldest;
          request.onCursorExpired?.({
            requestedCursor: request.cursor,
            oldestRetainedEventId: oldest,
          });
        } else if (highWater !== null) {
          await this.dependencies.replay(request.cursor, highWater, request.filter, deliver);
        }
      }

      for (const event of [...buffered.values()].sort((left, right) =>
        left.eventId.localeCompare(right.eventId))) {
        deliver(event);
      }
      buffered.clear();
      replaying = false;
    } catch (error: unknown) {
      unsubscribe();
      throw error;
    }

    return {
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (lastEventId !== null) {
          await this.dependencies.persistCursor(request.streamName, lastEventId, lastSequence);
        }
      },
      lastEventId: (): string | null => lastEventId,
    };
  }
}
