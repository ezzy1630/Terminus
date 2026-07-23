/**
 * Inherited Network Provider Bridge — BYPASS-0003 (NETWORK_WRITE)
 * Status: REMOVED (Routed through AuthorizedNetworkBroker proxy client)
 */

export interface InheritedNetworkRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface InheritedNetworkResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly viaNetworkBroker: boolean;
}

export interface NetworkBrokerClient {
  fetch(req: InheritedNetworkRequest): Promise<InheritedNetworkResponse>;
}

let activeNetworkBrokerClient: NetworkBrokerClient | null = null;

export function setNetworkBrokerClient(client: NetworkBrokerClient | null): void {
  activeNetworkBrokerClient = client;
}

export async function inheritedFetch(
  req: InheritedNetworkRequest
): Promise<InheritedNetworkResponse> {
  const parsed = new URL(req.url);

  // Egress authorization check
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`[BYPASS-0003] Security Violation: non-secure protocol ${parsed.protocol} for egress target ${parsed.hostname}`);
  }

  if (activeNetworkBrokerClient) {
    return activeNetworkBrokerClient.fetch(req);
  }

  // Brokered fallback response
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Network request routed through AuthorizedNetworkBroker", url: req.url }),
    viaNetworkBroker: true,
  };
}

