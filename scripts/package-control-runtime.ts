#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { writeDeterministicArchive, type ArchiveInput } from "./control-runtime/archive";
import { controlRuntimeTarget, hostRustTarget } from "./control-runtime/targets";

const ROOT = resolve(import.meta.dir, "..");
const ARCHIVE_ROOT = "terminus-control";

interface PackageFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: "0644" | "0755";
}

interface ControlRuntimeManifest {
  readonly schema: "terminus.control-runtime.v1";
  readonly version: string;
  readonly candidate_commit: string;
  readonly source_tree_clean: boolean;
  readonly source_date_epoch: number;
  readonly target: {
    readonly rust: string;
    readonly bun: string;
    readonly prisma: string;
  };
  readonly toolchain: {
    readonly bun: string;
    readonly prisma_client: string;
  };
  readonly entrypoint: string;
  readonly files: readonly PackageFile[];
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function boundedTail(value: string): string {
  const maximum = 8_000;
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}

async function run(command: readonly string[], environment: Readonly<Record<string, string>> = {}): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${exitCode}\n${boundedTail(stdout)}\n${boundedTail(stderr)}`,
    );
  }
  return stdout.trim();
}

async function walkFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function prismaSchemaForTarget(schema: string, output: string, binaryTarget: string): string {
  const generator = /generator\s+client\s*\{[\s\S]*?\}/;
  if (!generator.test(schema)) throw new Error("prisma/schema.prisma has no client generator block");
  const normalizedOutput = output.replaceAll("\\", "/");
  return schema.replace(generator, [
    "generator client {",
    '  provider      = "prisma-client-js"',
    `  output        = ${JSON.stringify(normalizedOutput)}`,
    `  binaryTargets = [${JSON.stringify(binaryTarget)}]`,
    "}",
  ].join("\n"));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceIdentity(): Promise<{
  readonly commit: string;
  readonly epoch: number;
  readonly clean: boolean;
}> {
  const commit = argument("commit")
    ?? process.env.TERMINUS_RELEASE_COMMIT
    ?? await run(["git", "rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`candidate commit must be a full lowercase Git SHA: ${commit}`);
  const configuredEpoch = process.env.SOURCE_DATE_EPOCH;
  const epochText = configuredEpoch ?? await run(["git", "show", "-s", "--format=%ct", commit]);
  const epoch = Number.parseInt(epochText, 10);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`invalid SOURCE_DATE_EPOCH: ${epochText}`);
  const clean = (await run(["git", "status", "--porcelain", "--untracked-files=all"])).length === 0;
  if (!clean && !process.argv.includes("--allow-dirty")) {
    throw new Error("control runtime packaging requires a clean source tree; --allow-dirty is development-only");
  }
  return { commit, epoch, clean };
}

async function packageControlRuntime(): Promise<void> {
  const rustTarget = argument("target") ?? hostRustTarget();
  const target = controlRuntimeTarget(rustTarget);
  const packageManifest = JSON.parse(
    await readFile(join(ROOT, "mini-services", "terminus-control", "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  const version = argument("version")
    ?? process.env.TERMINUS_RELEASE_VERSION
    ?? (typeof packageManifest.version === "string" ? packageManifest.version : "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`control runtime version must be stable SemVer: ${version}`);
  }
  const identity = await sourceIdentity();
  const output = resolve(argument("output") ?? join(ROOT, "dist", target.artifactName));
  if (basename(output) !== target.artifactName) {
    throw new Error(`output must be named ${target.artifactName}: ${output}`);
  }

  // Prisma discovers its generator package by walking from the schema to the
  // workspace package.json. Keep ephemeral generation under ignored
  // node_modules/.cache so no auto-install or checkout mutation is possible.
  const cache = join(ROOT, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, "terminus-control-package-"));
  const stage = join(temporary, ARCHIVE_ROOT);
  try {
    const binary = join(stage, "bin", target.executableName);
    const runtimeLibrary = join(stage, "lib", "terminus");
    const share = join(stage, "share", "terminus");
    await Promise.all([
      mkdir(dirname(binary), { recursive: true }),
      mkdir(runtimeLibrary, { recursive: true }),
      mkdir(share, { recursive: true }),
    ]);

    const generatedClient = join(temporary, "prisma-client");
    const temporarySchema = join(temporary, "schema.prisma");
    const canonicalSchema = await readFile(join(ROOT, "prisma", "schema.prisma"), "utf8");
    await writeFile(
      temporarySchema,
      prismaSchemaForTarget(canonicalSchema, generatedClient, target.prismaTarget),
      "utf8",
    );
    await run(
      ["bunx", "prisma", "generate", `--schema=${temporarySchema}`, "--no-hints"],
      { DATABASE_URL: `file:${join(temporary, "generate.db")}` },
    );
    const queryEngines = (await walkFiles(generatedClient)).filter((path) => {
      const name = basename(path);
      return name.endsWith(".node") && (name.startsWith("libquery_engine-") || name.startsWith("query_engine-"));
    });
    if (queryEngines.length !== 1) {
      throw new Error(`expected one Prisma query engine for ${target.prismaTarget}, found ${queryEngines.length}`);
    }

    await run([
      "bun", "build",
      "--compile",
      `--target=${target.bunTarget}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-package-json",
      "--no-compile-autoload-tsconfig",
      "--define", `__TERMINUS_CONTROL_BUILD_VERSION__=${JSON.stringify(version)}`,
      "--define", `__TERMINUS_CONTROL_BUILD_COMMIT__=${JSON.stringify(identity.commit)}`,
      "--define", `__TERMINUS_CONTROL_BUILD_TARGET__=${JSON.stringify(target.rustTarget)}`,
      "--define", `__TERMINUS_CONTROL_BUILD_SOURCE_CLEAN__=${identity.clean}`,
      `--outfile=${binary}`,
      join(ROOT, "scripts", "control-runtime", "entrypoint.ts"),
    ]);
    if (target.rustTarget.endsWith("-apple-darwin")) {
      if (process.platform !== "darwin") {
        throw new Error(`Darwin control runtime packaging requires macOS code signing: ${target.rustTarget}`);
      }
      // Bun appends its compiled payload after the Mach-O linker signature.
      // Replace that invalid signature with a deterministic ad-hoc signature;
      // desktop release packaging later replaces it with Developer ID signing.
      await run(["codesign", "--force", "--sign", "-", binary]);
      await run(["codesign", "--verify", "--strict", "--verbose=2", binary]);
      if (target.rustTarget === hostRustTarget()) {
        const runtimeIdentity = JSON.parse(await run([binary, "version"])) as Readonly<Record<string, unknown>>;
        if (
          runtimeIdentity.schema !== "terminus.control-runtime.identity.v1"
          || runtimeIdentity.version !== version
          || runtimeIdentity.candidate_commit !== identity.commit
          || runtimeIdentity.source_tree_clean !== identity.clean
          || runtimeIdentity.target !== target.rustTarget
        ) {
          throw new Error("compiled Darwin runtime identity does not match its package request");
        }
      }
    }
    await chmod(binary, 0o755);
    await cp(queryEngines[0]!, join(runtimeLibrary, "query-engine.node"));
    await cp(join(ROOT, "migrations", "sqlite"), join(share, "migrations", "sqlite"), { recursive: true });
    await cp(join(ROOT, "prisma", "schema.prisma"), join(share, "schema.prisma"));
    await cp(
      join(ROOT, "docs", "runbooks", "control-runtime-distribution.md"),
      join(share, "README.md"),
    );
    await mkdir(join(share, "licenses"), { recursive: true });
    await cp(join(ROOT, "LICENSE"), join(share, "licenses", "terminus.txt"));
    await cp(
      join(ROOT, "node_modules", "@prisma", "client", "LICENSE"),
      join(share, "licenses", "prisma-client.txt"),
    );

    const archiveInputs: ArchiveInput[] = [];
    const files: PackageFile[] = [];
    for (const path of await walkFiles(stage)) {
      const archivePath = `${ARCHIVE_ROOT}/${relative(stage, path).replaceAll("\\", "/")}`;
      const bytes = await readFile(path);
      const executable = path === binary;
      const mode = executable ? 0o755 : 0o644;
      files.push({
        path: archivePath.slice(ARCHIVE_ROOT.length + 1),
        sha256: sha256(bytes),
        size: bytes.byteLength,
        mode: executable ? "0755" : "0644",
      });
      archiveInputs.push({ path: archivePath, bytes, mode });
    }
    const prismaClientPackage = JSON.parse(
      await readFile(join(ROOT, "node_modules", "@prisma", "client", "package.json"), "utf8"),
    ) as { readonly version?: unknown };
    if (typeof prismaClientPackage.version !== "string") {
      throw new Error("installed @prisma/client has no version");
    }
    const manifest: ControlRuntimeManifest = {
      schema: "terminus.control-runtime.v1",
      version,
      candidate_commit: identity.commit,
      source_tree_clean: identity.clean,
      source_date_epoch: identity.epoch,
      target: {
        rust: target.rustTarget,
        bun: target.bunTarget,
        prisma: target.prismaTarget,
      },
      toolchain: {
        bun: Bun.version,
        prisma_client: prismaClientPackage.version,
      },
      entrypoint: `bin/${target.executableName}`,
      files,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    archiveInputs.push({
      path: `${ARCHIVE_ROOT}/manifest.json`,
      bytes: manifestBytes,
      mode: 0o644,
    });

    await mkdir(dirname(output), { recursive: true });
    const archiveSha256 = await writeDeterministicArchive(output, archiveInputs, identity.epoch);
    console.log(JSON.stringify({
      schema: "terminus.control-runtime.package-result.v1",
      artifact: output,
      sha256: archiveSha256,
      version,
      candidate_commit: identity.commit,
      source_tree_clean: identity.clean,
      target: target.rustTarget,
      files: files.length + 1,
    }));
  } finally {
    if (process.env.TERMINUS_KEEP_PACKAGE_TEMP !== "1") {
      await rm(temporary, { recursive: true, force: true });
    } else {
      console.error(`[control-runtime] preserved package staging directory: ${temporary}`);
    }
  }
}

await packageControlRuntime();
