# AGENTS.md — terminus-fs

## Local rules

- **No `unsafe`.** Path manipulation must stay in safe Rust.
- **No I/O in `SafePath`.** `SafePath` is a pure lexical validator; it must
  not touch the filesystem. All filesystem work lives in `PathResolver`.
- **Symlink policy.** `PathResolver::resolve` MUST reject any symlink whose
  canonical target leaves the workspace root. Dangling symlinks are denied
  too — fail closed.
- **Protected paths.** `.git`, `.terminus`, `credentials`, `secrets`, `.ssh`,
  `.aws`, `.env`, `secret-store`, `host` are protected from model-driven
  writes. New protected prefixes go in `protected.rs` and require a test.
- **No panics.** Return `PathError` rather than `unwrap`/`expect`/`panic!`.
- **Cross-platform note.** We are honest about Windows: device names and UNC
  prefixes are rejected. Full Windows ACL handling is out of scope for M2.
