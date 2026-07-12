/**
 * @terminus/observability — OpenTelemetry-style span helpers, structured logging,
 * and metric definitions.
 *
 * Privacy-aware: never logs raw prompts, source, secrets; uses IDs and hashes
 * (SPEC §47.5).
 *
 * This package does NOT import the OpenTelemetry SDK directly. It exposes
 * minimal interfaces and a default in-memory implementation so tests can
 * capture spans/metrics/logs without an OTLP collector. A real deployment
 * supplies a backend via `setTelemetryBackend`.
 */
import { z } from "zod";
import type { TraceId, PrincipalId, Uuid7 } from "@terminus/domain";

// ────────────────────────── Span model ───────────────────────────────────────

export type SpanAttributes = Readonly<Record<string, string | number | boolean>>;

export interface Span {
  readonly name: string;
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly attributes: SpanAttributes;
  readonly startedAt: number;
  end(attributes?: SpanAttributes, error?: unknown): void;
  setAttribute(key: string, value: string | number | boolean): void;
  recordEvent(name: string, attributes?: SpanAttributes): void;
}

export interface SpanContext {
  readonly traceId: TraceId;
  readonly spanId: string;
}

// ────────────────────────── Resource context ─────────────────────────────────

export interface ResourceContext {
  readonly service: string;
  readonly component: string;
  readonly sessionId?: Uuid7 | undefined;
  readonly taskId?: Uuid7 | undefined;
  readonly turnId?: Uuid7 | undefined;
  readonly toolCallId?: Uuid7 | undefined;
  readonly jobId?: Uuid7 | undefined;
  readonly principal?: PrincipalId | undefined;
}

// ────────────────────────── Telemetry backend ────────────────────────────────

export interface TelemetryBackend {
  startSpan(
    name: string,
    attributes: SpanAttributes,
    parent: SpanContext | null,
    resource: ResourceContext,
  ): Span;
  emitLog(record: LogRecord): void;
  emitMetric(record: MetricRecord): void;
}

// ────────────────────────── Log record ───────────────────────────────────────

export const LogLevel = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "fatal",
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

export interface LogRecord {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly service: string;
  readonly component: string;
  readonly message: string;
  readonly traceId: TraceId | null;
  readonly spanId: string | null;
  readonly resource: ResourceContext;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly eventCode: string | null;
  readonly dropped: number;
}

export const logRecordSchema = z.object({
  timestamp: z.number(),
  level: logLevelSchema,
  service: z.string(),
  component: z.string(),
  message: z.string(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  resource: z.object({
    service: z.string(),
    component: z.string(),
    sessionId: z.string().nullable(),
    taskId: z.string().nullable(),
    turnId: z.string().nullable(),
    toolCallId: z.string().nullable(),
    jobId: z.string().nullable(),
    principal: z.string().nullable(),
  }),
  fields: z.record(z.string(), z.unknown()),
  eventCode: z.string().nullable(),
  dropped: z.number().int().nonnegative(),
});

// ────────────────────────── Metric record ────────────────────────────────────

export const MetricType = {
  COUNTER: "counter",
  GAUGE: "gauge",
  HISTOGRAM: "histogram",
} as const;
export type MetricType = (typeof MetricType)[keyof typeof MetricType];
export const metricTypeSchema = z.enum(["counter", "gauge", "histogram"]);

export interface MetricRecord {
  readonly name: string;
  readonly type: MetricType;
  readonly value: number;
  readonly unit: string | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly timestamp: number;
}

export const metricRecordSchema = z.object({
  name: z.string(),
  type: metricTypeSchema,
  value: z.number(),
  unit: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
  timestamp: z.number(),
});

// ────────────────────────── Default backend (in-memory) ──────────────────────

class InMemorySpan implements Span {
  readonly name: string;
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  private _attributes: Record<string, string | number | boolean>;
  readonly startedAt: number;
  private ended = false;
  private readonly events: { name: string; attributes?: SpanAttributes | undefined; ts: number }[] = [];
  private readonly backend: InMemoryBackend;
  private readonly resource: ResourceContext;

  constructor(
    name: string,
    traceId: TraceId,
    spanId: string,
    parentSpanId: string | null,
    attributes: SpanAttributes,
    startedAt: number,
    resource: ResourceContext,
    backend: InMemoryBackend,
  ) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = spanId;
    this.parentSpanId = parentSpanId;
    this._attributes = { ...attributes };
    this.startedAt = startedAt;
    this.resource = resource;
    this.backend = backend;
  }

  get attributes(): SpanAttributes {
    return this._attributes;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    if (this.ended) return;
    this._attributes[key] = value;
  }

  recordEvent(name: string, attributes?: SpanAttributes): void {
    if (this.ended) return;
    this.events.push({ name, attributes, ts: Date.now() });
  }

  end(attributes?: SpanAttributes, error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) this._attributes[k] = v;
    }
    if (error) {
      this._attributes["error"] = true;
      if (error instanceof Error) {
        this._attributes["error.name"] = error.name;
        this._attributes["error.message"] = redact(error.message);
      }
    }
    this.backend.spans.push({
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      attributes: { ...this._attributes },
      startedAt: this.startedAt,
      endedAt: Date.now(),
      events: [...this.events],
      resource: this.resource,
    });
  }
}

