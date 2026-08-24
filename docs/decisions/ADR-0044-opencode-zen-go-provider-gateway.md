# ADR-0044: OpenCode Zen and Go as provider gateways

- **Status:** ADOPTED
- **Date:** 2026-08-24
- **Decision owner:** runtime architecture owner
- **Supersedes:** none
- **Related:** ADR-0009, ADR-0016, ADR-0037, ADR-0039, SPEC §36.12, §36.13, §38

## Context

OpenCode Zen and OpenCode Go publish credentialed model API endpoints for use
by other agents. They expose several provider wire protocols under one account:
OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Google
Generative Language. Terminus needs access to the gateway without restoring the
retired OpenCode runtime, session model, tool loop, or build dependency.

The gateway catalog changes over time. A model appearing in `/v1/models` proves
availability, but does not by itself prove a wire protocol or measured agent
capability. Models.dev provides provider-owned protocol and capability metadata.

## Decision

1. Integrate Zen and Go as remote model providers behind Terminus-owned provider
   contracts. Terminus continues to own context compilation, orchestration,
   tools, effects, persistence, evidence, and completion decisions.
2. First-party runtime code MUST NOT import or execute OpenCode. The provider
   package is named `@terminus/provider-zen` so its dependency edge describes a
   gateway implementation, not an agent-runtime dependency.
3. Discovery intersects the gateway's `/v1/models` response with a decoded
   Models.dev provider snapshot. Unknown models and unknown protocols fail
   closed. The system does not guess a dialect from a model name.
4. Each admitted model binds one exact protocol and endpoint path. The first
   implementation supports `chat_completions`, `responses`, and `messages`.
   Google-native entries fail closed until a Google gateway codec passes the
   same conformance suite. The binding is part of the provider rendering
   profile and evidence.
5. The API key is represented outside the provider package by an opaque secret
   capability URI. The provider package never reads environment variables,
   files, OpenCode's credential store, or raw credential values.
6. Credential injection and HTTPS dispatch remain kernel connector operations.
   A TypeScript `fetch` fallback is forbidden. The current Models.dev catalogue
   path therefore fails closed until the kernel exposes a bounded public-fetch
   connector; `NetworkService.Decide` alone is authorization, not transport.
   The connector validates platform TLS roots, pins the request to the DNS
   addresses approved by egress policy, bounds request and response bytes,
   consumes a one-use grant before dispatch, and redacts an echoed credential.
7. Zen and Go credentials use the OS credential store under the exact opaque
   URIs `secret://opencode/zen` and `secret://opencode/go`. Provider selection
   state stores only the URI and a configured marker.
8. Gateway profiles allow public context by default. Sending repository content
   requires both `workspace_access: true` and a persisted admission record for
   the current provider terms. The record contains the deployment-specific
   terms identity (`opencode-zen-privacy-v1` or `opencode-go-privacy-v1`), and
   routing fails closed when it is absent or stale.
9. Free-model status and provider privacy claims are routing inputs, not trust
   guarantees. Models whose terms allow training or non-zero retention are
   restricted by confidentiality policy until separately admitted.

## Consequences

- Users may use Zen free models or a Go subscription with the Terminus agent
  loop.
- OpenCode installation is unnecessary. An installed OpenCode credential may
  be imported only through an explicit secret-store operation, never read
  ambiently by the provider.
- Catalog drift becomes visible. A newly listed model is unavailable until its
  protocol metadata decodes and its capability profile passes conformance.
- Provider responses cross the kernel RPC as one bounded, scrubbed body. The
  current agent runtime already settles a complete provider response before
  projection, so token-by-token UI delivery is separate work and not required
  for model execution.

## Verification

- Golden tests for catalog intersection and fail-closed protocol decoding.
- Golden tests for endpoint and header selection for every supported protocol.
- Fragmented SSE tests for Chat Completions, Responses, and Messages streams.
- Provider profile registry tests for unique immutable identities.
- `just standalone-check` proves no OpenCode runtime dependency returned.
- An OS credential-store round trip uses an isolated test service and deletes
  the generated entry afterward.
- A live TLS canary sends an empty request with a generated invalid credential.
  It proves certificate validation and HTTP settlement without invoking a model.
- A real-account canary remains operator-gated because it requires an account
  credential and may consume quota.
