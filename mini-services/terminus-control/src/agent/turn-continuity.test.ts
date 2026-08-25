import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_EXCERPT_MAX_CHARS,
  USER_EXCERPT_MAX_CHARS,
  buildRecentHistorySection,
  excerpt,
  shouldInjectRecentHistory,
} from "./turn-continuity.js";

describe("R5 cross-turn continuity", () => {
  test("excerpts pass short text through untouched", () => {
    expect(excerpt("hello", 10)).toBe("hello");
    expect(excerpt(null, 10)).toBe("");
    expect(excerpt(undefined, 10)).toBe("");
  });

  test("excerpts truncate by code points with an explicit marker", () => {
    const long = "a".repeat(USER_EXCERPT_MAX_CHARS + 50);
    const cut = excerpt(long, USER_EXCERPT_MAX_CHARS);
    expect(Array.from(cut).length).toBe(USER_EXCERPT_MAX_CHARS);
    expect(cut.endsWith("…(truncated)")).toBe(true);
  });

  test("astral-plane text truncates on code points, not UTF-16 units", () => {
    const emoji = "🚀".repeat(30);
    // Max below the suffix length degrades to a bare cut within budget.
    const cut = excerpt(emoji, 10);
    expect(Array.from(cut).length).toBe(10);
  });

  test("recent-history section bounds both excerpts independently", () => {
    const section = buildRecentHistorySection({
      sequence: 3,
      userText: "u".repeat(USER_EXCERPT_MAX_CHARS + 100),
      assistantText: "a".repeat(ASSISTANT_EXCERPT_MAX_CHARS + 100),
      completedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(section.previous_turn.sequence).toBe(3);
    expect(section.previous_turn.user_excerpt.length).toBeLessThan(section.previous_turn.assistant_excerpt.length);
    expect(section.previous_turn.user_excerpt).toContain("…(truncated)");
    expect(section.previous_turn.completed_at).toBe("2026-08-25T00:00:00.000Z");
  });

  test("history is injected only when the turn window is empty", () => {
    expect(shouldInjectRecentHistory(0)).toBe(true);
    expect(shouldInjectRecentHistory(2)).toBe(false);
  });

  test("assistant excerpt cap matches the documented constant", () => {
    expect(ASSISTANT_EXCERPT_MAX_CHARS).toBe(4_000);
  });
});
