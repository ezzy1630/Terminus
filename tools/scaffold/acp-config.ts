#!/usr/bin/env bun
/**
 * acp-config.ts — scaffold editor configs for the Terminus custom JSON-RPC bridge.
 *
 * Emits copy-pasteable configuration blocks for connecting external editors
 * (t3code, VS Code, Cursor, Zed, Neovim) to the Terminus IDE bridge. The
 * generated bridge is JSON-RPC-over-stdio and is not ACP v1 compatible.
 *
 * Usage:
 *   bun run tools/scaffold/acp-config.ts
 *   bun run tools/scaffold/acp-config.ts --write-vscode
 */
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const ACP_SCRIPT = join(ROOT, "apps", "ide-acp", "src", "index.ts");

const t3codeConfig = {
  name: "Terminus Operator",
  type: "custom",
  protocol: "terminus-json-rpc",
  command: "bun",
  args: [ACP_SCRIPT],
  env: {
    TERMINUS_GATEWAY: "http://127.0.0.1:81",
    TERMINUS_TOKEN: "${TERMINUS_TOKEN}",
  },
  features: {
    contextSync: true,
    structuredInterventions: true,
    attentionPrompts: true,
    causalReplay: true,
  },
};

const vscodeConfig = {
  "terminus.bridge.command": "bun",
  "terminus.bridge.args": [ACP_SCRIPT],
  "terminus.bridge.gateway": "http://127.0.0.1:81",
  "terminus.bridge.protocol": "terminus-json-rpc",
  "terminus.bridge.autoSyncContext": true,
};

function assertJsoncValues(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`[acp-config] ${path} contains a non-finite number`);
  }
  if (value === undefined) {
    throw new Error(`[acp-config] ${path} contains an undefined value`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsoncValues(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertJsoncValues(item, `${path}.${key}`);
    }
  }
}

function parseSettingsJsonc(source: string, path: string): Record<string, unknown> {
  const parsed = Bun.JSON5.parse(source) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[acp-config] refusing to overwrite ${path}: expected a JSONC object`);
  }
  assertJsoncValues(parsed, path);
  return parsed as Record<string, unknown>;
}

function main(): void {
  const args = process.argv.slice(2);
  const writeVscode = args.includes("--write-vscode");

  console.log("==================================================================");
  console.log(" Terminus custom JSON-RPC bridge Configuration Generator");
  console.log("==================================================================\n");

  console.log("1. t3code Configuration (~/Library/Application Support/t3code/agents.json or t3code.json):");
  console.log(JSON.stringify(t3codeConfig, null, 2));
  console.log("\n------------------------------------------------------------------");

  console.log("2. VS Code / Cursor Settings (.vscode/settings.json):");
  console.log(JSON.stringify(vscodeConfig, null, 2));
  console.log("\n------------------------------------------------------------------");

  console.log("3. Zed Editor Configuration:");
  console.log("No native Zed agent_servers block is emitted: this bridge speaks Terminus JSON-RPC, not ACP v1.");
  console.log("\n------------------------------------------------------------------");

  if (writeVscode) {
    const vscodeDir = join(ROOT, ".vscode");
    if (!existsSync(vscodeDir)) {
      mkdirSync(vscodeDir, { recursive: true });
    }
    const settingsPath = join(vscodeDir, "settings.json");
    let current: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        // Bun's JSON5 parser accepts VS Code JSONC comments and trailing
        // commas while still rejecting malformed content. The output is
        // canonical JSON, so existing comments are not silently preserved as
        // stale configuration text.
        current = parseSettingsJsonc(readFileSync(settingsPath, "utf8"), settingsPath);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[acp-config] refusing to overwrite ${settingsPath}: ${reason}`,
          { cause: error },
        );
      }
    }
    Object.assign(current, vscodeConfig);
    writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n");
    console.log(`[acp-config] updated ${settingsPath} successfully.`);
  }
}

main();
