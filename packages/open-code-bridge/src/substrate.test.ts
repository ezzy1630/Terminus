import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BYPASS_REGISTER,
  ExtensionLockfileValidator,
  OpenCodeBridgeAdapter,
  captureProviderRequest,
  getBrokeredSecret,
  inheritedExec,
  inheritedFetch,
  inheritedGitCommand,
  inheritedReadFile,
  inheritedWriteFile,
  redactSecretsInText,
  registerSecretCapability,
  setKernelFileClient,
  setKernelProcessClient,
  setNetworkBrokerClient,
  setOutOfProcessPluginHost,
  setSecretCapabilityProvider,
  setTerminusGitClient,
  wrapLegacyPluginHook,
  type ExtensionLockfile,
} from "./index.js";

describe("OpenCode Substrate Ownership & Effect Interception Suite", () => {
  test("Requirement 1: All 6 bypass entries migrated to removed status", () => {
    expect(DEFAULT_BYPASS_REGISTER).toHaveLength(6);
    for (const entry of DEFAULT_BYPASS_REGISTER) {
      expect(entry.status).toBe("removed");
      expect(entry.containment).toBeDefined();
      expect(entry.removal_milestone).toBeDefined();
      expect(entry.test).toBe("packages/open-code-bridge/src/substrate.test.ts");
    }
  });

  test("Requirement 2: Exact context visibility & provider request capturing", () => {
    const req = captureProviderRequest("anthropic", "claude-3-5-sonnet", "Implement feature X");
    expect(req.provider).toBe("anthropic");
    expect(req.model).toBe("claude-3-5-sonnet");
    expect(req.prompt).toBe("Implement feature X");
    expect(req.systemPrompt).toContain("Terminus AI agent");
    expect(req.tools.length).toBe(7);
  });

  test("Requirement 3: Total effect interception — Execution routed via kernel process RPC", async () => {
    let processRpcCalled = false;
    setKernelProcessClient({
      startProcess: async (req) => {
        processRpcCalled = true;
        return {
          exitCode: 0,
          stdout: `KernelRPC stdout for ${req.command}`,
          stderr: "",
        };
      },
    });

    const res = await inheritedExec("ls", ["-la"]);
    expect(processRpcCalled).toBe(true);
    expect(res.viaKernelRpc).toBe(true);
    expect(res.stdout).toContain("KernelRPC stdout for ls");
    setKernelProcessClient(null);
  });

  test("Requirement 4: Total effect interception — Filesystem writes routed via kernel file RPC", async () => {
    let fileRpcCalled = false;
    setKernelFileClient({
      writeFile: async (req) => {
        fileRpcCalled = true;
        return { success: true, bytesWritten: req.content.length };
      },
      readFile: async (req) => {
        return { content: `KernelFileRPC content for ${req.filePath}` };
      },
    });

    await inheritedWriteFile("foo.txt", "hello world");
    expect(fileRpcCalled).toBe(true);

    const content = await inheritedReadFile("foo.txt");
    expect(content).toContain("KernelFileRPC content for");
    setKernelFileClient(null);
  });

  test("Requirement 5: Total effect interception — Network traffic routed via AuthorizedNetworkBroker", async () => {
    let networkBrokerCalled = false;
    setNetworkBrokerClient({
      fetch: async (req) => {
        networkBrokerCalled = true;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "NetworkBroker OK", url: req.url }),
          viaNetworkBroker: true,
        };
      },
    });

    const res = await inheritedFetch({ url: "https://api.anthropic.com/v1/messages" });
    expect(networkBrokerCalled).toBe(true);
    expect(res.viaNetworkBroker).toBe(true);
    expect(res.status).toBe(200);
    setNetworkBrokerClient(null);
  });

  test("Requirement 6: Total effect interception — Secret reads replaced with capability tokens", () => {
    registerSecretCapability("OPENAI_API_KEY", "sk-cap-token-123456");
    const secretVal = getBrokeredSecret({ key: "OPENAI_API_KEY", scope: "authorized-kernel" });
    expect(secretVal).toBe("sk-cap-token-123456");

    const redacted = redactSecretsInText("Key is sk-cap-token-123456 in log");
    expect(redacted).toBe("Key is [REDACTED_SECRET_OPENAI_API_KEY] in log");

    // Scope violation check
    expect(() =>
      getBrokeredSecret({ key: "OPENAI_API_KEY", scope: "untrusted-plugin" })
    ).toThrow("Security Violation");
  });

  test("Requirement 7: Total effect interception — Plugins executed out-of-process via worker IPC", async () => {
    let pluginHostCalled = false;
    setOutOfProcessPluginHost({
      invokeHook: async (pluginName, hookName, args) => {
        pluginHostCalled = true;
        return { status: "invoked_out_of_process", pluginName, hookName };
      },
    });

    const hook = wrapLegacyPluginHook("test-plugin", {
      name: "onBeforeRun",
      execute: async () => ({ status: "direct" }),
    });

    const result = (await hook.execute({ task: "build" })) as Record<string, unknown>;
    expect(pluginHostCalled).toBe(true);
    expect(result.status).toBe("invoked_out_of_process");

    // Ambient authority denial check
    expect(hook.execute({ __raw_process__: true })).rejects.toThrow("Security Violation");
    setOutOfProcessPluginHost(null);
  });

  test("Requirement 8: Total effect interception — Git effects routed through terminus-git RPC", async () => {
    let gitRpcCalled = false;
    setTerminusGitClient({
      execGit: async (args, worktreeDir) => {
        gitRpcCalled = true;
        return {
          exitCode: 0,
          stdout: `terminus-git output for ${args[0]}`,
          stderr: "",
          isTruncated: false,
          viaKernelRpc: true,
        };
      },
    });

    const res = await inheritedGitCommand(["status"], process.cwd());
    expect(gitRpcCalled).toBe(true);
    expect(res.stdout).toContain("terminus-git output for status");

    // Forbidden path denial check
    expect(inheritedGitCommand(["status", ".git/hooks/pre-commit"], process.cwd())).rejects.toThrow(
      "Security Violation"
    );
    setTerminusGitClient(null);
  });

  test("Requirement 9: Independent checkpoint/task ownership & adapter routing", async () => {
    const adapter = new OpenCodeBridgeAdapter();
    const createRes = await adapter.handle({ method: "session.create", params: { id: "sess_100" } });
    expect(createRes.result).toEqual(
      expect.objectContaining({
        session_id: "sess_100",
        status: "active",
      })
    );

    const resumeRes = await adapter.handle({
      method: "session.resume",
      params: { session_id: "sess_100", continuation_token: "cont_xyz" },
    });
    expect(resumeRes.result).toEqual(
      expect.objectContaining({
        session_id: "sess_100",
        continuation_token: "cont_xyz",
        status: "resumed",
      })
    );
  });

  test("Requirement 10: Extension lockfile enforcement & Secure Mode Plugin Guard", () => {
    const mockLockfile: ExtensionLockfile = {
      version: 1,
      extensions: {
        "official-linter": {
          id: "official-linter",
          version: "1.0.0",
          integrity: "sha256:abc123def456",
          scope: "trusted",
        },
      },
    };

    const validator = new ExtensionLockfileValidator(mockLockfile, { secureMode: true });

    // Valid extension passes
    expect(validator.validateExtension("official-linter", "1.0.0", "sha256:abc123def456")).toBe(true);

    // Integrity failure throws
    expect(() =>
      validator.validateExtension("official-linter", "1.0.0", "sha256:wronghash")
    ).toThrow("Integrity failure");

    // Unlocked extension in secure mode throws
    expect(() =>
      validator.validateExtension("unregistered-plugin", "1.0.0", "sha256:123")
    ).toThrow("Secure Mode Violation");

    // Automatic plugin installation is strictly disabled in secure mode
    expect(validator.canAutoInstallPlugin("official-linter")).toBe(false);
    expect(validator.canAutoInstallPlugin("unregistered-plugin")).toBe(false);
  });
});
