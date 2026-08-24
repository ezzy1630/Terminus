import { describe, expect, test } from "bun:test";
import { commandSuggestions } from "../src/commands.js";

describe("command suggestions", () => {
  test("filters command names while the first token is being typed", () => {
    expect(commandSuggestions("/re").map((command) => command.name)).toEqual(["refresh", "resume", "review"]);
    expect(commandSuggestions("/context manifest-1")).toEqual([]);
  });

  test("does not offer commands for a normal prompt", () => {
    expect(commandSuggestions("review this task")).toEqual([]);
  });
});
