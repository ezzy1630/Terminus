/**
 * The only control-plane module allowed to open the privileged kernel
 * transport. All callers use generated ts-proto clients; this bridge owns
 * the gRPC-over-UDS connector and keeps socket details out of domain code.
 */
import {
  Client,
  credentials,
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

type UnarySerialize = (value: Uint8Array) => Buffer;
type UnaryDeserialize = (value: Buffer) => Uint8Array;

interface GeneratedRpc {
  request(service: string, method: string, data: Uint8Array): Promise<Uint8Array>;
  clientStreamingRequest(service: string, method: string, data: Observable<Uint8Array>): Promise<Uint8Array>;
  serverStreamingRequest(service: string, method: string, data: Uint8Array): Observable<Uint8Array>;
  bidirectionalStreamingRequest(service: string, method: string, data: Observable<Uint8Array>): Observable<Uint8Array>;
}

class UdsRpc implements GeneratedRpc {
  private readonly client: Client;
  private readonly metadata: Metadata;

  constructor(socketPath: string, capabilityToken: string, controlBootstrapToken: string) {
    this.client = new Client(`unix://${socketPath}`, credentials.createInsecure());
    this.metadata = new Metadata();
    if (capabilityToken) this.metadata.set("x-capability-token", capabilityToken);
    if (controlBootstrapToken) {
      this.metadata.set("x-terminus-control-bootstrap", controlBootstrapToken);
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
        // H10: without a deadline a kernel that accepts the connection and
        // then stops answering leaves the turn waiting forever.
        {
          deadline: kernelDeadline({
            qualifiedMethod: `${service}/${method}`,
            streaming: false,
          }),
        } satisfies CallOptions,
        (error: Error | null, response?: Uint8Array) => {
          if (error) {
            reject(error);
          } else if (response) {
            resolve(response);
          } else {
            reject(new Error(`empty response from ${service}.${method}`));
          }
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

export interface KernelUdsClients {
  info: KernelInfoServiceClientImpl;
  workspaces: WorkspaceServiceClientImpl;
  files: FileServiceClientImpl;
  patch: PatchServiceClientImpl;
  process: ProcessServiceClientImpl;
  jobs: JobServiceClientImpl;
  sandbox: SandboxServiceClientImpl;
  policies: PolicyServiceClientImpl;
  secrets: SecretServiceClientImpl;
  network: NetworkServiceClientImpl;
  connectors: ConnectorServiceClientImpl;
  codeIntel: CodeIntelligenceServiceClientImpl;
  extensions: ExtensionRuntimeServiceClientImpl;
  artifacts: ArtifactIngestServiceClientImpl;
}

export function createKernelUdsClients(
  socketPath: string,
  capabilityToken: string,
  controlBootstrapToken = "",
): KernelUdsClients {
  const rpc = new UdsRpc(socketPath, capabilityToken, controlBootstrapToken);
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

function bytesToBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

function bufferToBytes(value: Buffer): Uint8Array {
  return new Uint8Array(value);
}
