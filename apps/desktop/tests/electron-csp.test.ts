import { describe, expect, test } from "vitest";
import {
  buildContentSecurityPolicy,
  devConnectSources,
  packagedConnectSources,
  shouldApplyPolicyHeader,
  withPolicyHeader,
  DEV_RENDERER_ORIGIN,
  PACKAGED_CSP_API_PLACEHOLDER,
} from "../electron/csp";

const PACKAGED_POLICY = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:3050; font-src 'self'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

describe("content security policy", () => {
  test("packaged policy is the exact required string", () => {
    expect(buildContentSecurityPolicy({
      connectSources: packagedConnectSources(PACKAGED_CSP_API_PLACEHOLDER),
    })).toBe(PACKAGED_POLICY);
  });

  test("every required directive is present", () => {
    const policy = buildContentSecurityPolicy({ connectSources: ["'self'"] });
    for (const directive of [
      "default-src",
      "script-src",
      "worker-src",
      "style-src",
      "img-src",
      "connect-src",
      "font-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
      "object-src",
    ]) {
      expect(policy).toContain(`${directive} `);
    }
  });

  test("the dev policy allows the Vite refresh preamble and the HMR socket", () => {
    const policy = buildContentSecurityPolicy({
      connectSources: devConnectSources("http://localhost:3050"),
      allowInlineScripts: true,
      allowBlobWorkers: true,
    });
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("ws://localhost:5173");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain(DEV_RENDERER_ORIGIN);
  });

  test("the dev policy admits the validated alternate control origin", () => {
    const policy = buildContentSecurityPolicy({
      connectSources: devConnectSources("http://127.0.0.1:3150"),
      allowInlineScripts: true,
      allowBlobWorkers: true,
    });

    expect(policy).toContain("http://127.0.0.1:3150");
  });

  test("packaged builds never relax script-src", () => {
    const policy = buildContentSecurityPolicy({ connectSources: ["'self'"] });
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("worker-src 'self';");
    expect(policy).not.toContain("worker-src 'self' blob:");
  });

  test("connect sources are de-duplicated", () => {
    expect(packagedConnectSources("'self'")).toEqual(["'self'"]);
  });

  test.each([
    [[]],
    [["'self'", "http://a b"]],
    [["'self'", "http://a;b"]],
  ])("refuses an unusable connect source list: %j", (sources) => {
    expect(() => buildContentSecurityPolicy({ connectSources: sources })).toThrow();
  });
});

describe("policy header application", () => {
  test("applies to documents from an allowed origin", () => {
    expect(shouldApplyPolicyHeader(`${DEV_RENDERER_ORIGIN}/?app=terminus`, "mainFrame", [DEV_RENDERER_ORIGIN]))
      .toBe(true);
  });

  test.each([
    [`${DEV_RENDERER_ORIGIN}/assets/index.js`, "script"],
    ["http://evil.example/index.html", "mainFrame"],
    ["not a url", "mainFrame"],
  ])("skips %s (%s)", (url, resourceType) => {
    expect(shouldApplyPolicyHeader(url, resourceType, [DEV_RENDERER_ORIGIN])).toBe(false);
  });

  test("replaces any policy the response already carried", () => {
    const headers = withPolicyHeader(
      { "content-security-policy": ["default-src *"], "Content-Type": "text/html" },
      PACKAGED_POLICY,
    );
    expect(headers["Content-Security-Policy"]).toEqual([PACKAGED_POLICY]);
    expect(Object.keys(headers).filter((name) => name.toLowerCase().startsWith("content-security-policy")))
      .toHaveLength(1);
    expect(headers["Content-Type"]).toEqual(["text/html"]);
  });
});
