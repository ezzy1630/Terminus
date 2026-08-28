# ChatGPT subscription wire and in‑app OAuth (2026‑08‑28)

Companion to `Provider_Accounts_Design_2026-08-28.md`. That doc settled *what* Terminus borrows; this one settles *exactly what goes on the wire* and *how a user signs in without Codex installed*.

**Evidence tags.** `[live]` means measured from this machine on 2026‑08‑28 against a ChatGPT **Plus** account, single workspace, US (LAX Cloudflare edge). `[src]` read from `openai/codex` at tag **`rust-v0.150.1`**, commit `90854393966b21e9ebfd21b122334eb09a20c93d` (paths below are relative to `codex-rs/` in that tree). `[3p]` observed in a third‑party implementation. `[inferred]` reasoned, not observed.

Local Codex under test: `codex-cli 0.150.1` (`/opt/homebrew/bin/codex`), auth mode `chatgpt`, plan `plus`.

**Product decision being specified:** impersonate the Codex CLI on the wire (`originator: codex_cli_rs` + matching `User-Agent` + `version`), and ship an in‑app "Sign in with ChatGPT". Read §5 before committing to it. Impersonation is a deliberate ToS position, and for some accounts it buys access rather than parity.

**Seven things worth knowing before reading the rest.**

1. On a US Plus account over HTTP, `originator` does nothing. Measured, n=3 each way: 46.1 vs 48.2 tok/s, no status or header difference. The reported benefits of impersonation are WebSocket priority routing and EU/Enterprise model access, neither of which this account can exercise (§1.4, §4.2).
2. The `version` header is a minimum‑version gate, not an identity claim. Send a stale value and you get a hard 400 naming the model. Omit it and nothing is gated. Omit it (§1.4).
3. `client_version` on `/models` is mandatory, and a low value returns `200 {"models":[]}`. A hard‑coded value is a time bomb that fails as "no models" rather than as an error (§1.3).
4. `response.completed` carries `response.output = []` on this backend, every time. Items must come from `response.output_item.done`. A decoder that reads the terminal event produces empty turns and loses reasoning continuity (§1.7).
5. TLS fingerprinting is clean on macOS across three stacks including Terminus's exact rustls config, but `openai/codex#17860` reports a statically‑linked rustls Linux build being Cloudflare‑challenged where native‑tls is not. This needs a Linux reproduction before the connector ships there (§5.2).
6. Nobody in the field implements the API‑key token‑exchange step, and Terminus should not either. It mints a billable platform key as a side effect of signing in (§2.1 step 9).
7. The prior design doc's fallback of refreshing `~/.codex/auth.json` and writing the rotated token back is unsafe. Refresh tokens are single‑use; sharing the file with a running Codex CLI locks one of them out (§3.4).

---

## 1. Exact request templates

### 1.1 Where the headers come from in Codex `[src]`

Codex assembles `/responses` headers from five layers. Understanding the layering matters because most of it is telemetry you can drop.

| Layer | Set in | Headers |
|---|---|---|
| reqwest client default headers | `login/src/auth/default_client.rs:335-351` (`default_headers`) | `originator`, `User-Agent`, optional `x-openai-internal-codex-residency` |
| provider static headers | `model-provider-info/src/lib.rs:397` (`create_openai_provider`) | `version: <CARGO_PKG_VERSION>` |
| auth provider | `model-provider/src/bearer_auth_provider.rs:31-47` | `Authorization: Bearer …`, `ChatGPT-Account-ID`, `X-OpenAI-Fedramp` (fedramp only) |
| endpoint | `codex-api/src/endpoint/responses.rs:87-96, 148-152`; `codex-api/src/requests/headers.rs:5-14` | `x-client-request-id`, `session-id`, `thread-id`, `x-openai-subagent`, `Accept: text/event-stream` |
| per‑turn metadata | `core/src/client.rs:1210-1240` → `build_responses_headers` (`core/src/client.rs:1977-1996`), `core/src/responses_metadata.rs:321-349` | `x-codex-beta-features`, `x-codex-turn-state`, `x-codex-window-id`, `x-codex-turn-metadata`, `x-codex-parent-thread-id`, `x-codex-installation-id`, `x-codex-routing-hint`, `x-oai-attestation`, `x-openai-internal-codex-responses-lite` |

Constants: `core/src/client.rs:144-158`. Base URL `https://chatgpt.com/backend-api/codex` is at `model-provider-info/src/lib.rs:40`, selected for `AuthMode::Chatgpt` at `:292-306`.

Note `x-client-request-id` is **not** a per‑request UUID: Codex sets it to the *thread id*, the same value as `thread-id` (`codex-api/src/endpoint/responses.rs:88-90`; identically on the WS handshake at `core/src/client.rs:1155-1158`). `[src]`

`User-Agent` format `[src] login/src/auth/default_client.rs:164-188`:

```
{originator}/{version} ({os_type} {os_version}; {arch}) {terminal_token}
```

`terminal_token` comes from `codex_terminal_detection::user_agent()` (`terminal-detection/src/lib.rs:178-210, 277-279`): `TERM_PROGRAM/TERM_PROGRAM_VERSION` when present (e.g. `iTerm.app/3.5.14`, `vscode/1.99.0`, `ghostty/1.2.0`, `tmux/3.5a` resolved to the underlying client), else a `TERM` capability string, else a fixed name (`kitty`, `Alacritty`, `gnome-terminal`, `WindowsTerminal`), else `unknown`. When an MCP/app‑server client initializes, ` (name; version)` is appended (`login/src/auth/default_client.rs:39, 176-188`; `app-server/src/request_processors/initialize_processor.rs:94, 138-141`).

Measured on this machine `[live]`, via `codex app-server` `initialize` with `clientInfo.name = "codex_app_server_daemon"` (a name on `NON_ORIGINATING_CLIENT_NAMES`, `app-server/src/request_processors/initialize_processor.rs:16`, so it neither overrides the originator nor appends a UA suffix, so it returns the pure CLI UA):

```
codex_cli_rs/0.150.1 (Mac OS 27.0.0; arm64) unknown
```

(`unknown` because the harness shell has no `TERM_PROGRAM`; a real terminal yields e.g. `… ; arm64) iTerm.app/3.5.14`.)

### 1.2 `POST https://chatgpt.com/backend-api/codex/responses`

Recommended Terminus header set, the Codex‑identical subset minus pure telemetry:

```json
{
  "Authorization": "Bearer <chatgpt access_token JWT>",
  "ChatGPT-Account-ID": "<tokens.account_id / chatgpt_account_id claim, uuid>",
  "originator": "codex_cli_rs",
  "User-Agent": "codex_cli_rs/0.150.1 (Mac OS 27.0.0; arm64) unknown",
  "version": "0.150.1",
  "session-id": "<uuid, stable per Terminus session>",
  "thread-id": "<uuid, stable per Terminus thread>",
  "x-client-request-id": "<same value as thread-id>",
  "Content-Type": "application/json",
  "Accept": "text/event-stream",
  "x-codex-turn-state": "<echo of the value returned earlier in this turn; omit on the first request>"
}
```

Optional, Codex also sends, no observed effect `[live]`: `x-codex-window-id` (uuid), `x-codex-installation-id` (uuid), `x-codex-beta-features: remote_compaction_v2`, `x-codex-turn-metadata` (JSON blob), `x-codex-parent-thread-id`, `x-openai-subagent`. Do **not** send: `x-oai-attestation` (device attestation Terminus cannot produce), `x-codex-routing-hint`, `x-openai-internal-codex-responses-lite`, `x-openai-internal-codex-residency` (unless you are mirroring a residency‑restricted account, see §4.2), `OpenAI-Beta` (HTTP path sends none; see §1.6).

Body (all fields verified accepted; `store`/`stream`/`previous_response_id` verified rejected otherwise) `[live]`, mirroring `core/src/client.rs:871-961` `[src]`:

```json
{
  "model": "gpt-5.4-mini",
  "instructions": "<system prompt; omit the key entirely if empty>",
  "input": [
    { "type": "message", "role": "user",
      "content": [ { "type": "input_text", "text": "hi" } ] }
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": { "effort": "low", "summary": "auto" },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<uuid; Codex uses the session id>",
  "text": { "verbosity": "medium" },
  "service_tier": null,
  "client_metadata": { "session_id": "…", "thread_id": "…" }
}
```

Hard body constraints `[live]`:

| Field | Behaviour |
|---|---|
| `store: true` | `400 {"detail":"Store must be set to false"}` |
| `stream: false` | `400` |
| `previous_response_id` | `400 {"detail":"Unsupported parameter: previous_response_id"}` |
| `max_output_tokens`, `temperature`, `top_p` | `400 "Unsupported parameter"` |
| `input` as a bare string | `400 "Input must be a list"` |
| `model: "gpt-4o"` | `400 "…not supported when using Codex with a ChatGPT account"` |
| missing `Content-Type` | `400 {"detail":"Unsupported content type"}` |

Codex sets `prompt_cache_key` to the session id (`core/src/client.rs:488-500`), or `"{internal_source}:{parent_thread_id}"` for internal sub‑agent sessions. It is a cache‑affinity hint only; changing it does not change acceptance. Keep it **stable for the life of a Terminus session** so prefix caching hits (`input_tokens_details.cached_tokens` in the completed usage is how you verify). `[src]` + `[live]`

