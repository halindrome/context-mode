import "../setup-home";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * G3 — Post-build bundle invariant guardrail.
 *
 * Issue #511 class: esbuild rewrites bare `require("node:...")` calls into a
 * `__require` shim that throws `Dynamic require of "..." is not supported`
 * under Node ESM / Bun. The string `Dynamic require of` is the invariant
 * signature of the throwing shim and survives minification verbatim.
 *
 * `scripts/assert-bundle.mjs` is the post-build invariant check that fails
 * the build if any compiled bundle contains the throwing shim or pre-shim
 * source patterns that should never have reached the bundle.
 */

const SCRIPT = resolve(__dirname, "../../scripts/assert-bundle.mjs");

function runAssert(...files: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("node", [SCRIPT, ...files], { encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("assert-bundle script", () => {
  it("exits 1 when given a fixture bundle containing the 'Dynamic require of' shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "assert-bundle-red-"));
    const polluted = join(dir, "polluted.bundle.mjs");
    writeFileSync(
      polluted,
      `// fixture\nvar X=(t=>typeof require<"u"?require:e)(function(t){throw Error('Dynamic require of "'+t+'" is not supported')});\nexport {};\n`,
      "utf-8",
    );
    try {
      const r = runAssert(polluted);
      expect(r.status).toBe(1);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/Dynamic require of/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
