import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_EXCERPT_MAX_CHARS,
  RECENT_HISTORY_MAX_TOKENS,
  RECENT_HISTORY_MIN_TOKENS,
  USER_EXCERPT_MAX_CHARS,
  buildRecentHistorySection,
  excerpt,
  recentHistoryExcerptLimits,
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

  test("history is injected until the model has acted in this turn", () => {
    expect(shouldInjectRecentHistory([])).toBe(true);
    // The regression: admission writes the user's own message as an episode
    // before the first compile, so the old `length === 0` gate meant
    // cross-turn history was never injected on any turn.
    expect(shouldInjectRecentHistory([{ kind: "user_message" }])).toBe(true);
    expect(shouldInjectRecentHistory([{ kind: "user_message" }, { kind: "steering_message" }])).toBe(true);
    for (const kind of ["model_message", "tool_call", "tool_result", "side_effect", "summary"]) {
      expect(shouldInjectRecentHistory([{ kind: "user_message" }, { kind }])).toBe(false);
    }
  });

  test("assistant excerpt cap matches the documented constant", () => {
    expect(ASSISTANT_EXCERPT_MAX_CHARS).toBe(4_000);
  });
});

describe("recent-history excerpt budget", () => {
  const totalChars = (tokens: number): number => {
    const limits = recentHistoryExcerptLimits(tokens);
    return limits.userMaxChars + limits.assistantMaxChars;
  };

  test("scales with the compiler's optional-context target", () => {
    expect(totalChars(150_000)).toBeGreaterThan(totalChars(60_000));
    expect(totalChars(60_000)).toBeGreaterThan(totalChars(25_000));
    // Below the floor every window gets the same minimum.
    expect(totalChars(20_000)).toBe(totalChars(5_000));
  });

  test("clamps to a floor and a ceiling so no window is starved or flooded", () => {
    expect(totalChars(0)).toBe(Math.floor(RECENT_HISTORY_MIN_TOKENS * 3.6));
    expect(totalChars(10_000_000)).toBe(Math.floor(RECENT_HISTORY_MAX_TOKENS * 3.6));
    expect(totalChars(Number.NaN)).toBe(Math.floor(RECENT_HISTORY_MIN_TOKENS * 3.6));
  });

  test("the assistant excerpt gets twice the user excerpt", () => {
    const limits = recentHistoryExcerptLimits(100_000);
    expect(limits.assistantMaxChars).toBeGreaterThan(limits.userMaxChars * 1.9);
    expect(limits.assistantMaxChars).toBeLessThan(limits.userMaxChars * 2.1);
  });

  test("the section honours the supplied limits, not the legacy constants", () => {
    const section = buildRecentHistorySection(
      { sequence: 3, userText: "u".repeat(9_000), assistantText: "a".repeat(9_000), completedAt: null },
      recentHistoryExcerptLimits(1_000),
    );
    expect(section.previous_turn.user_excerpt.length).toBeLessThan(USER_EXCERPT_MAX_CHARS);
    expect(section.previous_turn.assistant_excerpt.length).toBeLessThan(ASSISTANT_EXCERPT_MAX_CHARS);
    const large = buildRecentHistorySection(
      { sequence: 3, userText: "u".repeat(90_000), assistantText: "a".repeat(90_000), completedAt: null },
      recentHistoryExcerptLimits(400_000),
    );
    expect(large.previous_turn.user_excerpt.length).toBeGreaterThan(USER_EXCERPT_MAX_CHARS);
    expect(large.previous_turn.assistant_excerpt.length).toBeGreaterThan(ASSISTANT_EXCERPT_MAX_CHARS);
  });

  test("the default is the legacy constant pair (back-compat)", () => {
    const section = buildRecentHistorySection({
      sequence: 1,
      userText: "u".repeat(9_000),
      assistantText: "a".repeat(9_000),
      completedAt: null,
    });
    expect(section.previous_turn.user_excerpt.length).toBe(USER_EXCERPT_MAX_CHARS);
    expect(section.previous_turn.assistant_excerpt.length).toBe(ASSISTANT_EXCERPT_MAX_CHARS);
  });
});
