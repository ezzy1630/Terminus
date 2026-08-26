import { SessionLatencyTracker } from "./session-view";

/** Process-wide TTFT tracker shared by the composer and the event stream. */
export const sessionLatency = new SessionLatencyTracker();
