import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectExecution } from "../src/cli.js";

describe("isDirectExecution", () => {
  it("recognizes an installed CLI reached through a symlinked package path", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pausemesh-cli-test-"));

    try {
      const packageRoot = join(tempRoot, "package");
      const linkedPackageRoot = join(tempRoot, "linked-package");
      const cliPath = join(packageRoot, "dist", "cli.js");
      const linkedCliPath = join(linkedPackageRoot, "dist", "cli.js");
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(cliPath, "#!/usr/bin/env node\n");
      symlinkSync(
        packageRoot,
        linkedPackageRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(isDirectExecution(pathToFileURL(cliPath).href, linkedCliPath)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails closed when the entrypoint is absent or cannot be resolved", () => {
    const moduleUrl = import.meta.url;

    expect(isDirectExecution(moduleUrl, undefined)).toBe(false);
    expect(isDirectExecution(moduleUrl, join(tmpdir(), "missing-pausemesh-entrypoint"))).toBe(
      false,
    );
  });
});
