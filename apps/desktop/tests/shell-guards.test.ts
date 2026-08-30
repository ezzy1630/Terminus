import { describe, expect, test } from "vitest";
import {
  packagedRendererAssetPath,
  requireLocalTerminusOrigin,
} from "../electron/shell-guards";

describe("development control origin guard", () => {
  test.each([
    "http://127.0.0.1:3050",
    "http://localhost:3150",
    "http://127.0.0.1:65535/",
  ])("accepts an explicit loopback HTTP origin: %s", (origin) => {
    expect(requireLocalTerminusOrigin(origin, "TERMINUS_API_BASE")).toBe(
      origin.replace(/\/$/, ""),
    );
  });

  test.each([
    "https://127.0.0.1:3050",
    "http://0.0.0.0:3050",
    "http://example.com:3050",
    "http://127.0.0.1",
    "http://user@127.0.0.1:3050",
    "http://127.0.0.1:3050/v1",
    "http://127.0.0.1:3050?other=1",
  ])("rejects a non-loopback or non-origin value: %s", (origin) => {
    expect(() => requireLocalTerminusOrigin(origin, "TERMINUS_API_BASE")).toThrow(
      /explicit loopback Terminus origin/,
    );
  });
});

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
