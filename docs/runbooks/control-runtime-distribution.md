# Control runtime distribution

The control release artifact is `terminus-control-<platform>-<architecture>.tar.gz`.
It is self-contained: the archive carries a compiled Terminus control executable,
the matching Prisma query engine, the canonical Prisma schema, checksum-verified
SQLite migrations, licenses, and a commit-bound manifest. It does not load code,
dependencies, schema, or migrations from a repository checkout.
Release packaging fails when the source tree is dirty, and the manifest records
that clean-source invariant alongside the candidate commit.

## Install and start

Extract one archive into a versioned directory. Keep the prior directory until
the upgrade has passed health checks.

```text
tar -xzf terminus-control-linux-amd64.tar.gz
export DATABASE_URL=file:/var/lib/terminus/control.db
export TERMINUS_KERNEL_GRPC_SOCKET=/run/terminus/kernel.sock
./terminus-control/bin/terminus-control migrate
# The deployment secret manager injects both bearer values into the service
# process; their values never appear in shell history or release artifacts.
secret-manager exec \
  --env TERMINUS_CONTROL_TOKEN=terminus/control-token \
  --env TERMINUS_KERNEL_CONTROL_BOOTSTRAP=1 \
  --env TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN=terminus/kernel/control-bootstrap \
  -- ./terminus-control/bin/terminus-control serve
```

`migrate` is explicit and idempotent. It verifies every previously applied
migration name and SHA-256 before applying pending migration programs in
individual `BEGIN IMMEDIATE` transactions. A mismatch or failed integrity check
stops startup. Back up the SQLite database before applying an irreversible
release migration.

`serve` requires `TERMINUS_CONTROL_TOKEN` and `TERMINUS_KERNEL_GRPC_SOCKET`. The
kernel must expose its owner-restricted UDS and standalone control bootstrap as
defined by ADR-0039. The control process forces Prisma to load the query engine
inside the same signed package; an ambient `PRISMA_QUERY_ENGINE_LIBRARY` cannot
redirect it.

## Verify

The release workflow performs three distinct checks:

1. `verify-control-runtime-package.ts` validates the archive structure, target,
   candidate commit, version, manifest inventory, file modes, and every digest.
2. Cosign verifies the archive signature against the release workflow identity.
3. `smoke-control-runtime.sh` extracts the exact Linux archive outside the source
   checkout, runs its migrations twice, starts it against the exact release
   kernel binary, and requires a ready kernel and healthy writer lease.

Operators can inspect identity without starting the service:

```text
./terminus-control/bin/terminus-control version
```

## Desktop bundle contract

The signed macOS app carries one architecture-specific runtime at
`process.resourcesPath/runtime`. There is no source-checkout fallback and no
environment variable that redirects this root. Its layout is fixed:

```text
runtime/
├── manifest.json
├── bin/terminus-kernel-mini
└── terminus-control/
    ├── manifest.json
    ├── bin/terminus-control
    ├── lib/terminus/query-engine.node
    └── share/terminus/
        ├── schema.prisma
        └── migrations/sqlite/*.sql
```

`runtime/manifest.json` uses schema `terminus.desktop-runtime.v1`. It binds the
build kind, release version, candidate commit, Darwin target, Electron architecture, nested
control manifest, control executable, Prisma query engine, and kernel executable
to relative paths and SHA-256 digests. The nested control manifest continues to
bind the schema, migrations, licenses, and other unchanged distribution files.
The release workflow signs the three Mach-O runtime files first, records their
final digests, and prevents electron-builder from signing them a second time.
The enclosing app signature seals the combined manifest and runtime directory.
Release artifacts require `build_kind: "release"` and a clean nested control
manifest. The unsigned local packaging recipe uses `build_kind: "local"`, keeps
`source_tree_clean: false` when the checkout is dirty, and binds the same value
through packaged metadata. The supervisor never treats a local build as a
release.

The desktop supervisor starts the fixed kernel path with
`TERMINUS_KERNEL_REQUIRE_UDS=1`, `TERMINUS_KERNEL_CONTROL_BOOTSTRAP=1`, and
`TERMINUS_KERNEL_GRPC_SOCKET` set to an owner-only Unix socket. It then runs the
fixed control path once with `migrate` and `DATABASE_URL=file:/absolute/path.db`.
After migration succeeds, it starts the same executable with `serve`,
`TERMINUS_CONTROL_TOKEN`, `TERMINUS_KERNEL_GRPC_SOCKET`, and the same
`DATABASE_URL`. Neither executable accepts a repository path.

Rollback means stopping the new control process and starting the prior artifact
against a compatible database. If the release contains a non-reversible schema
migration, restore the pre-migration snapshot first; do not point older code at a
schema outside its declared compatibility window.
