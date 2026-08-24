#!/usr/bin/env bun
/**
 * acp-config.ts — scaffold editor and t3code Agent Client Protocol (ACP) configs.
 *
 * Emits copy-pasteable configuration blocks for connecting external editors
 * (t3code, VS Code, Cursor, Zed, Neovim) to the Terminus IDE-ACP bridge.
 *
 * Usage:
 *   bun run tools/scaffold/acp-config.ts
 *   bun run tools/scaffold/acp-config.ts --write-vscode
 */
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const ACP_SCRIPT = join(ROOT, "apps", "ide-acp", "src", "index.ts");

const t3codeConfig = {
  name: "Terminus Operator",
  type: "acp",
  command: "bun",
  args: [ACP_SCRIPT],
  env: {
    TERMINUS_GATEWAY: "http://127.0.0.1:81",
  },
  features: {
    contextSync: true,
    structuredInterventions: true,
    attentionPrompts: true,
    causalReplay: true,
  },
};

const vscodeConfig = {
  "terminus.acp.command": "bun",
  "terminus.acp.args": [ACP_SCRIPT],
  "terminus.acp.gateway": "http://127.0.0.1:81",
  "terminus.acp.autoSyncContext": true,
};

const zedConfig = {
  lsp: {
    "terminus-acp": {
      binary: {
        path: "bun",
        arguments: [ACP_SCRIPT],
      },
    },
  },
};

function main(): void {
  const args = process.argv.slice(2);
  const writeVscode = args.includes("--write-vscode");

  console.log("==================================================================");
  console.log(" Terminus Agent Client Protocol (ACP) Configuration Generator");
  console.log("==================================================================\n");

  console.log("1. t3code Configuration (~/Library/Application Support/t3code/agents.json or t3code.json):");
  console.log(JSON.stringify(t3codeConfig, null, 2));
  console.log("\n------------------------------------------------------------------");

  console.log("2. VS Code / Cursor Settings (.vscode/settings.json):");
  console.log(JSON.stringify(vscodeConfig, null, 2));
  console.log("\n------------------------------------------------------------------");

  console.log("3. Zed Editor Configuration (~/.config/zed/settings.json):");
  console.log(JSON.stringify(zedConfig, null, 2));
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
        current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      } catch {
        current = {};
      }
    }
    Object.assign(current, vscodeConfig);
    writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n");
    console.log(`[acp-config] updated ${settingsPath} successfully.`);
  }
}

main();