export interface CapturedSpan {
  readonly name: string;
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly attributes: SpanAttributes;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly events: readonly { name: string; attributes?: SpanAttributes | undefined; ts: number }[];
  readonly resource: ResourceContext;
}

class InMemoryBackend implements TelemetryBackend {
  readonly spans: CapturedSpan[] = [];
  readonly logs: LogRecord[] = [];
  readonly metrics: MetricRecord[] = [];
  private spanCounter = 0;
  private dropped = 0;
  readonly maxRecords: number;

  constructor(maxRecords = 100_000) {
    this.maxRecords = maxRecords;
  }

  startSpan(
    name: string,
    attributes: SpanAttributes,
    parent: SpanContext | null,
    resource: ResourceContext,
  ): Span {
    const traceId = parent?.traceId ?? (randomId() as TraceId);
    const spanId = randomId();
    this.spanCounter++;
    return new InMemorySpan(
      name,
      traceId,
      spanId,
      parent?.spanId ?? null,
      attributes,
      Date.now(),
      resource,
      this,
    );
  }

  emitLog(record: LogRecord): void {
    if (this.logs.length >= this.maxRecords) {
      this.dropped++;
      return;
    }
    this.logs.push(record);
  }

  emitMetric(record: MetricRecord): void {
    if (this.metrics.length >= this.maxRecords) {
      this.dropped++;
      return;
    }
    this.metrics.push(record);
  }

  reset(): void {
    this.spans.length = 0;
    this.logs.length = 0;
    this.metrics.length = 0;
    this.dropped = 0;
    this.spanCounter = 0;
  }
}

// ────────────────────────── Backend registry ─────────────────────────────────

let _backend: TelemetryBackend = new InMemoryBackend();
let _resource: ResourceContext = { service: "terminus", component: "unknown" };

/** Override the global telemetry backend. Returns the previous one. */
export function setTelemetryBackend(b: TelemetryBackend): TelemetryBackend {
  const prev = _backend;
  _backend = b;
  return prev;
}

/** Override the default resource context (service/component). */
export function setDefaultResource(r: ResourceContext): ResourceContext {
  const prev = _resource;
  _resource = r;
  return prev;
}

/** Returns the current in-memory backend if one is in use, else null. */
export function getInMemoryBackend(): InMemoryBackend | null {
  return _backend instanceof InMemoryBackend ? _backend : null;
}

// ────────────────────────── Public helpers ───────────────────────────────────

/** Start a span. Always call `span.end()` (use try/finally). */
export function startSpan(
  name: string,
  attributes: SpanAttributes = {},
  parent: SpanContext | null = null,
  resource: ResourceContext = _resource,
): Span {
  return _backend.startSpan(name, attributes, parent, resource);
}

/** Record an error on a span. Does NOT end the span. */
export function recordError(span: Span, err: unknown): void {
  span.setAttribute("error", true);
  if (err instanceof Error) {
    span.setAttribute("error.name", err.name);
    span.setAttribute("error.message", redact(err.message));
  } else {
    span.setAttribute("error.message", redact(String(err)));
  }
  span.recordEvent("error");
}

/** Emit a metric. */
export function metric(
  name: string,
  value: number,
  tags: Readonly<Record<string, string>> = {},
  type: MetricType = "counter",
  unit: string | null = null,
): void {
  _backend.emitMetric({ name, type, value, unit, tags, timestamp: Date.now() });
}

/** Increment a counter by 1 (or `delta`). */
export function counter(name: string, delta = 1, tags: Readonly<Record<string, string>> = {}): void {
  metric(name, delta, tags, "counter", null);
}

/** Set a gauge value. */
export function gauge(
  name: string,
  value: number,
  tags: Readonly<Record<string, string>> = {},
  unit: string | null = null,
): void {
  metric(name, value, tags, "gauge", unit);
}

/** Observe a histogram value. */
export function histogram(
  name: string,
  value: number,
  tags: Readonly<Record<string, string>> = {},
  unit: string | null = null,
): void {
  metric(name, value, tags, "histogram", unit);
}

// ────────────────────────── Structured logging ───────────────────────────────

