import { cp } from "node:fs/promises";

// Next's standalone output intentionally excludes static assets and public
// files. Use the platform-neutral Node API so release packaging works on all
// supported CI hosts, including Windows.
await cp(".next/static", ".next/standalone/.next/static", {
  force: true,
  recursive: true,
});
await cp("public", ".next/standalone/public", {
  force: true,
  recursive: true,
});
