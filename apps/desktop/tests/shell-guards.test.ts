import { describe, expect, test } from "vitest";
import { packagedRendererAssetPath } from "../electron/shell-guards";

describe("packaged renderer protocol guard", () => {
  test.each([
    ["terminus://app/", "index.html"],
    ["terminus://app/index.html", "index.html"],
    ["terminus://app/assets/index-abc.js", "assets/index-abc.js"],
    ["terminus://app/assets/theme%20file.css", "assets/theme file.css"],
  ])("resolves a trusted packaged asset: %s", (url, expected) => {
    expect(packagedRendererAssetPath(url)).toBe(expected);
  });

  test.each([
    "file:///tmp/index.html",
    "https://app/index.html",
    "terminus://other/index.html",
    "terminus://user@app/index.html",
    "terminus://app/assets/../index.html",
    "terminus://app/assets/%2e%2e/index.html",
    "terminus://app/assets/%5c..%5csecret",
    "terminus://app/index.html?override=1",
    "terminus://app/index.html#other",
    "not a url",
  ])("rejects an untrusted or non-canonical URL: %s", (url) => {
    expect(packagedRendererAssetPath(url)).toBeNull();
  });
});
