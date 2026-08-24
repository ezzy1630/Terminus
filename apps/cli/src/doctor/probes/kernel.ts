import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResult } from "../types.js";

export async function probeKernel(rootDir: string, gatewayUrl?: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  // 1. Kernel Crates Structure
  const kernelCrate = join(rootDir, "crates", "terminus-kernel");
  const kernelMiniService = join(rootDir, "mini-services", "terminus-kernel");
  const crateExists = existsSync(kernelCrate);
  const miniServiceExists = existsSync(kernelMiniService);

  if (crateExists && miniServiceExists) {
    results.push({
      id: "kernel.crates",
      name: "Rust Kernel Crate Structure",
      status: "pass",
      message: "crates/terminus-kernel and mini-services/terminus-kernel present",
      details: { kernelCrate, kernelMiniService },
      isProductionInvariant: true,
    });
  } else {
    results.push({
      id: "kernel.crates",
      name: "Rust Kernel Crate Structure",
      status: "fail",
      message: `Missing kernel directory: crateExists=${crateExists}, miniServiceExists=${miniServiceExists}`,
      recommendation: "Ensure Rust kernel crates are intact",
      isProductionInvariant: true,
    });
  }

  // 2. Kernel UDS Socket
  const udsPath = process.env.TERMINUS_KERNEL_UDS_PATH ?? "/tmp/terminus.kernel.sock";
  const socketExists = existsSync(udsPath);
  if (socketExists) {
    results.push({
      id: "kernel.uds_socket",
      name: "Kernel UDS Socket Presence",
      status: "pass",
      message: `Active kernel UDS socket detected at ${udsPath}`,
      details: { udsPath },
      isProductionInvariant: false,
    });
  } else {
    results.push({
      id: "kernel.uds_socket",
      name: "Kernel UDS Socket Presence",
      status: "warn",
      message: `No active kernel socket found at ${udsPath} (kernel daemon is not running)`,
      details: { udsPath },
      recommendation: "Run `just run-kernel` or start the development stack with `just run`",
      isProductionInvariant: false,
    });
  }

  // 3. Live Kernel Health Probe (via Gateway/Control Service if specified)
  if (gatewayUrl) {
    try {
      const res = await fetch(`${gatewayUrl}/v1/system/health`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean; kernel?: { state?: string } };
        const isHealthy = body.ready === true || body.kernel?.state === "healthy" || body.kernel?.state === "ok";
        results.push({
          id: "kernel.live_health",
          name: "Kernel Live Health Check",
          status: isHealthy ? "pass" : "warn",
          message: isHealthy ? "Kernel daemon reports healthy status over RPC" : "Kernel daemon returned non-healthy state",
          details: body,
          isProductionInvariant: true,
        });
      } else {
        results.push({
          id: "kernel.live_health",
          name: "Kernel Live Health Check",
          status: "warn",
          message: `Control plane health endpoint returned HTTP ${res.status}`,
          details: { status: res.status, url: `${gatewayUrl}/v1/system/health` },
          isProductionInvariant: false,
        });
      }
    } catch (err) {
      results.push({
        id: "kernel.live_health",
        name: "Kernel Live Health Check",
        status: "warn",
        message: `Control plane not reachable at ${gatewayUrl} (${err instanceof Error ? err.message : String(err)})`,
        recommendation: "Start control service with `just run-control` to verify live RPC",
        isProductionInvariant: false,
      });
    }
  }

  return results;
}
