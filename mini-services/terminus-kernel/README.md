# terminus-kernel mini-service

The **Rust privileged effect boundary** for Terminus (SPEC §5.2, §13, §27, §31). This
is a standalone Rust binary crate that exposes the kernel services over HTTP on
port 3040. The TypeScript control plane and Next.js UI call it via the Caddy
gateway using `?XTransformPort=3040`.

## Build & run

```bash
cd mini-services/terminus-kernel
cargo build --release
TERMINUS_DATA=/home/z/my-project/.terminus-data \
TERMINUS_KERNEL_TOKEN=terminus-kernel-dev-token \
./target/release/terminus-kernel-mini
```

Or use the start script from the project root:

```bash
bash scripts/start-mini-services.sh
```

## Endpoints (35 total, all wired to real kernel calls)

| Service group | Endpoints |
|---|---|
| KernelInfoService | `POST /v1/info`, `POST /v1/health` |
| WorkspaceService | `POST /v1/workspaces/{register,get}` |
| FileService | `POST /v1/files/{read,list}` |
| PatchService | `POST /v1/patch/{preview,apply,reconcile}` |
| ProcessService | `POST /v1/process/start`, `POST /v1/process/:id/cancel`, `GET /v1/process/:id/output` |
| JobService | `POST /v1/jobs/start`, `GET /v1/jobs/:id/stream` (SSE), `POST /v1/jobs/:id/{input,signal,stop}`, `GET /v1/jobs/:id` |
| SandboxService | `GET /v1/sandbox/backends`, `POST /v1/sandbox/select` |
| PolicyService | `POST /v1/policy/evaluate` |
| SecretService | `POST /v1/secrets/{request,audit,redact}` |
| NetworkService | `POST /v1/network/request`, `GET /v1/network/allowlist` |
| CodeIntelligenceService | `POST /v1/code-intel/{inspect-symbol,find-references,diagnose-files}` |
| ExtensionRuntimeService | `POST /v1/extensions/{load,invoke}` |
| ArtifactIngestService | `POST /v1/artifacts/ingest`, `GET /v1/artifacts/:hash`, `GET /v1/artifacts/:hash/metadata`, `POST /v1/artifacts/gc` |

## Auth

- **Bearer token**: `Authorization: Bearer <TERMINUS_KERNEL_TOKEN>` (default
  `terminus-kernel-dev-token`).
- **Capability token**: mutating endpoints require `x-capability-token`
  validated via the compatibility crate `forge_authz::TokenIssuer::validate()`. A long-lived dev token
  is minted at startup and logged.

## Errors

All errors use the SPEC §30.4 envelope:
`{ error: { code, message, retryable, category, details, suggested_action, trace_id } }`.

## Honest enforcement reporting

Per SPEC §13.4, the kernel NEVER silently downgrades. The `/v1/health`
endpoint reports:
- `enforced`: controls currently enforced (process_isolation,
  ambient_secret_denial, plugin_ambient_authority_denial,
  cgroup_resource_limits).
- `unsupported`: controls NOT enforced in this build
  (filesystem_isolation, network_isolation, seccomp_filter, no_new_privs,
  pid_namespace, mount_namespace, user_namespace).
- `status: degraded` — explicit, never silent.
