# terminus-fs

Workspace-relative path resolution with traversal and symlink-escape protection.

`SafePath` is a newtype that wraps a lexically validated workspace-relative
path: it rejects absolute paths, parent-traversal (`..`), backslashes, NUL
bytes, Windows drive/UNC prefixes, and protected components such as `.git`,
`.env`, `credentials`, `secret-store`, and `host`. `PathResolver` then turns
a `SafePath` into an absolute host path while refusing to follow symlinks
that escape the canonical workspace root.

The crate also exposes a minimal `workspace://`, `artifact://`, `secret://`,
`terminus-state://`, `host://` URI parser used throughout the kernel. The API
is intentionally small and easy to property-test (SPEC.md Section 31.5).
