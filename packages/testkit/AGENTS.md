# @forge/testkit — local rules

## Non-negotiable

- No real I/O. Fixtures are pure and in-memory.
- No secrets in fixture data. Use opaque `secret://` URIs.
- Fixture-generated content hashes are deterministic and clearly fake.

## Style

- Builders accept `Partial<T>` overrides and fill sensible defaults.
- Keep `FakeProvider` scriptable enough to simulate every documented failure
  mode (rate limit, malformed args, malicious args, cache usage).

## What NOT to add

- Real HTTP server or kernel client.
- Shared mutable state across test files (each test should construct its own
  fixtures).