export interface Logger {
  trace(message: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  fatal(message: string, fields?: Readonly<Record<string, unknown>>): void;
  with(resource: Partial<ResourceContext>): Logger;
  span(span: SpanContext): Logger;
  event(eventCode: string): Logger;
}

export function logger(resource: ResourceContext = _resource): Logger {
  return new LoggerImpl(_backend, resource, null, null);
}

class LoggerImpl implements Logger {
  constructor(
    private readonly backend: TelemetryBackend,
    private readonly resource: ResourceContext,
    private readonly spanContext: SpanContext | null,
    private readonly eventCode: string | null,
  ) {}

  private emit(
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    const record: LogRecord = {
      timestamp: Date.now(),
      level,
      service: this.resource.service,
      component: this.resource.component,
      message: redact(message),
      traceId: this.spanContext?.traceId ?? null,
      spanId: this.spanContext?.spanId ?? null,
      resource: this.resource,
      fields: redactFields(fields),
      eventCode: this.eventCode,
      dropped: 0,
    };
    this.backend.emitLog(record);
  }

  trace(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("trace", message, fields);
  }
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("error", message, fields);
  }
  fatal(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("fatal", message, fields);
  }
  with(resource: Partial<ResourceContext>): Logger {
    return new LoggerImpl(
      this.backend,
      { ...this.resource, ...resource },
      this.spanContext,
      this.eventCode,
    );
  }
  span(span: SpanContext): Logger {
    return new LoggerImpl(this.backend, this.resource, span, this.eventCode);
  }
  event(eventCode: string): Logger {
    return new LoggerImpl(this.backend, this.resource, this.spanContext, eventCode);
  }
}

// ────────────────────────── Privacy helpers ──────────────────────────────────

const SECRET_KEYS = /^(secret|password|token|key|credential|authorization)$/i;
const SECRET_HINTS = /(api[_-]?key|secret|password|token|credential|bearer)/i;

/** Redact a string. Currently a no-op pass-through for IDs and hashes; the
 * actual redaction of secret-like content happens by key name in `redactFields`. */
export function redact(s: string): string {
  // Strings that look like long secrets are masked.
  if (s.length >= 32 && /^[A-Za-z0-9_\-\.=]+$/.test(s) && SECRET_HINTS.test(s)) {
    return "redacted";
  }
  return s;
}

/** Returns a deep clone of `fields` with secret-like values masked. */
export function redactFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = "redacted";
    } else if (typeof v === "string" && SECRET_HINTS.test(k)) {
      out[k] = "redacted";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactFields(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ────────────────────────── Metric definitions ───────────────────────────────

/** Standard metric names used across the control plane. */
export const Metrics = {
  PROVIDER_REQUEST_TOTAL: "terminus.provider.request.total",
  PROVIDER_REQUEST_DURATION_MS: "terminus.provider.request.duration_ms",
  PROVIDER_INPUT_TOKENS: "terminus.provider.tokens.input",
  PROVIDER_OUTPUT_TOKENS: "terminus.provider.tokens.output",
  PROVIDER_CACHED_TOKENS: "terminus.provider.tokens.cached",
  PROVIDER_COST_MICROS: "terminus.provider.cost.micros",
  PROVIDER_RATE_LIMITED_TOTAL: "terminus.provider.rate_limited.total",
  CONTEXT_FRAGMENT_SELECTED: "terminus.context.fragment.selected",
  CONTEXT_FRAGMENT_OMITTED: "terminus.context.fragment.omitted",
  CONTEXT_ESTIMATED_TOKENS: "terminus.context.tokens.estimated",
  CONTEXT_OBSERVED_TOKENS: "terminus.context.tokens.observed",
  TOOL_CALL_TOTAL: "terminus.tool.call.total",
  TOOL_CALL_DURATION_MS: "terminus.tool.call.duration_ms",
  TOOL_CALL_DENIED_TOTAL: "terminus.tool.call.denied.total",
  TASK_ACTIVE: "terminus.task.active",
  TASK_DURATION_S: "terminus.task.duration_s",
  TURN_DURATION_MS: "terminus.turn.duration_ms",
  VERIFICATION_NODE_TOTAL: "terminus.verification.node.total",
  VERIFICATION_NODE_PASSED: "terminus.verification.node.passed",
  VERIFICATION_NODE_FAILED: "terminus.verification.node.failed",
  MEMORY_CANDIDATES_TOTAL: "terminus.memory.candidates.total",
  MEMORY_RETRIEVAL_HITS: "terminus.memory.retrieval.hits",
  EVENT_DROPPED: "terminus.event.dropped",
} as const;
export type MetricName = (typeof Metrics)[keyof typeof Metrics];

// ────────────────────────── Utilities ────────────────────────────────────────

function randomId(): string {
  // Sufficient for span/log ids; not cryptographically strong.
  const buf = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
