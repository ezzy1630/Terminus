import { checkpointContentSchema, type CheckpointContent } from "../../packages/context-compiler/src/index.ts";
import { canonicalJson } from "../../packages/context-ir/src/index.ts";

export interface VerifiedCheckpointArtifact {
  readonly hash: `sha256:${string}`;
  readonly bytes: number;
  readonly content: CheckpointContent;
}

export async function verifyCheckpointArtifact(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly artifactUri: string;
  readonly taskId: string;
  readonly taskSourceVersion: string;
  readonly sourceTurnId: string;
  readonly sourceTurnSequence: number;
}): Promise<VerifiedCheckpointArtifact> {
  const match = /^artifact:\/\/sha256\/([0-9a-f]{64})$/.exec(input.artifactUri);
  if (!match) throw new Error(`checkpoint artifact URI is invalid: ${input.artifactUri}`);
  const expectedHash = `sha256:${match[1]}` as const;
  const taskQuery = `task_id=${encodeURIComponent(input.taskId)}`;
  const response = await fetch(
    `${input.baseUrl}/v1/artifacts/${encodeURIComponent(expectedHash)}?${taskQuery}`,
    { headers: { authorization: `Bearer ${input.token}` } },
  );
  if (!response.ok) {
    throw new Error(`checkpoint artifact fetch failed (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actualHash = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (actualHash !== expectedHash) {
    throw new Error(`checkpoint artifact hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const decoded: unknown = JSON.parse(text);
  const parsed = checkpointContentSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`checkpoint artifact schema mismatch: ${parsed.error.message}`);
  }
  if (canonicalJson(parsed.data) !== text) {
    throw new Error("checkpoint artifact was not canonically encoded");
  }
  const taskSourceKey = `task://${input.taskId}`;
  const turnSourceKey = `turn://${input.sourceTurnId}`;
  const sourceKeys = Object.keys(parsed.data.sourceVersions).sort();
  const expectedSourceKeys = [taskSourceKey, turnSourceKey].sort();
  if (
    sourceKeys.length !== expectedSourceKeys.length
    || sourceKeys.some((key, index) => key !== expectedSourceKeys[index])
  ) {
    throw new Error(`checkpoint artifact source set mismatch: ${JSON.stringify(sourceKeys)}`);
  }
  if (parsed.data.sourceVersions[taskSourceKey] !== input.taskSourceVersion) {
    throw new Error(`checkpoint artifact task contract binding is stale for ${input.taskId}`);
  }
  const turnVersion = parsed.data.sourceVersions[turnSourceKey];
  if (
    typeof turnVersion !== "string"
    || !new RegExp(`^${input.sourceTurnSequence}:[A-Z_]+$`).test(turnVersion)
  ) {
    throw new Error(`checkpoint artifact source turn binding is invalid: ${String(turnVersion)}`);
  }
  const metadataResponse = await fetch(
    `${input.baseUrl}/v1/artifacts/${encodeURIComponent(expectedHash)}/metadata?${taskQuery}`,
    {
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
      },
    },
  );
  if (!metadataResponse.ok) {
    throw new Error(`checkpoint artifact metadata fetch failed (${metadataResponse.status})`);
  }
  const metadata: unknown = await metadataResponse.json();
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("checkpoint artifact metadata was not an object");
  }
  const record = metadata as Record<string, unknown>;
  if (record.sha256 !== expectedHash || record.sizeBytes !== bytes.byteLength) {
    throw new Error(`checkpoint artifact metadata mismatch: ${JSON.stringify(record)}`);
  }
  return { hash: expectedHash, bytes: bytes.byteLength, content: parsed.data as unknown as CheckpointContent };
}
