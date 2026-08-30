import { describe, expect, test } from "bun:test";
import {
  parseStandaloneToolCall,
  selectDiscoveredStandaloneToolSchemas,
  selectStandaloneToolSchemas,
} from "../agent-tools.js";

describe("progressive capability runtime", () => {
  test("keeps discovery available while optional schemas activate progressively", () => {
    const base = selectStandaloneToolSchemas({ toolsEnabled: true, adaptiveToolsEnabled: false })
      .map((tool) => tool.id);
    expect(base).toContain("capability");
    expect(base).not.toContain("web_fetch");

    const activated = selectStandaloneToolSchemas({
      toolsEnabled: true,
      adaptiveToolsEnabled: false,
      activatedCapabilities: ["standalone.web_fetch"],
    }).map((tool) => tool.id);
    expect(activated).toContain("capability");
    expect(activated).toContain("web_fetch");

    const preWorkspace = selectDiscoveredStandaloneToolSchemas({
      toolsEnabled: true,
      activatedCapabilities: ["standalone.web_fetch"],
    }).map((tool) => tool.id);
    expect(preWorkspace).toEqual(["capability", "web_fetch"]);
  });

  test("parses bounded discovery commands and rejects ambiguous activation", () => {
    const search = parseStandaloneToolCall({
      toolCallId: "cap-search",
      toolName: "capability",
      arguments: { action: "search", query: "public web" },
    });
    expect(search).toMatchObject({
      toolId: "capability",
      toolVersion: "standalone-v2",
      arguments: { action: "search", query: "public web", cursor: 0, limit: 8 },
    });
    expect(() => parseStandaloneToolCall({
      toolCallId: "cap-activate",
      toolName: "capability",
      arguments: { action: "activate", capability_id: "" },
    })).toThrow(/capability_id/);
  });
});
