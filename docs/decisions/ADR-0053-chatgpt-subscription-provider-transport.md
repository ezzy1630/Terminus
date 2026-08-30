# ADR-0053: ChatGPT subscription provider transport

- **Status:** ADOPTED
- **Date:** 2026-08-30
- **Decision owner:** runtime architecture owner
- **Supersedes:** ADR-0044 decision 7 and its Codex-specific consequences
- **Related:** ADR-0009, ADR-0016, ADR-0037, ADR-0039, ADR-0044, SPEC §36.12, §36.13, §38

## Context

Terminus is the agent harness. Users need to select models entitled by their
existing ChatGPT subscription without handing orchestration to another agent
runtime. A Codex App Server lane can run Codex as an external worker, but it
owns that worker's thread and tool loop and therefore cannot satisfy the native
Terminus model-picker contract.

The installed Codex CLI already owns the user's OpenAI login and persists an
account-scoped access token. The ChatGPT Codex Responses endpoint and model
catalogue used by current clients are compatibility surfaces rather than the
public OpenAI API. They may change independently of Terminus and therefore need
a narrow, fail-closed adapter rather than leaking into canonical provider or
domain contracts.

## Decision

1. Admit `codex-chatgpt` as an account source and `chatgpt_codex` as a provider
   rendering profile. Terminus owns context compilation, orchestration, tools,
   effects, persistence, evidence, repair, and completion decisions for every
   request through this profile.
2. Codex remains the login owner. Terminus does not implement OpenAI OAuth,
   collect a password, impersonate the Codex client, or claim API-key billing.
   It discovers the local Codex auth store as metadata only. The access token
   is copied into an OS-keyring capability only after the user approves the
   exact source fingerprint, account revision, catalogue digest, and fixed
   destination.
3. The kernel is the only component that reads the source credential or adds
   the bearer header. TypeScript receives only an opaque capability URI and
   non-secret account metadata. Tokens must not enter prompts, logs, events,
   artifacts, fixtures, database rows, or UI responses.
4. Dispatch is restricted to HTTPS on `chatgpt.com` under the registered
   `chatgpt-codex` connector. The connector fixes the request path prefix to
   `/backend-api/codex`, bounds request and response bytes, uses a narrow
   request-header allowlist, consumes one-use egress grants, and records only
   allowlisted non-secret response headers.
5. Model identity and supported reasoning levels come from the connected
   account's Codex catalogue. A model that is hidden, malformed, absent from
   that catalogue, or not bound to the approved account is not routable.
   Subscription models carry no invented per-token price.
6. The renderer uses a dedicated Responses compatibility codec with
   `store:false` and `stream:true`. It removes unsupported public-API fields,
   preserves encrypted reasoning replay, uses the selected model's advertised
   reasoning levels, and withdraws strict tool-schema claims the endpoint does
   not accept. Provider-specific fields do not escape
   `@terminus/provider-openai`.
7. Request identity is honest. Headers identify Terminus and carry only the
   Terminus session, thread, and turn continuity values. The adapter does not
   send a false Codex package version or copy another harness's installation
   identifier.
8. Token rotation is fail closed. When the source credential changes or
   expires, the binding becomes unusable until discovery observes the new
   fingerprint and the user approves that exact replacement. A previously
   approved credential is never silently replaced.
9. The Codex App Server integration remains an optional external-worker lane.
   It is not a native provider attempt and its models do not duplicate the
   account-scoped models in the normal picker.
10. OpenCode Zen remains an independent provider gateway. This decision does
    not change anonymous free-model admission, workspace-access consent, or
    the standalone-runtime boundary in ADR-0044.

## Consequences

- A user can connect an existing local ChatGPT/Codex login, select an entitled
  model in the ordinary Terminus picker, and run the Terminus harness against
  subscription quota.
- Login and billing remain visibly distinct from OpenAI API-key integration.
- A Codex token refresh requires an explicit reconnect because the security
  boundary binds consent to exact credential bytes.
- Compatibility drift is contained to one provider renderer, one account
  catalogue decoder, and one kernel connector. Drift fails closed rather than
  falling back to a different provider or external harness.
- Changes to this path are auth, network, and public-protocol changes. They
  require the targeted security/eval suites and two approvals before merge.

## Verification

- Kernel discovery tests prove bounded owner-only reads, non-secret metadata,
  full fingerprint binding, exact-match import, and OS-keyring storage.
- Connector tests prove fixed host/path, request and response header
  allowlists, bearer injection, bounded streaming, and denied destination
  substitution.
- Catalogue tests prove account-scoped model discovery, hidden-model rejection,
  reasoning-level preservation, and subscription billing projection.
- Renderer golden tests prove the exact request body, `store:false`,
  `stream:true`, tool conversion, reasoning replay, and honest headers.
- Control-plane tests prove the connected account enters the normal model
  inventory and is selected through the same Terminus turn loop as other
  providers.
- A live desktop smoke must connect the detected ChatGPT account, read the
  account catalogue, send a reply-only turn, run one kernel-backed tool task,
  and observe the final transcript and lifecycle. A separate smoke preserves
  anonymous Zen free-model inference.
- `just standalone-check` proves no OpenCode or Codex runtime dependency entered
  first-party build/runtime code.