### 1.3 `GET https://chatgpt.com/backend-api/codex/models`

```
GET https://chatgpt.com/backend-api/codex/models?client_version=0.150.1
Authorization: Bearer <access_token>
ChatGPT-Account-ID: <account uuid>          # optional
originator: codex_cli_rs                    # optional
User-Agent: codex_cli_rs/0.150.1 (…)        # optional
version: 0.150.1                            # optional
```

`client_version` is **mandatory** and **load‑bearing** `[live]`:

| `client_version` | Result |
|---|---|
| absent | `400`, `{"error":{"message":"[{'type': 'missing', 'loc': ('query', 'client_version'), …}]","type":"invalid_request_error"}}` |
| `0.1.0` | `200` with `{"models":[]}` (13 bytes) and a *different* `ETag` |
| `0.150.1` | `200`, 9 models, ~374 KB, `ETag: W/"9bb70268…"` |
| `999.0.0` | `200`, 9 models, same ETag as `0.150.1` |

That empty‑catalog case is the single most dangerous silent‑degradation mode in this integration: a stale hard‑coded `client_version` yields a *successful* response with zero models. Terminus must treat `models.length === 0` as an error, never as "no models available". `[live]`

Catalog contents (9 models, identical across `originator` values) `[live]`: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-blue-latest`, `gpt-reserve` (hidden), `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `codex-auto-review` (hidden).

`If-None-Match` is **not** honoured. Sending the current ETag still returns `200` with the full body `[live]`. Codex never sends `If-None-Match` either (`codex-api/src/endpoint/models.rs:46-79` passes an empty `HeaderMap`); it uses the ETag purely as a client‑side change token. §1.9 explains the invalidation loop.

`/models` responses are ~374 KB. Terminus's connector caps responses at 1 MiB (`crates/terminus-connector/src/broker.rs:80-81`), which is fine today. The design doc's 8 MiB / 32 MiB bump is still needed for request bodies.

### 1.4 Which headers actually change behaviour

All rows are `POST /responses`, `model: gpt-5.4-mini`, 1‑token prompt, otherwise identical `[live]`:

| Probe | Change from the full impersonation set | Status | Effect |
|---|---|---|---|
| A | (baseline: all Codex headers) | 200 | full `x-codex-*` header family + `x-codex-turn-state` + `x-models-etag` |
| B | `Authorization` **only** (no originator/UA/version/account‑id/session ids/Accept) | 200 | identical rate‑limit + turn‑state + etag headers |
| C | `originator: terminus`, `User-Agent: terminus/0.1.0` | 200 | no observable difference |
| D | no `originator`, no `User-Agent`, no `version` | 200 | no observable difference |
| E | `Content-Encoding: zstd` (zstd‑compressed body) | 200 | accepted |
| S4 | `Content-Encoding: gzip` | 200 | accepted |
| F | `Accept: application/json` instead of `text/event-stream` | 200 | still returns an SSE stream |
| G | `OpenAI-Beta: responses=experimental` | 200 | ignored |
| H | `version: 0.1.0` | **400** | `{"detail":"The 'gpt-5.4-mini' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}` |
| S1 | `version` header **removed**, `model: gpt-5.6-sol` (newest) | 200 | ungated |
| S6 | `version: 999.0.0` | 200 | ungated |
| I | no `ChatGPT-Account-ID` | 200 | works on this single‑workspace Plus account |
| S3 | non‑UUID `session-id`/`thread-id`/`x-client-request-id` | 200 | free‑form strings accepted |
| S5 | no `Content-Type` | **400** | `{"detail":"Unsupported content type"}` |
| J | echo `x-codex-turn-state` from a prior response | 200 | response **omits** `x-codex-turn-state` (see §1.8) |

**Conclusions.**

- **Required:** `Authorization`, `Content-Type: application/json`. That is the entire hard requirement on a single‑workspace Plus account.
- **Conditionally required:** `ChatGPT-Account-ID`. Untested on multi‑workspace, Business, and Enterprise accounts. Send it, since Codex always does when `tokens.account_id` is present.
- **Actively dangerous if wrong:** `version`. It is a *minimum‑version gate*, not an identity claim. Absent → ungated. Present and below the model's `minimal_client_version` → hard 400 naming the model. Terminus must either omit `version` or track a real, current Codex version. **Recommendation: omit `version` on `/responses`.** It buys nothing and is the only header that can break you on an OpenAI-side model rollout. (`client_version` on `/models` is a different thing. It is mandatory, and low values silently empty the catalog.)
- **Pure telemetry (no observed effect):** `originator`, `User-Agent`, `session-id`, `thread-id`, `x-client-request-id`, `x-codex-window-id`, `x-codex-installation-id`, `x-codex-beta-features`, `Accept`, `OpenAI-Beta`.

**But "no observed effect" is scoped to this account.** Two third‑party reports say `originator` gates entitlements that a US Plus account never exercises. See §4.2. The A/B throughput measurement below is the reason to believe the effect is not on the HTTP path.

**Throughput A/B** `[live]`, `gpt-5.4-mini`, ~190 output tokens, n=3 each, alternating:

| originator | avg TTFT | avg total | avg tok/s |
|---|---|---|---|
| `codex_cli_rs` | 1701 ms | 4205 ms | 46.1 |
| `terminus` | 1545 ms | 4163 ms | 48.2 |

No difference beyond noise over HTTP/SSE. Consistent with the OpenCode PR claim that priority routing is applied only on the WebSocket transport (§4).

### 1.5 Request compression: optional, not required

`[src]` Codex compresses `/responses` request bodies with zstd when **all** of: feature `enable_request_compression` (Stage::Stable, `default_enabled: true`, `features/src/lib.rs:1110-1119`), the auth uses the Codex backend, and the provider is OpenAI (`core/src/client.rs:1435-1444`). Encoder is `zstd::stream::encode_all(…, level 3)`, setting `Content-Encoding: zstd` (`http-client/src/request.rs:192-225`). So a stock Codex 0.150.1 on ChatGPT auth **does** send `Content-Encoding: zstd`.

`[live]` The server accepts identity (probes A–D, F–J), `zstd` (E), and `gzip` (S4) alike, with no status/latency/header difference. **Compression is optional.** Terminus should ship uncompressed first. `crates/terminus-connector` builds `reqwest` with `default-features = false, features = ["rustls", "stream"]` (root `Cargo.toml:40`), so no compression codec is linked in. Consider gzip later only as an egress‑budget optimisation, since the connector meters request bytes (`broker.rs`, `reserve_request_exact`).

### 1.6 Transport: SSE, and why not WebSocket

`[src]` Codex prefers `wss://chatgpt.com/backend-api/codex/responses` (`codex-api/src/endpoint/responses_websocket.rs:381-425`, via `Provider::websocket_url_for_path`, `codex-api/src/provider.rs:88-99`) and falls back to HTTP+SSE. WS is on by default for the OpenAI provider (`supports_websockets: true`, `model-provider-info/src/lib.rs:418`; the `responses_websockets` / `responses_websockets_v2` feature flags are `Stage::Removed`, i.e. no longer gated, `features/src/lib.rs:1559-1569`); the only disable path is a session‑local fallback latch (`core/src/client.rs:978-986`).

`OpenAI-Beta` is set **only** on the WS handshake: `OpenAI-Beta: responses_websockets=2026-02-06` (`core/src/client.rs:159, 1168-1171`). The HTTP path sends no `OpenAI-Beta` at all. The stale `OpenAI-Beta: responses=experimental` value that appears in third‑party plugins is not in codex 0.150.1 and is ignored by the server `[live]`.

WS request frame is the same JSON body wrapped as `{"type":"response.create", …}` with `stream`/`background` stripped; server frames are the same `response.*` events. `[src]` + `[3p]`

**Recommendation: HTTP+SSE for v1.** WS adds a connection pool, idle/age lifecycle, per‑session fallback latching, and a second error envelope (`{"type":"error","status_code":429,"error":{…},"headers":{…}}`, §1.9) for one benefit, priority routing, that is unverified for a third‑party originator and would in any case require Terminus's connector to grow a WebSocket dispatch path it does not have (`broker.rs` is HTTP/1.1‑only).

### 1.7 SSE decoding, and one trap

Observed event sequence `[live]`:

```
response.created
response.in_progress
response.output_item.added
  [ response.reasoning_summary_part.added
    response.reasoning_summary_text.delta …
    response.reasoning_summary_text.done
    response.reasoning_summary_part.done ]        # only when a reasoning summary is produced
response.output_item.done                         # ← reasoning item, with encrypted_content
response.content_part.added
response.output_text.delta …
response.output_text.done
response.content_part.done
response.output_item.done                         # ← assistant message item
response.completed
```

Function calls arrive as `response.function_call_arguments.delta` / `.done`.

**Trap `[live]`:** on this backend `response.completed` carries `response.output = []`, an empty array, every time. Collect the conversation items from `response.output_item.done` events. This matches Codex, which builds `items_added` from item events rather than from the terminal event (`core/src/client.rs:map_response_events`). A decoder that reads `response.completed.response.output` will silently produce empty assistant turns and lose all reasoning continuity.

