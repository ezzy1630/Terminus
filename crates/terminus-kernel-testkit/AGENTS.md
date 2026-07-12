# AGENTS.md — terminus-kernel-testkit

## Local rules

- **Tests only.** This crate MUST NOT be a dependency of any production
  crate. It is `dev-dependency` only.
- **No real I/O unless asked.** `InMemoryArtifactStore` is preferred for
  fast unit tests. `real_store_in_tempdir` is provided when the on-disk CAS
  layout matters.
- **Mock sandbox is honest.** `MockSandbox` reports `Enforced` and supports
  any profile that does not request ambient secrets. It does NOT actually
  enforce anything — its purpose is to let tests exercise the manager.
- **No `unsafe`.** `unwrap`/`expect` are OK in this crate because it is
  test-only.
