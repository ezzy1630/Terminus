import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactClient } from "@terminus/artifact-client";
import type { Uuid7 } from "@terminus/domain";
import { PrismaContextStore } from "./context-store.js";

const MANIFEST_ID = "00000000-0000-7000-8000-000000000001";

function storeFor(experiment: Readonly<Record<string, unknown>>): PrismaContextStore {
  const row = {
    id: MANIFEST_ID,
    providerAttemptId: null,
    epochId: "00000000-0000-7000-8000-000000000002",
    compilerVersion: "v1",
    policyVersion: "v1",
    modelKey: "test/model",
    experimentJson: JSON.stringify(experiment),
    estimatedTokensJson: JSON.stringify({ output: "10", reasoning: "0", toolResult: "0", recovery: "0" }),
    cachePlanJson: JSON.stringify({
      stablePrefixHash: "sha256:" + "0".repeat(64),
      volatileSuffixBoundary: 0,
      breakpoints: [],
      predictedCachedTokens: "200",
    }),
    fragments: [],
    createdAt: new Date("2026-08-27T00:00:00Z"),
  };
  const db = {
    contextManifest: {
      findUnique: async () => row,
    },
  } as unknown as PrismaClient;
  return new PrismaContextStore(
    db,
    null as unknown as ArtifactClient,
    {
      sessionId: "session",
      taskId: "task",
      turnId: "turn",
      workspaceId: "workspace",
    },
  );
}

describe("PrismaContextStore cache observation read-back", () => {
  test("reads the explicit observed cache count from the durable observation", async () => {
    const store = storeFor({
      providerCapabilityHash: "sha256:" + "1".repeat(64),
      observation: {
        cache: {
          predictedCachedTokens: "200",
          observedCachedTokens: "175",
          ratio: 0.875,
        },
      },
    });

    const manifest = await store.getManifest(MANIFEST_ID as Uuid7);

    expect(manifest?.observedCachedTokens).toBe(175n);
  });

  test("keeps malformed or absent cache observations unknown", async () => {
    const malformed = await storeFor({
      observation: { cache: { observedCachedTokens: "not-a-count" } },
    }).getManifest(MANIFEST_ID as Uuid7);
    const absent = await storeFor({ observation: { usage: "{}" } }).getManifest(MANIFEST_ID as Uuid7);

    expect(malformed?.observedCachedTokens).toBeNull();
    expect(absent?.observedCachedTokens).toBeNull();
  });
});
