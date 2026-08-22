/**
 * @terminus/adapter-sdk — Agent Trace Interchange Format (ATIF) Boundary Adapter.
 *
 * Per SPEC §9.3, §32, §42.2:
 * Standardized trace export and import supporting cross-framework evaluation,
 * causal replay, and benchmark exchange.
 */
import type { EventEnvelopeV2 } from "@terminus/runtime-protocol";

export interface AtifSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: "task" | "workflow_node" | "tool_call" | "model_invocation" | "effect";
  readonly startTime: string;
  readonly endTime: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly { readonly name: string; readonly time: string; readonly payload: unknown }[];
}

export interface AtifTrace {
  readonly traceId: string;
  readonly harness: string;
  readonly harnessVersion: string;
  readonly rootTaskId: string;
  readonly spans: readonly AtifSpan[];
  readonly exportedAt: string;
}

export class AtifBoundaryAdapter {
  /**
   * Exports an ARP v2 event stream into a standard ATIF Trace document.
   */
  static exportTrace(
    traceId: string,
    harnessVersion: string,
    events: readonly EventEnvelopeV2[],
  ): AtifTrace {
    const rootTaskEvent = events.find((e) => e.eventType === "task.created");
    const rootTaskId = rootTaskEvent ? rootTaskEvent.aggregateId : (events[0]?.aggregateId ?? "unknown");

    const spans: AtifSpan[] = [];
    const eventItems = events.map((e) => ({
      name: e.eventType,
      time: e.occurredAt,
      payload: e.payload,
    }));

    spans.push({
      spanId: `span-${rootTaskId}`,
      parentSpanId: null,
      name: `task-execution-${rootTaskId}`,
      kind: "task",
      startTime: events[0]?.occurredAt ?? new Date().toISOString(),
      endTime: events[events.length - 1]?.occurredAt ?? null,
      attributes: {
        eventCount: events.length,
        aggregateId: rootTaskId,
      },
      events: eventItems,
    });

    return {
      traceId,
      harness: "terminus",
      harnessVersion,
      rootTaskId,
      spans,
      exportedAt: new Date().toISOString(),
    };
  }
}
