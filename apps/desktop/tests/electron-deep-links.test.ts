import { describe, expect, test } from "vitest";
import { findDeepLink, parseDeepLink, projectDeepLink, taskDeepLink } from "../electron/deep-links";
import { packagedRendererAssetPath } from "../electron/shell-guards";

const TASK_ID = "3f8b6c1e-2a4d-4f9b-8c7e-1d2a3b4c5d6e";

describe("deep links", () => {
  test("routes a task link", () => {
    expect(parseDeepLink(`terminus://task/${TASK_ID}`)).toEqual({ kind: "task", taskId: TASK_ID });
  });

  test("routes a project link", () => {
    expect(parseDeepLink(`terminus://project/${TASK_ID}`)).toEqual({ kind: "project", sessionId: TASK_ID });
  });

  test("round-trips the links the shell builds", () => {
    expect(parseDeepLink(taskDeepLink(TASK_ID))).toEqual({ kind: "task", taskId: TASK_ID });
    expect(parseDeepLink(projectDeepLink(TASK_ID))).toEqual({ kind: "project", sessionId: TASK_ID });
  });

  test.each([
    [`terminus://app/index.html`],
    [`terminus://task/not-a-uuid`],
    [`terminus://task/${TASK_ID}?redirect=1`],
    [`terminus://task/${TASK_ID}#fragment`],
    [`terminus://task:9000/${TASK_ID}`],
    [`https://task/${TASK_ID}`],
    [`terminus://other/${TASK_ID}`],
    ["terminus://task/"],
    [42],
    [null],
  ])("refuses %j", (value) => {
    expect(parseDeepLink(value)).toBeNull();
  });

  test("the packaged asset host is never a deep link, and deep-link hosts are never assets", () => {
    expect(parseDeepLink("terminus://app/index.html")).toBeNull();
    expect(packagedRendererAssetPath(`terminus://task/${TASK_ID}`)).toBeNull();
  });

  test("finds a link in a relaunched instance's argv", () => {
    expect(findDeepLink([
      "/Applications/Terminus.app/Contents/MacOS/Terminus",
      "--allow-file-access-from-files",
      `terminus://project/${TASK_ID}`,
    ])).toEqual({ kind: "project", sessionId: TASK_ID });
  });

  test("returns null when argv carries no link", () => {
    expect(findDeepLink(["/Applications/Terminus.app/Contents/MacOS/Terminus"])).toBeNull();
  });
});
