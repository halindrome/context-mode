/**
 * Issue #531 — asymmetric-drift invariant.
 *
 * Architectural guardrail that prevents the class of bug that caused #531.
 * The repo ships TWO sibling files that BOTH carry the MCP server args:
 *
 *   1. `.mcp.json`                            (Claude Code reads at plugin load)
 *   2. `.claude-plugin/plugin.json`           (used by some adapters / Cursor)
 *
 * v1.0.118 (#411) fixed `.mcp.json` to use `${CLAUDE_PLUGIN_ROOT}/start.mjs`.
 * v1.0.119 (#523) fixed `.claude-plugin/plugin.json` to use the same placeholder
 * AND added a self-heal sibling — but ONLY for plugin.json. Asymmetric coverage.
 *
 * Then commit aea633c (#253, 2026-04-13) regressed the `.mcp.json` source
 * template to bare `./start.mjs` — and there was no invariant to catch it.
 * Fresh marketplace installs broke (issue #531) for a full release cycle.
 *
 * This invariant locks in: the two sibling files MUST agree on args[0]. The
 * invariant runs in two layers:
 *
 *   A. Source-tree test (this file) — vitest sees both files have matching
 *      args[0] and they're the literal `${CLAUDE_PLUGIN_ROOT}/start.mjs`.
 *   B. Build-chain script (`scripts/assert-asymmetric-drift.mjs`) — same check,
 *      wired into `npm run build` so a future cli.ts/marketplace.json drift
 *      surfaces in CI before publish.
 *
 * Failure mode caught: any future commit that rewrites EITHER file's args[0]
 * without rewriting the other surfaces immediately — no more silent
 * regressions like #531.
 */

import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}/start.mjs";

interface McpJson {
  mcpServers?: Record<string, { args?: unknown[] }>;
}

function readArgs0(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpJson;
  const args = parsed.mcpServers?.[key]?.args;
  if (!Array.isArray(args) || args.length === 0) return null;
  const a0 = args[0];
  return typeof a0 === "string" ? a0 : null;
}

describe("Issue #531 — asymmetric-drift invariant", () => {
  test(".mcp.json args[0] is the ${CLAUDE_PLUGIN_ROOT}/start.mjs placeholder", () => {
    const got = readArgs0(resolve(ROOT, ".mcp.json"), "context-mode");
    expect(got, ".mcp.json missing or args[0] not a string").toBe(PLACEHOLDER);
  });

  test(".claude-plugin/plugin.json args[0] is the ${CLAUDE_PLUGIN_ROOT}/start.mjs placeholder", () => {
    const got = readArgs0(
      resolve(ROOT, ".claude-plugin", "plugin.json"),
      "context-mode",
    );
    expect(got, "plugin.json missing or args[0] not a string").toBe(PLACEHOLDER);
  });

  test(".mcp.json args[0] EQUALS .claude-plugin/plugin.json args[0] (drift guard)", () => {
    // This is the core architectural invariant. If either sibling drifts,
    // we fail loudly — preventing the silent class of bug that caused #531.
    const mcpArgs = readArgs0(resolve(ROOT, ".mcp.json"), "context-mode");
    const pluginArgs = readArgs0(
      resolve(ROOT, ".claude-plugin", "plugin.json"),
      "context-mode",
    );
    expect(mcpArgs).not.toBeNull();
    expect(pluginArgs).not.toBeNull();
    expect(mcpArgs).toBe(pluginArgs);
  });

  test("build-chain asserter script exists at scripts/assert-asymmetric-drift.mjs", () => {
    // The script is the same check, invocable from the build chain so future
    // regressions surface in CI before publish.
    expect(existsSync(resolve(ROOT, "scripts", "assert-asymmetric-drift.mjs"))).toBe(true);
  });

  test("build-chain asserter script exits 0 against the current source tree", () => {
    // End-to-end: run the script against the real repo. It MUST agree with
    // the in-process check (defence-in-depth). If this test fails, the
    // script and the source disagree — fix one or the other.
    const r = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts", "assert-asymmetric-drift.mjs")],
      { encoding: "utf-8", timeout: 10_000 },
    );
    expect(r.status, `asserter stderr: ${r.stderr}`).toBe(0);
  });

  test("build-chain asserter script exits non-zero when args[0] drifts", () => {
    // Drive the asserter with a temp scratch that intentionally drifts one
    // file. Use --root <path> to point it at the scratch dir.
    // (This documents the script's contract: it accepts --root.)
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");

    const scratch = mkdtempSync(join(tmpdir(), "asymmetric-drift-"));
    try {
      mkdirSync(join(scratch, ".claude-plugin"), { recursive: true });
      // mcp.json correct
      writeFileSync(
        join(scratch, ".mcp.json"),
        JSON.stringify({
          mcpServers: { "context-mode": { command: "node", args: [PLACEHOLDER] } },
        }),
      );
      // plugin.json DRIFTED — bare relative path (the #253 regression shape)
      writeFileSync(
        join(scratch, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "context-mode",
          mcpServers: { "context-mode": { command: "node", args: ["./start.mjs"] } },
        }),
      );
      const r = spawnSync(
        process.execPath,
        [resolve(ROOT, "scripts", "assert-asymmetric-drift.mjs"), "--root", scratch],
        { encoding: "utf-8", timeout: 10_000 },
      );
      expect(r.status, `asserter should fail on drift; stdout=${r.stdout}`).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/drift|mismatch|differ/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("build chain (package.json) wires assert-asymmetric-drift into npm run build", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    // Same wiring posture as assert-bundle: chained from `build`.
    expect(pkg.scripts.build, "build script must invoke assert-asymmetric-drift")
      .toMatch(/assert-asymmetric-drift|asymmetric-drift/);
  });
});
