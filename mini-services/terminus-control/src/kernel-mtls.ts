/**
 * Privileged kernel transport over mTLS (SPEC §48.14 / ADR-0007).
 * Mutual TLS authenticates peers; capability tokens still authorize ops.
 */
import { readFileSync } from "node:fs";
import {
  Client,
  ChannelCredentials,
  Metadata,
  type CallOptions,
} from "@grpc/grpc-js";
import { Observable } from "rxjs";
import { kernelDeadline } from "./kernel-deadlines.js";
import {
  ArtifactIngestServiceClientImpl,
  CodeIntelligenceServiceClientImpl,
  ConnectorServiceClientImpl,
  ExtensionRuntimeServiceClientImpl,
  FileServiceClientImpl,
  JobServiceClientImpl,
  KernelInfoServiceClientImpl,
  NetworkServiceClientImpl,
  PatchServiceClientImpl,
  PolicyServiceClientImpl,
  ProcessServiceClientImpl,
  SandboxServiceClientImpl,
  SecretServiceClientImpl,
  WorkspaceServiceClientImpl,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { KernelUdsClients } from "./kernel-uds.js";

export interface KernelMtlsConfig {
  readonly endpoint: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath: string;
  readonly capabilityToken: string;
  /** Expected peer identity (`kernel:<id>`). Checked after GetInfo. */
  readonly expectedKernelId: string;
}

type UnarySerialize = (value: Uint8Array) => Buffer;
type UnaryDeserialize = (value: Buffer) => Uint8Array;

interface GeneratedRpc {
  request(service: string, method: string, data: Uint8Array): Promise<Uint8Array>;
  clientStreamingRequest(service: string, method: string, data: Observable<Uint8Array>): Promise<Uint8Array>;
  serverStreamingRequest(service: string, method: string, data: Uint8Array): Observable<Uint8Array>;
  bidirectionalStreamingRequest(service: string, method: string, data: Observable<Uint8Array>): Observable<Uint8Array>;
}

class MtlsRpc implements GeneratedRpc {
  private readonly client: Client;
  private readonly metadata: Metadata;

  constructor(config: KernelMtlsConfig) {
    if (config.endpoint.includes("://") || config.endpoint.includes("@")) {
      throw new Error("mTLS endpoint must be host:port without scheme or credentials");
    }
    const rootCerts = readFileSync(config.caPath);
    const privateKey = readFileSync(config.keyPath);
    const certChain = readFileSync(config.certPath);
    const creds = ChannelCredentials.createSsl(rootCerts, privateKey, certChain);
    this.client = new Client(config.endpoint, creds);
    this.metadata = new Metadata();
    if (config.capabilityToken) {
      this.metadata.set("x-capability-token", config.capabilityToken);
    }
  }

  request(service: string, method: string, data: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest(
        `/${service}/${method}`,
        bytesToBuffer as UnarySerialize,
        bufferToBytes as UnaryDeserialize,
        Buffer.from(data),
        this.metadata,
        // H10: see kernel-uds.ts — every kernel RPC carries a deadline.
        {
          deadline: kernelDeadline({
            qualifiedMethod: `${service}/${method}`,
            streaming: false,
          }),
        } satisfies CallOptions,
        (error: Error | null, response?: Uint8Array) => {
          if (error) reject(error);
          else if (response) resolve(response);
          else reject(new Error(`empty response from ${service}.${method}`));
        },
      );
    });
  }

  clientStreamingRequest(_service: string, _method: string, _data: Observable<Uint8Array>): Promise<Uint8Array> {
    return Promise.reject(new Error("client-streaming kernel RPCs are not declared"));
  }

  serverStreamingRequest(service: string, method: string, data: Uint8Array): Observable<Uint8Array> {
    return new Observable<Uint8Array>((subscriber) => {
      const call = this.client.makeServerStreamRequest(
        `/${service}/${method}`,
        bytesToBuffer as UnarySerialize,
        bufferToBytes as UnaryDeserialize,
        Buffer.from(data),
        this.metadata,
        // A streaming call may legitimately run for as long as the turn has
        // left, bounded by MAX_STREAMING_KERNEL_DEADLINE_MS (H10).
        {
          deadline: kernelDeadline({
            qualifiedMethod: `${service}/${method}`,
            streaming: true,
          }),
        } satisfies CallOptions,
      );
      call.on("data", (value: Uint8Array) => subscriber.next(value));
      call.on("end", () => subscriber.complete());
      call.on("error", (error: Error) => subscriber.error(error));
      return () => call.cancel();
    });
  }

  bidirectionalStreamingRequest(_service: string, _method: string, _data: Observable<Uint8Array>): Observable<Uint8Array> {
    return new Observable<Uint8Array>((subscriber) => {
      subscriber.error(new Error("bidirectional kernel RPCs are not declared"));
    });
  }
}

export type KernelMtlsClients = KernelUdsClients;

export function createKernelMtlsClients(config: KernelMtlsConfig): KernelMtlsClients {
  const rpc = new MtlsRpc(config);
  return {
    info: new KernelInfoServiceClientImpl(rpc),
    workspaces: new WorkspaceServiceClientImpl(rpc),
    files: new FileServiceClientImpl(rpc),
    patch: new PatchServiceClientImpl(rpc),
    process: new ProcessServiceClientImpl(rpc),
    jobs: new JobServiceClientImpl(rpc),
    sandbox: new SandboxServiceClientImpl(rpc),
    policies: new PolicyServiceClientImpl(rpc),
    secrets: new SecretServiceClientImpl(rpc),
    network: new NetworkServiceClientImpl(rpc),
    connectors: new ConnectorServiceClientImpl(rpc),
    codeIntel: new CodeIntelligenceServiceClientImpl(rpc),
    extensions: new ExtensionRuntimeServiceClientImpl(rpc),
    artifacts: new ArtifactIngestServiceClientImpl(rpc),
  };
}

/** After connect, assert GetInfo.instanceId matches expected kernel identity. */
export async function assertRemoteKernelIdentity(
  clients: KernelMtlsClients,
  expectedKernelId: string,
): Promise<void> {
  const info = await clients.info.GetInfo({});
  const instanceId = (info as { instanceId?: string }).instanceId ?? "";
  if (instanceId !== expectedKernelId) {
    throw new Error(
      `identity isolation violation: kernel reported ${instanceId}, expected ${expectedKernelId}`,
    );
  }
}

function bytesToBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

function bufferToBytes(value: Buffer): Uint8Array {
  return new Uint8Array(value);
}
