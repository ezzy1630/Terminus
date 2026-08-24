export interface ControlRuntimeTarget {
  readonly rustTarget: string;
  readonly bunTarget: string;
  readonly prismaTarget: string;
  readonly artifactName: string;
  readonly executableName: string;
}

export const CONTROL_RUNTIME_TARGETS = [
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    bunTarget: "bun-linux-x64-baseline",
    prismaTarget: "debian-openssl-3.0.x",
    artifactName: "terminus-control-linux-amd64.tar.gz",
    executableName: "terminus-control",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    bunTarget: "bun-linux-arm64",
    prismaTarget: "linux-arm64-openssl-3.0.x",
    artifactName: "terminus-control-linux-arm64.tar.gz",
    executableName: "terminus-control",
  },
  {
    rustTarget: "aarch64-apple-darwin",
    bunTarget: "bun-darwin-arm64",
    prismaTarget: "darwin-arm64",
    artifactName: "terminus-control-darwin-arm64.tar.gz",
    executableName: "terminus-control",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    bunTarget: "bun-darwin-x64-baseline",
    prismaTarget: "darwin",
    artifactName: "terminus-control-darwin-amd64.tar.gz",
    executableName: "terminus-control",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    bunTarget: "bun-windows-x64-baseline",
    prismaTarget: "windows",
    artifactName: "terminus-control-windows-amd64.tar.gz",
    executableName: "terminus-control.exe",
  },
] as const satisfies readonly ControlRuntimeTarget[];

export function controlRuntimeTarget(rustTarget: string): ControlRuntimeTarget {
  const target = CONTROL_RUNTIME_TARGETS.find((candidate) => candidate.rustTarget === rustTarget);
  if (!target) {
    throw new Error(
      `unsupported control runtime target ${rustTarget}; expected one of ${CONTROL_RUNTIME_TARGETS.map((candidate) => candidate.rustTarget).join(", ")}`,
    );
  }
  return target;
}

export function hostRustTarget(): string {
  const key = `${process.platform}/${process.arch}`;
  const targets: Readonly<Record<string, string>> = {
    "linux/x64": "x86_64-unknown-linux-gnu",
    "linux/arm64": "aarch64-unknown-linux-gnu",
    "darwin/arm64": "aarch64-apple-darwin",
    "darwin/x64": "x86_64-apple-darwin",
    "win32/x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[key];
  if (!target) throw new Error(`unsupported control runtime build host: ${key}`);
  return target;
}
