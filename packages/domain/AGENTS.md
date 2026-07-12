# @forge/domain — local rules

## Non-negotiable

- No I/O. No `child_process`, `fs`, network, or secret access.
- No provider SDK imports. Domain is provider-neutral.
- No `any`. Use `unknown` and decode at boundaries.
- Monetary values MUST be `Micros` (bigint). Floating-point money is forbidden.
- Token/byte counts MUST be `bigint` at the storage boundary.
- Identifiers follow SPEC §28.1: UUIDv7 strings, `sha256:<hex>` hashes,
  `artifact://sha256/<hex>` artifact URIs.

## Style

- Use `as const` objects for string unions (so consumers can iterate values).
- Provide a zod schema for every type that crosses a boundary.
- Use `readonly` everywhere on aggregate fields.
- Use `Readonly<Record<K, V>>` instead of `Record<K, V>` on public surfaces.
- Exhaustive switches MUST end with `assertNever(x)`.

## Error policy

- All errors extend `ForgeError` and carry `code`, `category`, `retryable`,
  `details`, `suggestedAction`, `traceId`.
- Never throw raw `Error` for domain failures.
- Use `asForgeError(err)` to narrow caught values.

## What NOT to add

- Database access (`PrismaClient`, raw SQL).
- HTTP handlers or middleware.
- Logging side effects.
- Provider request/response shapes (those live in `@forge/provider-core`).
