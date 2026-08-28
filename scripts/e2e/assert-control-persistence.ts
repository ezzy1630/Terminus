/** Read-only typed persistence checks for invariants not exposed by v1 views. */

import { PrismaClient } from "@prisma/client";

import {
  PENDING_RECOVERY_TURN_ID,
  POST_PENDING_RECOVERY_TURNS,
} from "./control-fixtures.ts";

type JsonObject = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`control persistence assertion requires ${name}`);
  return value;
}

const databasePath = requiredEnvironment("TERMINUS_TEST_DB");
const turnIds = [
  requiredEnvironment("TERMINUS_TEST_INITIAL_TURN_ID"),
  requiredEnvironment("TERMINUS_TEST_RESUMED_TURN_ID"),
];
const database = new PrismaClient({
  datasources: { db: { url: `file:${databasePath}` } },
});

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as JsonObject;
}

function containsRawUserInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawUserInput);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    key === "user_input" || key === "userInput" || containsRawUserInput(child)
  );
}

try {
  for (const turnId of turnIds) {
    const turn = await database.turn.findUnique({
      where: { id: turnId },
      include: {
        episodes: { orderBy: { sequence: "asc" } },
        providerAttempts: { orderBy: { attemptNumber: "asc" } },
      },
    });
    const startedEvents = await database.semanticEvent.findMany({
      where: { eventType: "turn.started", aggregateType: "turn", aggregateId: turnId },
      select: { payloadJson: true, artifactRefsJson: true },
    });
    const inputEpisode = turn?.episodes.find((episode) =>
      episode.sequence === 1 && episode.kind === "user_message"
    );
    const inputHash = typeof turn?.initiatingInputArtifact === "string"
      ? `sha256:${turn.initiatingInputArtifact.slice("artifact://sha256/".length)}`
      : null;
    const startedPayload = startedEvents.length === 1
      ? object(JSON.parse(startedEvents[0]!.payloadJson) as unknown, `turn.started ${turnId}`)
      : null;
    const startedArtifactRefs = startedEvents.length === 1
      ? JSON.parse(startedEvents[0]!.artifactRefsJson) as unknown
      : null;
    const inputSources = inputEpisode === undefined
      ? null
      : object(JSON.parse(inputEpisode.sourceVersionsJson) as unknown, `episode sources ${turnId}`);
    const providerAttempt = turn?.providerAttempts[0];
    const modelEpisode = turn?.episodes.find((episode) =>
      episode.sequence === 2 && episode.kind === "model_message"
    );
    const providerResponseHash = typeof providerAttempt?.responseArtifact === "string"
      ? `sha256:${providerAttempt.responseArtifact.slice("artifact://sha256/".length)}`
      : null;
    const modelSources = modelEpisode === undefined
      ? null
      : object(JSON.parse(modelEpisode.sourceVersionsJson) as unknown, `model episode sources ${turnId}`);
    const usage = providerAttempt?.usageJson === null || providerAttempt?.usageJson === undefined
      ? null
      : object(JSON.parse(providerAttempt.usageJson) as unknown, `provider usage ${turnId}`);
    if (
      !turn
      || typeof turn.initiatingInputArtifact !== "string"
      || !turn.initiatingInputArtifact.startsWith("artifact://sha256/")
      || !inputEpisode
      || inputEpisode.contentArtifact !== turn.initiatingInputArtifact
      || inputEpisode.modelVisible !== true
      || startedPayload?.input_artifact !== turn.initiatingInputArtifact
      || startedPayload.input_hash !== inputHash
      || containsRawUserInput(startedPayload)
      || !Array.isArray(startedArtifactRefs)
      || !startedArtifactRefs.includes(turn.initiatingInputArtifact)
      || inputSources?.input !== inputHash
      || turn.providerAttempts.length !== 1
      || providerAttempt?.status !== "completed"
      || providerAttempt.responseArtifact === null
      || !providerAttempt.responseArtifact.startsWith("artifact://sha256/")
      || providerAttempt.completedAt === null
      || !modelEpisode
      || modelEpisode.contentArtifact === null
      || !modelEpisode.contentArtifact.startsWith("artifact://sha256/")
      || modelSources?.providerAttemptId !== providerAttempt.id
      || typeof modelSources?.response !== "string"
      || usage?.inputTokens !== "17"
      || usage.outputTokens !== "9"
    ) {
      throw new Error(`turn admission was not crash-atomic for ${turnId}: ${JSON.stringify({
        turn,
        startedEvents,
      })}`);
    }
  }

  const admittedTurnEvents = await database.semanticEvent.findMany({
    where: { eventType: "turn.started", aggregateType: "turn" },
    select: { aggregateId: true, payloadJson: true },
  });
  const rawInputEvents = admittedTurnEvents.filter((event) =>
    containsRawUserInput(JSON.parse(event.payloadJson) as unknown)
  );
  if (rawInputEvents.length !== 0) {
    throw new Error(`semantic events retained raw user input: ${JSON.stringify(rawInputEvents)}`);
  }
  const recoveredPendingTurn = await database.turn.findUnique({
    where: { id: PENDING_RECOVERY_TURN_ID },
    include: { episodes: { orderBy: { sequence: "asc" } } },
  });
  const recoveredInputEpisode = recoveredPendingTurn?.episodes.find((episode) =>
    episode.sequence === 1 && episode.kind === "user_message"
  );
  const recoveredInput = typeof recoveredPendingTurn?.initiatingInputArtifact === "string"
    && recoveredInputEpisode?.contentArtifact === recoveredPendingTurn.initiatingInputArtifact;
  const inputlessPending = await database.turn.count({
    where: {
      state: "PENDING",
      OR: [
        { initiatingInputArtifact: null },
        { episodes: { none: { kind: "user_message", sequence: 1 } } },
      ],
    },
  });
  if (
    !recoveredPendingTurn
    || recoveredPendingTurn.state !== "FAILED"
    || recoveredInput
    || inputlessPending !== 0
  ) {
    throw new Error(`input-less admitted turns survived: ${JSON.stringify({
      recoveredPendingTurn,
      inputlessPending,
    })}`);
  }

  const recoveredPostPendingTurns = await database.turn.findMany({
    where: { id: { in: POST_PENDING_RECOVERY_TURNS.map((fixture) => fixture.id) } },
    include: { toolCalls: { include: { sideEffects: true } } },
  });
  for (const fixture of POST_PENDING_RECOVERY_TURNS) {
    const turn = recoveredPostPendingTurns.find((candidate) => candidate.id === fixture.id);
    const recoveryEvents = await database.semanticEvent.findMany({
      where: {
        eventType: fixture.state === "FINALIZING" ? "turn.recovery_failed" : "turn.recovery_interrupted",
        aggregateType: "turn",
        aggregateId: fixture.id,
      },
      select: { payloadJson: true },
    });
    const terminal = turn?.terminalErrorJson
      ? object(JSON.parse(turn.terminalErrorJson) as unknown, `terminal error ${fixture.id}`)
      : null;
    const recoveryPayload = recoveryEvents.length === 1
      ? object(JSON.parse(recoveryEvents[0]!.payloadJson) as unknown, `recovery event ${fixture.id}`)
      : null;
    const toolCall = turn?.toolCalls[0];
    const sideEffect = toolCall?.sideEffects[0];
    const reconciliation = sideEffect?.reconciliationJson
      ? object(JSON.parse(sideEffect.reconciliationJson) as unknown, `side-effect reconciliation ${fixture.id}`)
      : null;
    const effectRecoveryValid =
      turn?.toolCalls.length === 1
      && toolCall?.state === "UNKNOWN"
      && toolCall.resultStatus === "unknown"
      && toolCall.settledAt !== null
      && toolCall.sideEffects.length === 1
      && sideEffect?.state === "MANUAL_REVIEW"
      && reconciliation?.reconciliation_required === true;
    if (fixture.state === "FINALIZING") {
      if (
        turn?.state !== "FAILED"
        || turn.completedAt === null
        || terminal?.reason !== "terminal_recovery_proof_incomplete"
        || terminal.previous_state !== fixture.state
        || terminal.reconciliation_required !== true
        || recoveryPayload?.reason !== "terminal_recovery_proof_incomplete"
        || recoveryPayload.previous_state !== fixture.state
        || recoveryPayload.state !== "FAILED"
        || recoveryPayload.reconciliation_required !== true
        || !effectRecoveryValid
      ) {
        throw new Error(`terminal-adjacent startup recovery diverged for ${fixture.state}: ${JSON.stringify({
          turn,
          recoveryEvents,
        })}`);
      }
      continue;
    }
    if (
      turn?.state !== "INTERRUPTED"
      || turn.completedAt === null
      || terminal?.reason !== "process_restart_after_work_began"
      || terminal.previous_state !== fixture.state
      || terminal.reconciliation_required !== true
      || recoveryPayload?.previous_state !== fixture.state
      || recoveryPayload.reconciliation_required !== true
      || !effectRecoveryValid
    ) {
      throw new Error(`active-turn startup recovery diverged for ${fixture.state}: ${JSON.stringify({
        turn,
        recoveryEvents,
      })}`);
    }
  }

  console.log(JSON.stringify({
    turn_admission_status: "passed",
    asserted_turn_ids: turnIds,
    admitted_turn_count: admittedTurnEvents.length,
    pending_recovery_state: recoveredPendingTurn.state,
    post_pending_recovery_states: recoveredPostPendingTurns.map((turn) => ({
      id: turn.id,
      state: turn.state,
    })),
  }));
} finally {
  await database.$disconnect();
}