`response.completed.response.usage` is populated:

```json
{ "input_tokens": 18,
  "input_tokens_details": { "cache_write_tokens": 0, "cached_tokens": 0 },
  "output_tokens": 20,
  "output_tokens_details": { "reasoning_tokens": 13 },
  "total_tokens": 38 }
```

Codex additionally reads `codex_rollout_budget_units` from usage (`codex-api/src/sse/responses.rs:122-131`). Response‑header signals consumed before the first event (`codex-api/src/sse/responses.rs:34-100`): `openai-model` (effective model actually served), `x-request-id`, `x-reasoning-included`, `X-Models-Etag`, `x-codex-turn-state`, and the whole `x-codex-*` rate‑limit family.

Decoder gap named in the prior design doc still stands: Terminus's `provider-openai` stream decoder must add `response.reasoning_summary_text.delta/.done`, `response.reasoning_summary_part.added/.done`, and `response.incomplete`.

### 1.8 `x-codex-turn-state`: sticky routing and echo semantics

`[src]` Response header, cached in an `Arc<OnceLock<String>>` created per streaming session (`core/src/client.rs:507-512`), set from the first response that carries it (`codex-api/src/sse/responses.rs:62-69`), and echoed on every subsequent request in that turn (`core/src/client.rs:1977-1996`, `build_responses_headers`). `OnceLock` means it is captured once and never updated within a turn; `new_session()` resets it, so the scope is **one turn** (one user message and its tool‑call loop), not one thread.

`[live]` Server behaviour, measured:

- First request of a session (no `x-codex-turn-state` sent) → response **includes** `x-codex-turn-state` (292 bytes, Fernet‑shaped `gAAAAAB…` base64url token).
- Request that **echoes** a turn‑state → response **omits** `x-codex-turn-state`.
- Request that omits it again → response includes a **fresh** token.

So the contract is: *take the token on the first request of a turn, echo it verbatim on every follow‑up request of that turn, drop it when the turn ends.* The value is opaque; do not parse it, do not persist it across turns, do not share it across sessions.

**Must Terminus echo it?** Not for correctness. Every probe that omitted it returned 200. Echo it anyway: it is the backend's own affinity hint for multi‑request turns (tool loops), it costs one header, and the cost of *not* doing it is invisible degradation (worse prefix‑cache locality on a different backend shard). `[inferred]`

Adjacent: the Cloudflare LB cookie `__cflb` provides a second, transport‑level affinity that Codex preserves via a process‑global CF‑only cookie jar (§5.3). Terminus's connector has no cookie jar and will drop it.

### 1.9 `X-Models-Etag`: catalog invalidation loop

`[src]` `/responses` responses carry `X-Models-Etag`; Codex emits it as a `ResponseEvent::ModelsEtag` (`codex-api/src/sse/responses.rs:41-45, 78-80`) and the models manager compares it against the cached ETag (`models-manager/src/manager.rs:356-372`): equal → extend the cache TTL in place (`refresh_ttl`); different → re‑fetch `/models` online. The cache entry stores `{fetched_at, etag, client_version, models}` and is rejected outright when `client_version` differs from the running version (`models-manager/src/cache.rs:60-72`).

`[live]` Confirmed: the `X-Models-Etag` on `/responses` is byte‑identical to the `ETag` on `/models?client_version=0.150.1` (`W/"9bb70268b8bb53902c2ecfab94e330a2"`), and a `client_version` that yields an empty catalog yields a *different* etag. The ETag is therefore keyed on `(account, client_version)`. Cache it per `(provider_account_id, client_version)`, never globally.

Terminus's connector cannot see response headers today (`ConnectorResponseMessage`, `proto/terminus/kernel/v1/kernel.proto:769-773`). Until the design doc's `response_headers` allowlist lands, catalog refresh must be time‑based rather than ETag‑driven.

### 1.10 Multi‑turn continuity without `previous_response_id`

`previous_response_id` is rejected outright (`400 Unsupported parameter`) and `store` must be `false`, so **all** history is replayed in `input` on every request. `[live]`

Reasoning items come back on `response.output_item.done` as:

```json
{ "id": "rs_<opaque>…", "type": "reasoning",
  "content": [ … ], "summary": [ … ],
  "encrypted_content": "<~1.3 KB opaque blob>" }
```

`encrypted_content` is present whenever `include: ["reasoning.encrypted_content"]` is set. Replay probes, each a second turn built from the first turn's items `[live]`:

| Replay shape | Status |
|---|---|
| full items verbatim (`rs_…` id + `encrypted_content` + `summary`) | 200 |
| reasoning item with `encrypted_content` **stripped** | 200 |
| all `id` fields stripped from all items | 200 |
| reasoning items **dropped entirely** | 200 |

The backend is permissive here. Unlike `api.openai.com/v1/responses` with `store:false`, it did not reject a reasoning item lacking encrypted state (note the item was always immediately followed by its message item, satisfying the ordering rule; an orphaned reasoning item was not tested).

**Rule for Terminus:** echo reasoning items back complete and in order, with `id`, `type`, `summary`, and `encrypted_content`, immediately preceding the assistant message they produced. Permissiveness is not a contract, and the encrypted blob is the only channel by which the model recovers its own prior chain of thought; dropping it silently degrades multi‑step tool loops in a way no status code will tell you about. `[inferred]`

Codex normalises ids before send: any item id that is not a recognised prefixed id is cleared (`core/src/client.rs:963-972`, `prepare_response_items_for_request`). Terminus should do the same. Pass through the `rs_*`, `msg_*`, and `fc_*` ids the server issued, and never invent ids.

### 1.11 Error shapes

**400.** Flat `{"detail": "<message>"}` for Codex‑gateway validation (`Store must be set to false`, `Unsupported parameter: previous_response_id`, `Unsupported content type`, the version gate). Nested `{"error":{"message","type","param","code"}}` for upstream Responses validation (e.g. the `/models` missing‑query‑param error). Handle both. `[live]`

**429, `usage_limit_reached`** `[src] codex-api/src/api_bridge.rs:118-150`:

```json
{ "error": { "type": "usage_limit_reached",
             "plan_type": "plus",
             "resets_at": 1788452680 } }
```

with headers `x-codex-active-limit` (which limit family tripped, e.g. `premium`), `x-codex-rate-limit-reached-type` ∈ {`rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`} (`protocol/src/protocol.rs:2191-2212`), optional `x-codex-promo-message`, and the full window family. `{"error":{"type":"usage_not_included"}}` at 429 is the "your plan doesn't include Codex" case. Any other 429 body → generic retry‑limit error.

**`Retry-After` is not used.** Codex sets `retry_429: false` for the OpenAI provider (`model-provider-info/src/lib.rs:313-319`), so it never auto‑retries a 429. It derives a delay only from an in‑stream `response.failed` error whose `code == "rate_limit_exceeded"`, by regex over the human message: `(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)` (`codex-api/src/sse/responses.rs:654-677, 711-717`). Terminus should schedule off `x-codex-primary-reset-after-seconds` / `x-codex-primary-reset-at` instead, which are authoritative and always present. `[src]`

**In‑stream failures** (`response.failed` → `response.error.code`) `[src] codex-api/src/sse/responses.rs:403-446, 678-700`: `context_length_exceeded`, `insufficient_quota`, `usage_not_included`, `cyber_policy`, `misalignment_policy_violation`, `invalid_prompt`, `bio_policy`, `server_is_overloaded`, `slow_down`, `rate_limit_exceeded`.

**403 Cloudflare.** Codex special‑cases `403` whose body contains both "Cloudflare" and "blocked" into *"Access blocked by Cloudflare. This usually happens when connecting from a restricted region"* (`codex-api/src/api_bridge.rs:190-205`). Note the framing: OpenAI's own client attributes CF 403s to **geography**, not to client fingerprint.

**401.** One refresh, one retry, then report it (`core/src/client.rs:2180-2245`; `model-provider/src/provider.rs:191`).

Rate‑limit header parser (mirror this): `codex-api/src/rate_limits.rs:23-101, 178-230`. Header families are `x-{limit_id}-{primary|secondary}-{used-percent|window-minutes|reset-at}` with `limit_id` defaulting to `codex`; other families are discovered by scanning for any header ending in `-primary-used-percent`. Credits: `x-codex-credits-has-credits|unlimited|balance`.

Live sample from this Plus account `[live]`:

```
x-codex-active-limit: premium
x-codex-plan-type: plus
x-codex-primary-used-percent: 2       x-codex-primary-window-minutes: 300
x-codex-primary-reset-after-seconds: 13282   x-codex-primary-reset-at: 1787968829
x-codex-secondary-used-percent: 53    x-codex-secondary-window-minutes: 10080
x-codex-secondary-reset-after-seconds: 497133 x-codex-secondary-reset-at: 1788452680
x-codex-primary-over-secondary-limit-percent: 0
x-codex-credits-has-credits: False    x-codex-credits-unlimited: False   x-codex-credits-balance: 0
x-models-etag: W/"9bb70268b8bb53902c2ecfab94e330a2"
x-codex-turn-state: <292 bytes, opaque>
```

