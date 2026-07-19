#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pausemesh-package-smoke-"));
const sourceRoot = join(tempRoot, "source");
const artifactsRoot = join(tempRoot, "artifacts");
const extractedRoot = join(tempRoot, "extracted");
const consumerRoot = join(tempRoot, "consumer");
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }

  return result.stdout;
}

function runPnpm(args, cwd) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (pnpmEntrypoint !== undefined && existsSync(pnpmEntrypoint)) {
    return run(process.execPath, [pnpmEntrypoint, ...args], cwd);
  }

  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return run(executable, args, cwd);
}

function assertPath(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Packed artifact is missing ${label}`);
  }
}

function copyWorktreeWithoutBuildArtifacts() {
  const listedFiles = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repoRoot,
  );

  for (const relativePath of listedFiles.split("\0").filter(Boolean)) {
    const sourcePath = join(repoRoot, relativePath);
    if (!existsSync(sourcePath)) continue;

    const destinationPath = join(sourceRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { recursive: true });
  }

  // The smoke must prove that prepack creates dist instead of reusing a local build.
  rmSync(join(sourceRoot, "dist"), { force: true, recursive: true });
}

function verifyPackedFiles(packageRoot) {
  const expectedPaths = [
    ["dist/index.js", "the ESM entry point"],
    ["dist/index.d.ts", "the public type declarations"],
    ["dist/postgres.js", "the optional PostgreSQL entry point"],
    ["dist/postgres.d.ts", "the optional PostgreSQL declarations"],
    ["dist/cli.js", "the CLI entry point"],
    ["docs/delivery-contract.md", "the linked delivery contract"],
    ["docs/adr", "the linked architecture decisions"],
    [".env.example", "the CLI configuration example"],
    ["README.md", "the README"],
    ["CHANGELOG.md", "the changelog"],
    ["LICENSE", "the license"],
    ["package.json", "the package manifest"],
  ];

  for (const [relativePath, label] of expectedPaths) {
    assertPath(join(packageRoot, relativePath), label);
  }

  if (existsSync(join(packageRoot, "src"))) {
    throw new Error("Packed artifact unexpectedly contains TypeScript sources");
  }

  for (const relativePath of ["dist/index.js.map"]) {
    const sourceMap = JSON.parse(readFileSync(join(packageRoot, relativePath), "utf8"));
    if (
      !Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sourcesContent.length === 0 ||
      sourceMap.sourcesContent.some((source) => typeof source !== "string")
    ) {
      throw new Error(`Packed ${relativePath} does not embed resolvable source content`);
    }
  }
  if (existsSync(join(packageRoot, "dist/index.d.ts.map"))) {
    throw new Error("Packed artifact unexpectedly contains a declaration map without sources");
  }
}

function verifyConsumerInstall(tarballPath) {
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "pausemesh-package-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  // Prefer the warmed CI store, but allow pnpm to fetch a missing registry tarball. Fresh Windows
  // runners can install a dependency into the workspace without retaining its source tarball in
  // the form required by strict offline mode.
  runPnpm(["add", "--prefer-offline", tarballPath], consumerRoot);

  const packageRoot = join(consumerRoot, "node_modules", "pausemesh");
  assertPath(packageRoot, "the installed pausemesh package");

  const smokeModule = join(consumerRoot, "smoke.mjs");
  writeFileSync(
    smokeModule,
    'import * as pausemesh from "pausemesh";\n' +
      'import * as postgres from "pausemesh/postgres";\n' +
      "const expected = [\n" +
      '  "ContinuationService", "SqliteEventStore", "issueMcpElicitation",\n' +
      '  "parseMcpElicitResult", "toMcpElicitRequest",\n' +
      '  "toMcpElicitationCompleteNotification",\n' +
      '  "toA2AInterruptedTask", "toA2AInputMessage",\n' +
      '  "toA2AAuthorizationControlMessage", "issueAguiInterrupts",\n' +
      '  "fromAguiRunAgentInput", "toAguiResumeEntry"\n' +
      "];\n" +
      "for (const name of expected) {\n" +
      '  if (typeof pausemesh[name] !== "function") {\n' +
      '    throw new Error("Package export " + name + " is unavailable");\n' +
      "  }\n" +
      "}\n" +
      'for (const name of ["PostgresEventStore", "migratePostgresEventStore"]) {\n' +
      '  if (typeof postgres[name] !== "function") {\n' +
      '    throw new Error("PostgreSQL package export " + name + " is unavailable");\n' +
      "  }\n" +
      "}\n" +
      "if (postgres.POSTGRES_EVENT_STORE_SCHEMA_VERSION !== 1) {\n" +
      '  throw new Error("PostgreSQL schema version export is unavailable");\n' +
      "}\n" +
      'if ("PostgresEventStore" in pausemesh) {\n' +
      '  throw new Error("Optional PostgreSQL adapter leaked into the root export");\n' +
      "}\n",
  );
  run(process.execPath, [smokeModule], consumerRoot);

  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const binTarget = manifest.bin?.pausemesh;
  if (typeof binTarget !== "string") {
    throw new Error("Packed manifest does not declare the pausemesh bin");
  }

  const binPath = resolve(packageRoot, binTarget);
  assertPath(binPath, "the declared pausemesh bin");
  if (!readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n")) {
    throw new Error("Packed pausemesh bin is missing its Node.js shebang");
  }
  const versionOutput = runPnpm(["exec", "pausemesh", "--version"], consumerRoot).trim();
  if (versionOutput !== manifest.version) {
    throw new Error(
      `Packed CLI reported ${versionOutput || "no version"}; expected ${manifest.version}`,
    );
  }
}

try {
  assertPath(join(repoRoot, "node_modules"), "installed dependencies; run pnpm install first");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  mkdirSync(extractedRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });

  copyWorktreeWithoutBuildArtifacts();
  symlinkSync(join(repoRoot, "node_modules"), join(sourceRoot, "node_modules"), directoryLinkType);
  runPnpm(["pack", "--pack-destination", artifactsRoot], sourceRoot);

  const tarballs = readdirSync(artifactsRoot).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one package tarball, found ${tarballs.length}`);
  }

  const tarballPath = join(artifactsRoot, tarballs[0]);
  run("tar", ["-xzf", tarballPath, "-C", extractedRoot], repoRoot);
  const packageRoot = join(extractedRoot, "package");
  verifyPackedFiles(packageRoot);
  verifyConsumerInstall(tarballPath);

  process.stdout.write(`Package smoke passed: ${tarballs[0]}\n`);
} finally {
  if (process.env.PAUSEMESH_KEEP_PACKAGE_SMOKE !== "1") {
    rmSync(tempRoot, { force: true, recursive: true });
  } else {
    process.stderr.write(`Package smoke workspace kept at ${tempRoot}\n`);
  }
}