Note `x-codex-*-reset-after-seconds` is returned live but is **not** parsed by codex 0.150.1 (only `-reset-at` is). It is the more useful of the two for scheduling.

---

## 2. In‑app "Sign in with ChatGPT": authorization code + PKCE

Everything in this section is `[src]` from `login/`, at `rust-v0.150.1`. Nothing here was exercised live (doing so would have rotated the machine's refresh token).

### 2.1 The flow, step by step

**1. Generate PKCE.** `login/src/pkce.rs:12-27`. 64 random bytes → `code_verifier` = base64url‑no‑pad (86 chars). `code_challenge` = base64url‑no‑pad(SHA‑256(**the ASCII of the verifier**, not its decoded bytes)). Method `S256`.

**2. Generate state.** `login/src/server.rs:614-618`. 32 random bytes → base64url‑no‑pad.

**3. Bind the loopback callback server.** `login/src/server.rs:637-702`. `127.0.0.1:1455`. If the port is in use, Codex first tries to evict a stale login server by sending it `GET /cancel`, retries 10× at 200 ms, then falls back to **`127.0.0.1:1457`** ("Keep in sync with the Codex CLI Hydra redirect URI allow‑list", `:61-62`) and retries there. Both ports are registered redirect URIs; anything else will be rejected by the authorization server.

**4. Build `redirect_uri` from the port actually bound.** `login/src/server.rs:176`:

```
http://localhost:{actual_port}/auth/callback
```

Note `localhost`, not `127.0.0.1`, even though the listener binds `127.0.0.1`.

**5. Open the authorize URL.** `login/src/server.rs:576-612`:

```
https://auth.openai.com/oauth/authorize
  ?response_type=code
  &client_id=app_EMoamEEZ73f0CkXaXp7hrann
  &redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
  &scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke
  &code_challenge=<S256 challenge>
  &code_challenge_method=S256
  &id_token_add_organizations=true
  &codex_cli_simplified_flow=true
  &state=<state>
  &originator=codex_cli_rs
  [&allowed_workspace_id=<comma-joined ids>]     # only when workspace-restricted
```

Param order is exactly as listed; every value is percent‑encoded via `urlencoding::encode`. `originator` here is the process originator (`login/src/auth/default_client.rs:112-131`), so an impersonating Terminus sends `codex_cli_rs`. The two non‑standard params are the interesting ones: `id_token_add_organizations=true` makes the issued `id_token` carry organization/workspace claims, and `codex_cli_simplified_flow=true` selects the consent UI that does not force workspace selection. Scopes beyond `openid profile email offline_access` are `api.connectors.read api.connectors.invoke`. OpenCode and almost everyone else request only the first four (§4.1), which is the safer, smaller ask if Terminus does not use connectors.

`client_id` is overridable via `CODEX_APP_SERVER_LOGIN_CLIENT_ID` (`login/src/auth/manager.rs:201, 1704-1712`).

**6. Serve the callback.** `login/src/server.rs:344-520`. Routes:

| Path | Behaviour |
|---|---|
| `/auth/callback` | validate `state` (exact match, or match after stripping the suffix `.onboarding_entrypoint=life_sciences`, see `login/src/callback_params.rs:1-25`); mismatch → `400 "State mismatch"`. `?error=` present → branded HTML error page (`login/src/assets/error.html`) and terminate. Missing `code` → error page `missing_authorization_code`. Otherwise exchange, persist, then `302` to the success URL. |
| `/success` | serves `login/src/assets/success.html` (or `success_legacy.html` when `codex_streamlined_login` is absent), `Content-Type: text/html; charset=utf-8`, `Connection: close`, then the server exits. |
| `/cancel` | body `Login cancelled`, terminate with `ErrorKind::Interrupted`. Used for cross‑process eviction in step 3. |
| anything else | `404 Not Found` |

The success/cancel responses bypass `tiny_http`'s response machinery to force `Connection: close`, because otherwise the keep‑alive socket parks a worker and the *next* login attempt hangs (`login/src/server.rs:524-560`).

**7. Exchange the code.** `login/src/server.rs:809-880`. **Form‑encoded, not JSON:**

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code_verifier=<verifier>
```

No client secret (public client). No `Authorization` header. This request is issued by a *raw* client with **no** Codex default headers (`create_raw_auth_client`, `login/src/auth/default_client.rs:313-321`), so no `originator` and no Codex `User-Agent` reach the token endpoint.

Success → `200` with **all three of** `{"id_token": "<jwt>", "access_token": "<jwt>", "refresh_token": "<opaque>"}`; Codex's deserializer requires all three and fails the login if any is missing.

Failure → non‑2xx; Codex parses the body for `error_description`, then `error.message`, then `error` (string or `error.code`), and surfaces `token endpoint returned status {status}: {detail}` (`login/src/server.rs:1014-1078`). Non‑JSON bodies are surfaced verbatim to the user but never written to structured logs.

**8. Enforce workspace restriction (optional).** `login/src/server.rs:920-950`. If `forced_chatgpt_workspace_id` is configured, decode the `id_token`'s `https://api.openai.com/auth` claim object and require `chatgpt_account_id` ∈ allowed set; otherwise fail with `workspace_restriction`.

**9. Exchange for an OpenAI API key (optional, best‑effort).** `login/src/server.rs:1137-1165`. Failures are swallowed (`.ok()`), so this step never blocks sign‑in:

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&requested_token=openai-api-key
&subject_token=<id_token>
&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token
```

Response `{"access_token": "<sk-… style key>"}`, stored as `OPENAI_API_KEY` in `auth.json`.

**What it is for:** it mints a *platform* (`api.openai.com`, pay‑as‑you‑go, billed to the org) API key from the ChatGPT identity. It is **not** used for ChatGPT‑subscription traffic. That path uses the raw `access_token` bearer against `chatgpt.com/backend-api/codex`. It exists so `codex login` also leaves the user able to run against the metered platform API. **Terminus should skip this step.** Minting a billable API key as a side effect of "sign in with ChatGPT" is a surprise the user did not ask for, and it is the one artifact in this flow that can cost real money.

**10. Persist.** `login/src/server.rs:886-918`. `$CODEX_HOME/auth.json`, `0600`:

```json
{ "auth_mode": "chatgpt",
  "OPENAI_API_KEY": "<from step 9, or null>",
  "tokens": { "id_token": "<raw jwt>", "access_token": "<raw jwt>",
              "refresh_token": "<opaque>", "account_id": "<chatgpt_account_id>" },
  "last_refresh": "<RFC3339 UTC>" }
```

`account_id` is lifted from the `id_token`'s `chatgpt_account_id` claim.

**11. Redirect to success.** `login/src/success_page.rs:40-104`. Default (local) target:

```
http://localhost:{port}/success
  ?id_token=<raw id_token>&needs_setup=<bool>&org_id=…&project_id=…
  &plan_type=<from access_token chatgpt_plan_type>&platform_url=https://platform.openai.com
  [&codex_streamlined_login=true]
```

`needs_setup = !completed_platform_onboarding && is_org_owner`. When a hosted success page is configured *and* `needs_setup` is false, Codex instead `302`s to `<hosted_url>?source=login&app_brand=codex|chatgpt` and exits immediately (`CODEX_OPEN_APP_URL = https://chatgpt.com/codex/open-app`, `login/src/success_page.rs:7`).

Note the local success redirect puts the raw `id_token` in a URL query string on a loopback address. Terminus should **not** copy that: render the success page directly rather than round‑tripping the token through a query param.

### 2.2 Device‑code flow (headless), `codex login --device-auth`

Flag at `cli/src/main.rs:518`; implementation `login/src/device_code_auth.rs`. **Not RFC 8628.** It is a bespoke OpenAI endpoint pair under `https://auth.openai.com/api/accounts`, JSON not form‑encoded:

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, `Content-Type: application/json`, body `{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}` → `{"device_auth_id": "…", "user_code": "…", "interval": "<seconds, as a string>"}` (`:63-97`). `404` means device login is not enabled for the deployment.
2. Show the user `https://auth.openai.com/codex/device` + the `user_code`, valid 15 minutes (`:149-158, 174`).
3. Poll `POST https://auth.openai.com/api/accounts/deviceauth/token`, JSON `{"device_auth_id", "user_code"}` (`:100-147`). `403`/`404` → keep polling at `interval`; anything else non‑2xx → fail; `2xx` → `{"authorization_code", "code_challenge", "code_verifier"}`. Hard timeout 15 minutes.
4. Exchange exactly as §2.1 step 7, but with `redirect_uri = https://auth.openai.com/deviceauth/callback` and the server‑supplied PKCE pair (`:198-213`).
5. Persist as §2.1 step 10, with `api_key: None`. The device path **skips** the API‑key exchange.

Note the server hands the client both halves of the PKCE pair, so PKCE here binds the polling client to the code, not the browser to the client.

### 2.3 Alternative: let `codex app-server` run the login

If Codex is installed, Terminus can avoid reimplementing any of §2.1 by driving the app‑server over stdio (`app-server-protocol/src/protocol/common.rs:1193-1224`):

- `account/login/start` with `{"type":"chatgpt", "appBrand": "codex"|"chatgpt"}` → `{"type":"chatgpt", "loginId": "<uuid>", "authUrl": "<the URL from §2.1 step 5>"}`. Terminus opens `authUrl`, Codex runs the loopback server and persists to `auth.json`.
- `{"type":"chatgptDeviceCode"}` → `{"loginId", "verificationUrl", "userCode"}`.
- `{"type":"chatgptAuthTokens", "accessToken", "chatgptAccountId", "chatgptPlanType"?}`, marked *"UNSTABLE, FOR OPENAI INTERNAL USE ONLY"* (`app-server-protocol/src/protocol/v2/account.rs:86-103`); do not depend on it.
- `account/login/cancel`, `account/logout`, `account/read`, `account/rateLimits/read`, and the deprecated `getAuthStatus`.

This is the right v1: **`app-server` when Codex is present, own OAuth only as the "no Codex installed" fallback.** It avoids owning a loopback HTTP server, PKCE, token rotation, and revocation on day one.

---

## 3. Refresh, rotation, logout

### 3.1 Refresh

`[src] login/src/auth/manager.rs:1583-1632, 1694-1725`

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/json

{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<current refresh token>" }
```

**JSON here, form‑encoded on the authorization‑code exchange.** That asymmetry is real and is a common source of 400s in reimplementations. Unlike the code exchange, this call goes through the *default* Codex client, so it does carry `originator` and the Codex `User-Agent` (`create_default_auth_client`, `login/src/auth/default_client.rs:323-333`).

Response: `{"id_token"?: "…", "access_token"?: "…", "refresh_token"?: "…"}`, and **all three are optional**. Persist each field only if present, and always bump `last_refresh` (`login/src/auth/manager.rs:1556-1578`). **Refresh tokens rotate**; write the new one back or the next refresh fails as reused.

**Triggers** (`should_refresh_proactively`, `login/src/auth/manager.rs:2924-2946`):

1. `access_token.exp <= now + 5 minutes` (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`), **or**
2. no parsable `exp` and `last_refresh < now - 8 days` (`TOKEN_REFRESH_INTERVAL = 8`), **or**
3. a `401` on an API call, which buys one refresh and one retry (`core/src/client.rs:2180-2245`).

Refresh is serialised by a 1‑permit semaphore (`refresh_lock`, `login/src/auth/manager.rs:2045, 2807-2815`). **Terminus must do the same.** Concurrent turns racing a rotating refresh token is the classic way to lock a user out. (The `numman-ali` OpenCode plugin has no such guard; OpenCode core does. §4.)

Observed token lifetimes `[live]` on this account: `access_token` `exp − iat = 864000 s = 10 days`; `id_token` 1 hour.

**Terminal failures** (`classify_refresh_token_failure`, `login/src/auth/manager.rs:1636-1665`). Do not retry these; force a re‑login:

| Server `error`/`error.code` | Reason | User message |
|---|---|---|
| `refresh_token_expired` | Expired | "…your refresh token has expired. Please log out and sign in again." |
| `refresh_token_reused` | Exhausted | "…your refresh token was already used…" |
| `refresh_token_invalidated` | Revoked | "…your refresh token was revoked…" |
| `invalid_grant` + HTTP 400 | Other (terminal) | generic |
| any code + HTTP 401 | terminal | generic |
| anything else | transient, retry | — |

Error code is read from `error.code`, then `error` as a string, then top‑level `code` (`:1667-1690`).

Endpoint overrides for testing: `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_REVOKE_TOKEN_URL_OVERRIDE`.

### 3.2 Logout / revocation

`[src] login/src/auth/revoke.rs:47-153`. Best‑effort; local credentials are deleted even if the call fails.

```http
POST https://auth.openai.com/oauth/revoke
Content-Type: application/json

{ "token": "<refresh_token>",
  "token_type_hint": "refresh_token",
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }
```

JSON body. 10 s timeout. Prefers the refresh token; falls back to the access token, in which case `token_type_hint: "access_token"` and **`client_id` is omitted** (`RevokeTokenKind::client_id`, `:39-45`). Only performed for `auth_mode == chatgpt`.

### 3.3 Terminus's obligations

1. Refresh **inside the kernel**, holding a per‑account mutex; never in the control plane or desktop.
2. Persist the rotated `refresh_token` atomically with `last_refresh`; a crash between rotation and write bricks the account.
3. Trigger at `exp − 5 min`, on `401`, and on `last_refresh` older than 8 days.
4. Map the four terminal reasons to a distinct `ProviderAccount.status = expired` with a reason string, and stop retrying.
5. On disconnect, call `/oauth/revoke` before deleting the secret, and delete the secret before the row.
6. Extend `Redactor` to scrub `access_token`, `refresh_token`, `id_token`, `chatgpt_account_id`, and the `Bearer` header.

### 3.4 The shared‑refresh‑token trap, which revises the prior design doc

`Provider_Accounts_Design_2026-08-28.md` proposes, as a fallback to the `app-server` path, that Terminus "read auth.json in the kernel, refresh kernel‑side, write rotated refresh token back at 0600". **Refresh tokens are single‑use and rotate.** If Codex CLI, the VS Code extension, or Codex Desktop is also running against the same `~/.codex/auth.json`, both clients will eventually refresh, and whichever loses the race gets `refresh_token_reused`, a terminal error that forces a fresh sign‑in in whichever app lost. hermes‑agent hit this and now refuses to seed its credential pool from Codex CLI for exactly this reason (`agent/credential_pool.py:2874-2881`: *"OAuth refresh tokens are single‑use, so sharing them with Codex CLI / VS Code causes `refresh_token_reused` race failures"*); LangChain refuses to read `~/.codex/auth.json` at all on the same grounds. `[3p]`

Three safe postures, in order of preference:

1. **Delegate refresh entirely.** Use `codex app-server` (`getAuthStatus`/`account/read`) for every token fetch and never refresh yourself. Codex owns rotation; Terminus only ever borrows a live access token.
2. **Own the credential outright.** Run Terminus's own OAuth (§2.1), store in Terminus's keyring under `secret://provider-account/<uuid>`, never touch `~/.codex/auth.json`.
3. **Import once, read‑only.** Copy the tokens at connect time, refresh from Terminus's copy, and **never write back**. This still races if Codex refreshes first, but it degrades to "Terminus needs re‑auth" rather than "Codex needs re‑auth", which is the correct direction for blame.

What must not ship is the read‑modify‑write‑back fallback as currently drafted.

---

## 4. Tool‑by‑tool comparison

Sources: `openai/codex` @ `rust-v0.150.1` `[src]`; `numman-ali/opencode-openai-codex-auth` @ `bec2ad69b252ef4ad7dd33b9532ff8b4fdb6d016` `[3p]`; `anomalyco/opencode` (the live `sst/opencode`, which 302s there) @ `df35e842f59bc115bb7c0479a8e11f017d443f2c` `[3p]`.

| | **codex‑cli 0.150.1** | **opencode core** (`packages/opencode/src/plugin/openai/codex.ts`) | **opencode‑openai‑codex‑auth** plugin |
|---|---|---|---|
| Impersonates Codex CLI? | n/a (is Codex) | **No, deliberately** | **Partially** |
| `originator` | `codex_cli_rs` | `opencode` (`codex.ts:556-565`) | `codex_cli_rs` (`lib/constants.ts:26-45`) |
| `User-Agent` | `codex_cli_rs/0.150.1 (Mac OS 27.0.0; arm64) <terminal>` | `opencode/<ver> (<platform> <release>; <arch>)` (`codex.ts:557`) | **none set** → inherits host's `opencode/<ver>` (`session/llm/request.ts:199`) |
| `version` header | `0.150.1` | **not sent** | **not sent** |
| session headers | `session-id`, `thread-id`, `x-client-request-id` (all = thread id for the last two) | `session-id` (hyphen), plus `x-session-affinity`, `X-Session-Id`, `x-parent-session-id` | `session_id` + `conversation_id` (**underscored**, from `prompt_cache_key`) |
| `ChatGPT-Account-ID` | yes | `ChatGPT-Account-Id` | `chatgpt-account-id` |
| `OpenAI-Beta` | WS handshake only: `responses_websockets=2026-02-06` | same, WS only (`ws.ts:11, 79-82`) | `responses=experimental` on **every** HTTP request; a stale value, ignored by the server `[live]` |
| `x-codex-*` request headers | full family | none | none |
| residency | `x-openai-internal-codex-residency` when configured | `x-openai-internal-codex-residency` from the `chatgpt_compute_residency` claim, Codex URLs only (PR #42432) | none |
| Credential source | own OAuth → `~/.codex/auth.json` | own OAuth | own OAuth. Reusing `~/.codex/auth.json` was **refused**: issue #47, *"Nah bro that'll straight get me in trouble with OpenAI legal."* |
| authorize params | `+ api.connectors.read api.connectors.invoke` scopes, `originator=codex_cli_rs` | same client/port/path; scope `openid profile email offline_access`; `originator=opencode` | same as core but `originator=codex_cli_rs` |
| PKCE | 64 rand bytes → b64url verifier, S256 | 43‑char verifier from `A-Za-z0-9-._~`, S256 | `@openauthjs/openauth/pkce`, S256 |
| callback server | `127.0.0.1:1455` → fallback `:1457`; `/auth/callback`, `/success`, `/cancel`; branded HTML; 302 to success | `:1455` (all interfaces); `/auth/callback`, `/cancel`; rendered success/error page; 5‑min timeout | `127.0.0.1:1455` hard‑coded; `/auth/callback` only; static HTML; 100 ms polling ×600; manual‑paste fallback on bind failure |
| token exchange | **form‑encoded** | form‑encoded | form‑encoded |
| refresh body | **JSON** | JSON | JSON |
| API‑key token‑exchange | **yes**, best‑effort | no | no |
| device code | yes (`--device-auth`) | yes, same endpoints | no |
| refresh trigger | `exp − 5 min`, 8‑day floor, or 401 | `expires < now` (no skew) | `expires < now` (no skew) |
| refresh concurrency | 1‑permit semaphore | module‑scoped promise dedupe | **none, races** |
| transport | WS preferred, SSE fallback | SSE; WS pool behind `OPENCODE_EXPERIMENTAL_WEBSOCKETS` | SSE only; collapses SSE→JSON for non‑streaming callers |
| `store` / `stream` / `include` | `false` / `true` / `["reasoning.encrypted_content"]` | same | same, forced |
| `prompt_cache_key` | session id | `sessionID` | pass‑through only |
| multi‑turn | full replay, ids normalised, encrypted reasoning echoed | full replay; reasoning items lacking encrypted state filtered | full replay, **all ids stripped**, orphaned tool outputs rewritten to messages |
| 429 handling | `usage_limit_reached` → typed error, **no auto‑retry** | 5 retries, `retry-after-ms`/`retry-after`; treats 404 as retryable | rewrites the backend's **404** usage‑exhaustion response to `429` |
| system prompt | own | own | **downloads Codex's prompt from `api.github.com/repos/openai/codex/releases/latest`** and caches it 15 min |

### 4.1 The wider field

Twelve further independent implementations, all `[3p]`. Read the `originator` and `version` columns together. They are the only two headers anyone has evidence about.

| | `originator` | `User-Agent` | `version` | session header | `x-codex-*` | `~/.codex` reuse | device flow | `previous_response_id` |
|---|---|---|---|---|---|---|---|---|
| **pi** (`earendil-works/pi`, mirrored as `badlogic/pi-mono` at the same SHA) | `pi` | `pi (<plat> <rel>; <arch>)` | — | `session-id` | — | no | yes (login-method menu) | **WS only** |
| **hermes-agent** (`NousResearch/hermes-agent`) | `hermes-agent` on `chatgpt.com`, `codex_cli_rs` on proxies | `HermesAgent/<v>`; `codex_cli_rs/0.0.0 (Hermes Agent)` on proxies | — | `session_id` | — | opt‑in import, never writes back | **only login method** | never |
| **openclaw** (`openclaw/openclaw`, a fork of pi‑ai) | `openclaw` | `openclaw (<plat> <rel>; <arch>)` | yes | `session_id` | — | reads Keychain `"Codex Auth"` + file, for labelling only | yes (`--device-code`) | **WS only** |
| **oh‑my‑pi** (`can1357/oh-my-pi`), the deepest reimplementation found | `pi` | `omp/<v>` | **`0.144.1`** (pinned real Codex version) | all four forms | **full family** incl. `x-oai-attestation`, residency | no | yes | **WS only** |
| **Zed** (`zed-industries/zed`) | `zed` | — | — | `session-id`, `thread-id` | — | no (OS keychain) | no | never |
| **LiteLLM** (`BerriAI/litellm`), the most aggressive impersonator | **`codex_cli_rs`** | **full spoof**, incl. a reimplementation of Codex's terminal sniffing | — | `session_id` | — | no | **only login method** | passthrough |
| **LangChain** (`langchain-ai/langchain`) | `langchain` | — | — | — | — | **refuses, deliberately** | present but RFC‑8628‑shaped → almost certainly broken | never |
| **gptel** (`karthink/gptel`) | `gptel` | — | — | — | — | no | yes | never |
| **AxonHub** (`looplj/axonhub`) | `axonhub` | passthrough | `0.144.1` | `Session-Id`, `Thread-Id` | 4 of them, fabricated | pasted `auth.json` | not wired | never |
| `1jehuang/jcode` | **`codex_cli_rs`** | — | — | — | — | yes, after explicit consent prompt (also reads OpenCode's and pi's) | — | — |
| `sipeed/picoclaw` | **`codex_cli_rs`** | — | — | — | — | — | — | — |
| `farion1231/cc-switch` | — | `cc-switch-codex-oauth` | — | — | — | — | only | — |

Ecosystem invariants worth knowing `[3p]`:

- **Nobody implements the API‑key token‑exchange** (§2.1 step 9). Every one of these uses the raw OAuth access token as a bearer. That corroborates skipping it.
- Redirect URI is universally `http://localhost:1455/auth/callback`; only Zed and one other know about the `:1457` fallback. `oh-my-pi` carries the comment: *"OpenAI only allows `http://localhost:1455/auth/callback`. Without this, a busy port 1455 falls back to a random port, and the token exchange would fail with 403"*. Binding a random port is a silent‑failure trap, which is why Codex hard‑codes the 1455 and 1457 pair (§2.1 step 3).
- `account_id` is universally the `https://api.openai.com/auth.chatgpt_account_id` claim, always decoded **without signature verification**.
- Everyone except LangChain sends `id_token_add_organizations=true` + `codex_cli_simplified_flow=true`; everyone except `jcode` uses the shorter `openid profile email offline_access` scope. Zed drops the `api.connectors.*` scopes deliberately: the fatter JWT overflows Windows Credential Manager's 2560‑byte `CRED_MAX_CREDENTIAL_BLOB_SIZE`. **Terminus should use the four‑scope form** unless it needs connectors.
- **The ChatGPT OAuth token has no `api.responses.write` scope**, so it is rejected by `api.openai.com/v1/responses` (`openclaw#68033`). `chatgpt.com/backend-api/codex` is the only usable target for this credential.
- Codex CLI also stores credentials in the macOS Keychain: service `"Codex Auth"`, account `cli|<sha256(codex_home)[0:16]>`. This matters if Terminus's discovery path ever reads Codex's store directly (`openclaw` `src/agents/cli-credentials.ts:165-250`).
- `x-codex-turn-metadata` as a *header* is capped at 100 KB by the backend; the unbounded tool inventory rides only in body `client_metadata` (`oh-my-pi`, matching `core/src/responses_metadata.rs:324-337` `[src]`).
- Two endpoints nobody in the prior design doc mentioned: `GET https://chatgpt.com/backend-api/wham/usage` and `/wham/rate-limit-reset-credits[/consume]` (openclaw, oh‑my‑pi).

**Two conflicts with my live measurements**, both worth resolving before shipping:

1. Zed sends `client_version=0.0.0` on `/models` *specifically to defeat `minimal_client_version` gating*. My probe shows `client_version=0.1.0` returns an **empty** catalog `[live]`. Either the semantics changed, or Zed's comment is wrong and Zed is silently receiving zero models. Do not copy that pattern.
2. hermes‑agent documents `/models` returning `{"models":[]}` at HTTP 200 **when the account‑id header is absent**. My probe F omitted `ChatGPT-Account-ID` and still got 9 models `[live]`. Likely account‑shape dependent (single‑workspace Plus vs workspace accounts), and another reason to always send the header.

### 4.2 What the third‑party evidence changes

Three findings from the OpenCode tree are load‑bearing for Terminus's decision, and none of them are visible from a US Plus account:

1. **`originator` gates routing entitlement.** `anomalyco/opencode` PR **#39882** A/B‑tested only the `originator` header on otherwise identical requests and reported `gpt-5.6-sol-fast` at **55.3 tok/s** with `originator: opencode` vs **82.5 tok/s** with `codex_cli_rs`, concluding "the Codex backend grants Fast routing per client `originator`, and `opencode` is not entitled", and, critically, that "the backend applies priority routing only on the WebSocket transport; over plain HTTP the same headers and body still get standard speed." Closed unmerged; maintainers declined to identify as Codex CLI. This matches my own HTTP A/B (§1.4), which found no difference. `[3p]`
2. **`originator` + `version` gate model *access* for some accounts.** `anomalyco/opencode` issue **#43615**: an EU‑residency ChatGPT Enterprise account gets *"The requested model snapshot is not available for your project's geography"* for all GPT models through OpenCode, while Codex CLI on the same account succeeds. The reporter's diagnostic was that setting `originator: codex_cli_rs` **and** a real `version` header made the identical requests succeed. Still open; maintainer forwarded it to OpenAI. `[3p]`
3. **Mismatched identity may trigger extra verification.** Plugin issue **#25**: a user hit OpenAI's "Verify Organisation" gate for streaming under the plugin (which sends `originator: codex_cli_rs` with an `opencode/*` User‑Agent and no `version`) while Codex CLI and the IDE extension on the same Plus account did not. Unresolved, but consistent with the plugin's internally inconsistent fingerprint. `[3p]`

4. **Region‑pinned workspaces need the residency header.** `oh-my-pi` reads `chatgpt_data_residency` (falling back to `chatgpt_compute_residency`) from the access‑token claims and sends `x-openai-internal-codex-residency`; without it, enterprise workspaces answer `401 "Workspace is not authorized in this region."` This machine's access token *does* carry a `chatgpt_compute_residency` claim `[live]`, so the plumbing is available. `[3p]` + `[live]`

**Design consequence:** if Terminus impersonates, it must impersonate consistently. `originator`, `User-Agent`, and, where sent, `version` must all describe the same client. The half‑impersonation in the numman‑ali plugin is the worst configuration available: it takes the ToS risk of claiming to be Codex without the coherence that would make the claim hold up. Note also that the field is split roughly down the middle: Zed, LangChain, gptel, pi, openclaw, hermes‑agent (on the official host) and OpenCode core all identify honestly; LiteLLM, jcode, picoclaw and the numman‑ali plugin claim `codex_cli_rs`. The honest majority includes every implementation shipped by a company with a legal department.

---

## 5. Risks

### 5.1 Impersonation is a ToS decision

`originator` had no measurable effect on this account (§1.4), so impersonation buys nothing here and costs an explicit misrepresentation of client identity to OpenAI. The counter‑evidence (§4.2) is that for EU/Enterprise/residency‑restricted accounts and for WS priority routing, it may buy *access* and *speed*.

That splits the decision cleanly:

- If Terminus ships **HTTP+SSE only** (the §1.6 recommendation), `originator: terminus` is functionally equivalent today and honest. `[live]`
- If Terminus later adopts WebSocket, or supports Enterprise/EU accounts, honest identification may mean degraded or denied service. `[3p]`

OpenAI reads `originator` server‑side for entitlement decisions, so impersonation here is asserting an entitlement Terminus does not hold rather than passively mimicking a client. OpenCode's maintainers declined to merge exactly this change twice (PRs #36314, #39882). Anthropic has banned the equivalent practice outright; OpenAI has published no policy either way, which is not the same as permission.

**Recommendation:** make it a config toggle, default **off** (`originator: terminus`), with a clear settings string explaining what flipping it does and does not do. Never make it the silent default. If it is turned on, send the complete consistent set: `originator: codex_cli_rs`, a matching `User-Agent`, and either a current `version` or none at all.

### 5.2 TLS fingerprinting: clean on macOS, a real hazard on Linux

**Short version:** Terminus's exact stack works today on macOS `[live]`, but there is a filed OpenAI issue showing that a statically‑linked rustls build *is* Cloudflare‑challenged where a native‑TLS build on the same machine and IP is not. Terminus's kernel is rustls‑only. This is the one finding in this document that should change the plan.

#### What I measured: three stacks, all clean, all on macOS

The concern was that Cloudflare might JA3/JA4‑fingerprint and reject a non‑Codex client. From this host it does not `[live]`:

| Client | TLS stack | ALPN | `/models` | `/responses` |
|---|---|---|---|---|
| Node 24 `fetch` (undici) | OpenSSL | h2 | 200 | 200 |
| `curl 8.7.1` | Secure Transport / LibreSSL | h2 | 200 | 200 |
| **`reqwest 0.13.4`, `default-features = false, features = ["rustls","stream"]`**, Terminus's exact config (root `Cargo.toml:40`) | **rustls** | **HTTP/1.1** | **200** | **200** (`x-codex-plan-type: plus`, `x-codex-turn-state` 292 b, `x-models-etag` present) |

Three distinct ClientHellos, no `cf-mitigated` header on any response, no challenge. HTTP/1.1 is fine. Terminus's reqwest has no `http2` feature and negotiated h1 where Codex negotiates h2.

Codex itself is **not** doing anything exotic: default `TlsBackend::TransportDefault` = native‑tls (Secure Transport on macOS), with rustls used only as a narrow, per‑origin fallback triggered by a recognised protocol‑version alert (`http-client/src/client_builder.rs:41-46, 276-298`; `http-client/src/tls_backend_fallback.rs:104-152`). Its reqwest is `0.12` with `["cookies"]` + `["json","rustls-tls-native-roots","stream"]`, with no fingerprint shaping, no HTTP/2 tuning, and no ALPN pinning. `[src]`

#### Why "clean on macOS" is not the whole answer

`[3p]` **`openai/codex#17860`.** Same account, same exit IP, same machine: the macOS build links native‑tls/SecureTransport (Safari‑like ClientHello, passes) while the `x86_64-unknown-linux-musl` build statically links `rustls 0.23.36` and gets Cloudflare‑challenged. Reported to affect `/codex/responses`, `/plugins/featured`, **and OAuth token refresh**. That is precisely Terminus's configuration, rustls with no native‑tls anywhere, so my macOS green light does not generalise to a Linux kernel build.

`[3p]` **`openai/codex#18456`.** OpenAI's own WAF at the HKG POP returns 403 for a bare `reqwest/*` User‑Agent; several internal Codex Desktop clients forgot to override UA and 403'd at the edge. Terminus's connector defaults to `terminus-connector/<ver>` (`crates/terminus-connector/src/broker.rs`, `CONNECTOR_USER_AGENT`), not bare `reqwest/*`, so it is not in the worst bucket. Still, this establishes that User‑Agent is load‑bearing at the WAF, independent of any entitlement question.

`[3p]` **`openai/codex#35490`.** The WebSocket leg (`wss://chatgpt.com/backend-api/codex/<call_id>`) is challenged at the SIN POP, explicitly noted as *UA‑independent* unlike #18456. Another reason WS is not a v1 target (§1.6).

`[3p]` **`icoretech/codex-pooler#116`.** Background refreshes against `auth.openai.com/oauth/token` and `/api/accounts/deviceauth/*` returning `Cf-Mitigated: challenge` for an Elixir `req/x.x.x` UA, fixed only by injecting a full browser header suite (`sec-ch-ua`, `sec-ch-ua-platform`, `sec-fetch-*`, `accept-language`, `referer`, Chrome UA). Note the host: a headless client can get permanently signed out at the **auth** host even while the API host is fine.

Egress reputation dominates for everyone: shared HPC login nodes, VPN exits, datacenter/VPS IPs, Docker/headless environments, and the HKG/SIN POPs recur across `openai/codex#27446`, `#39324`, and others, several with a bare `curl -I https://chatgpt.com` reproducing `403 / cf-mitigated: challenge`. Codex's own error mapper agrees with that framing, turning a `403` whose body mentions Cloudflare and "blocked" into *"connecting from a restricted region"* (`codex-api/src/api_bridge.rs:190-205`) `[src]`.

#### What Terminus must do

1. **Detect the challenge, don't misreport it.** Every implementation surveyed that lacks this misdiagnoses CF challenges as something else: hermes‑agent surfaces them as `APIConnectionError`/timeouts, openclaw variously as "DNS lookup failed", "API rate limit reached", and "re‑authenticate". Terminus should classify `status ∈ {403, 503}` **and** (`cf-mitigated: challenge` present **or** `content-type: text/html`) as a distinct `UpstreamChallenged` error, never as an auth failure, and never as something that triggers a token refresh (a refresh storm against a challenging edge is how accounts get locked out).
2. **Log `cf-ray`, `cf-mitigated`, `x-request-id` on every non‑2xx.** This requires the `response_headers` connector capability from the design doc. Without it a future block is unattributable.
3. **Do not put a rustls Linux kernel on the critical path unverified.** Before shipping the Linux build, re‑run the `/tmp/rprobe` probe from a Linux host, and specifically from a datacenter IP. If it is challenged, the options are (a) build the Linux kernel with native‑tls for this one connector, mirroring Codex's `TlsBackend` split, or (b) accept macOS‑only for the ChatGPT connector in v1. Note that (a) is a real change: Terminus's workspace pins `reqwest` `default-features = false, features = ["rustls","stream"]` globally.
4. **Do not add TLS impersonation.** None of the twelve implementations surveyed uses `curl_cffi`/`utls`/`tls-client`, and hermes‑agent's shipped answer to its own 403 issue was Happy Eyeballs plus a `force_ipv4` escape hatch. Forging a ClientHello to defeat a bot‑management control is a materially different act from setting a header, and it is not one this document recommends.

**Residual risk:** none of this is a contract. Cloudflare posture changes per account, per region, per POP, without notice, and the failure is a 403 with an HTML body rather than a typed error.

### 5.3 Cookie affinity: Codex keeps it, Terminus will drop it

Codex maintains a **process‑global, Cloudflare‑only** cookie jar for `chatgpt.com`, `chat.openai.com`, `chatgpt-staging.com` and their subdomains (`http-client/src/chatgpt_cloudflare_cookies.rs:99-172`, `chatgpt_hosts.rs:3-11`). The allowlist is exactly `__cf_bm`, `__cflb`, `__cfruid`, `__cfseq`, `__cfwaitingroom`, `_cfuvid`, `cf_clearance`, `cf_ob_info`, `cf_use_ob`, and any `cf_chl_*`; every other cookie, including `__Secure-next-auth.session-token`, `chatgpt_session`, and `oai-auth-token`, is dropped, with a loud comment that the jar must never hold user‑identifying cookies.

Live, `/models` sets three cookies: `__oailb` (OpenAI LB, 1 h, not on Codex's allowlist, so Codex drops it), `__cf_bm` (30 min), `__cflb` (1 h). `[live]`

Terminus's connector has no cookie jar at all (`crates/terminus-connector/src/broker.rs`). Consequences: (a) no `__cflb` LB affinity across requests in a turn, mitigated by echoing `x-codex-turn-state` (§1.8); (b) if Cloudflare ever issues a managed challenge, Terminus cannot carry `cf_clearance` and will re‑challenge on every request. If (b) ever materialises, the fix is a kernel‑owned, host‑scoped, name‑allowlisted cookie jar copying Codex's design exactly. Not a general cookie store, which would be a place credentials could leak from.

### 5.4 Silent degradation modes, the real hazard

Every one of these returns a `200` or a plausible success:

| Mode | Symptom | Guard |
|---|---|---|
| stale `client_version` on `/models` | `200 {"models":[]}` | treat empty catalog as an error; assert `models.length > 0` |
| reading `response.completed.response.output` | empty assistant turns, lost reasoning | assemble from `response.output_item.done` |
| dropping `encrypted_content` on replay | accepted (200), degraded multi‑step reasoning | echo reasoning items complete and in order |
| not echoing `x-codex-turn-state` | accepted, worse shard/cache locality | echo within a turn |
| unstable `prompt_cache_key` | `cached_tokens: 0`, higher quota burn | stable per session; assert `cached_tokens > 0` after turn 2 |
| ETag cached globally instead of per `(account, client_version)` | wrong catalog served | key the cache correctly |
| refresh race rotating the token twice | `refresh_token_reused` → forced re‑login | per‑account refresh mutex |
| minting `OPENAI_API_KEY` via the token‑exchange step | user acquires a billable platform key they never asked for | skip §2.1 step 9 |
| sharing the refresh token with an installed Codex CLI | both clients rotate it; `refresh_token_reused` on whichever loses | never write back to `~/.codex/auth.json`; own the credential or use `app-server`, not both |
| CF challenge classified as an auth failure | refresh storm → account lockout at the auth host | classify `403`+`cf-mitigated`/`text/html` as `UpstreamChallenged`, never refresh on it |
| callback server binding a random port after 1455/1457 are both busy | token exchange 403s with an unregistered `redirect_uri` | fail loudly; never fall back to an arbitrary port |

Terminus should add a `chatgpt-codex` connector smoke eval asserting: catalog non‑empty; `response.output_item.done` yields ≥1 message item; a reasoning item carries `encrypted_content`; turn 2 reports `cached_tokens > 0`; and `x-codex-primary-used-percent` parses.

### 5.5 Subscription accounting

`x-codex-primary-*` is a 300‑minute (5 h) window, `x-codex-secondary-*` a 10080‑minute (7 d) window `[live]`. These are the only usage signal, since there is no per‑request price. `BudgetGuard` (micros) is meaningless for this account type; the quota meter must guard on window percentage with a configurable ceiling, and `x-codex-*-reset-after-seconds` (present live, unparsed by Codex) is the right scheduling input.

### 5.6 What the credential can do if it leaks

The `access_token` is a 10‑day bearer for the user's entire ChatGPT identity, not a scoped API key. It must never leave the kernel, never appear in a receipt, never be logged, and never be handed to a task. The connector's existing `AuthStyle::Bearer` + one‑shot grant model is the right shape; what is missing is the keyring namespace (`secret://provider-account/<uuid>`) and the header allowlist widening (`crates/terminus-connector/src/broker.rs:503` currently admits only `accept, content-type, anthropic-version`, which blocks every header in §1.2).

---

## 6. Open questions

1. **Impersonation default.** Ship `originator: terminus` by default with an opt‑in "identify as Codex CLI" toggle, or ship `codex_cli_rs` by default? (My recommendation: honest default, documented toggle. The measured benefit on the HTTP path is zero.)
2. **`version` header on `/responses`.** Omit entirely (safe, ungated) or track a real Codex version (needed if `#43615`‑style residency gating turns out to key on it)? Omitting means Terminus is never broken by an OpenAI min‑version bump; sending means Terminus must ship a version‑tracking job.
3. **`client_version` on `/models`.** Hard‑code, read from an installed `codex --version`, or fetch a "latest known good" from a Terminus‑controlled endpoint? A hard‑coded value is a time bomb (empty catalog), the others add a dependency.
4. **Multi‑workspace accounts.** `ChatGPT-Account-ID` was omittable on this single‑workspace Plus account. Untested on Business/Enterprise/multi‑workspace, where `allowed_workspace_id` and workspace selection matter. Need a second test account before shipping.
5. **In‑app OAuth vs `app-server`.** Ship §2.3 (`account/login/start`) first and treat §2.1 as a later fallback, or build the OAuth flow immediately so the "no Codex installed" path exists from day one?
6. **API‑key exchange.** Confirmed skippable. Should Terminus still offer it as an explicit, separately consented "also give me a platform API key" action?
7. **WebSocket.** Worth the connector work later for the claimed priority routing (§4.2 #1), or permanently out of scope given it is the transport on which impersonation would actually matter *and* the one with a filed UA‑independent Cloudflare challenge (`openai/codex#35490`)?
8. **`x-codex-*-reset-after-seconds`.** Present live, unparsed by Codex. Is it stable enough to schedule against, or should Terminus compute from `-reset-at` like Codex does?
9. **Linux + rustls.** *Blocking for the Linux build.* `openai/codex#17860` reports a statically‑linked rustls build being Cloudflare‑challenged where native‑tls on the same machine is not. Terminus is rustls‑only. Needs a Linux + datacenter‑IP reproduction before this connector ships on Linux; if it reproduces, does Terminus special‑case native‑tls for this connector (mirroring Codex's `TlsBackend` split) or ship macOS‑only in v1? (§5.2)
10. **Credential ownership.** Delegate refresh to `app-server`, own the OAuth outright, or import read‑only? The prior design doc's write‑back fallback is unsafe as drafted (§3.4).
11. **Residency header.** Should Terminus send `x-openai-internal-codex-residency` derived from the `chatgpt_compute_residency` claim (present on this machine's token `[live]`)? It is required for region‑pinned enterprise workspaces `[3p]` but is an OpenAI‑internal header, so sending it is a second impersonation decision, separate from `originator`.

---

## Appendix A: Terminus repo deltas implied by this spec

| Blocker | Location | Change |
|---|---|---|
| Header allowlist | `crates/terminus-connector/src/broker.rs:503` (`validate_headers`, `ALLOWED = ["accept","content-type","anthropic-version"]`) | per‑descriptor `allowed_request_headers`; kernel‑pinned `static_headers` for `originator`/`User-Agent` so a task can never set them |
| Response headers invisible | `proto/terminus/kernel/v1/kernel.proto:769-773` (`ConnectorResponseMessage`) | per‑connector response‑header allowlist: `x-codex-*`, `x-models-etag`, `openai-model`, `x-request-id`, `cf-ray`, `cf-mitigated`, `retry-after` |
| 1 MiB bounds | `crates/terminus-connector/src/broker.rs:80-81` | 8 MiB request / 32 MiB response for this connector; `/models` alone is ~374 KB and turn bodies with replayed history will exceed 1 MiB |
| Keyring namespace | `crates/terminus-secrets/src/keyring_provider.rs:85-92`, registered in `crates/terminus-kernel/src/services.rs:177-180` | admit `secret://provider-account/<uuid>` |
| Egress allowlist | `crates/terminus-kernel/src/services.rs:105-118` (`opencode.ai:443` only) | add `chatgpt.com:443` and `auth.openai.com:443`, derived from connected accounts |
| No cookie jar | `crates/terminus-connector/src/broker.rs` (`dispatch_https`) | only if a CF challenge ever appears: host‑scoped, name‑allowlisted CF‑only jar mirroring `http-client/src/chatgpt_cloudflare_cookies.rs` |
| Redaction | `terminus-secrets::Redactor` | scrub `access_token`, `refresh_token`, `id_token`, `chatgpt_account_id`, `Bearer …` |
| SSE decoder | `packages/provider-openai/src/stream.ts` | add `response.reasoning_summary_*`, `response.incomplete`; assemble items from `response.output_item.done`, **not** `response.completed.response.output` |
| Request renderer | `packages/provider-openai/src/index.ts:402-431` (`renderResponsesRequest`) | strip `max_output_tokens`, `temperature`, `top_p`, `previous_response_id`; force `store:false`, `stream:true`, `include:["reasoning.encrypted_content"]`, stable `prompt_cache_key` |

## Appendix B: reproduction

Probe scripts used for every `[live]` claim are under `/tmp/probe/` (`lib.mjs` obtains a token from `codex app-server` over stdio and kills the process; `models.mjs`, `responses.mjs`, `round2.mjs`, `round3.mjs`, `round4.mjs`, `perf.mjs`). The rustls client is `/tmp/rprobe/` (`reqwest 0.13.4`, `default-features = false, features = ["rustls","stream"]`, Terminus's exact dependency line). Codex source is `/tmp/codexsrc` at `rust-v0.150.1`. No token, account id, or turn‑state value was written to any file or printed.
