#!/usr/bin/env node
// Issue #531 — asymmetric-drift invariant asserter.
//
// The repo ships TWO sibling files that BOTH carry the MCP server args:
//
//   1. `.mcp.json`                            (Claude Code reads at plugin load)
//   2. `.claude-plugin/plugin.json`           (used by some adapters / Cursor)
//
// If they drift, fresh installs break silently (Claude Code uses #1) while
// some adapter paths keep working (Cursor uses #2). That's how the #253
// commit's bare `./start.mjs` regression survived undetected for a full
// release cycle — there was no invariant.
//
// This script is the build-chain half of the slice-9 invariant pair.
// The vitest sibling (tests/scripts/asymmetric-drift-assert.test.ts) covers
// the source tree at test time; this script covers the build chain — wired
// into `npm run build` so any regression surfaces in CI before publish.
//
// Contract:
//   - Read `.mcp.json` and `.claude-plugin/plugin.json` from --root (or cwd).
//   - Extract mcpServers["context-mode"].args[0] from each.
//   - Assert both equal the literal `${CLAUDE_PLUGIN_ROOT}/start.mjs`.
//   - Assert the two values are equal (the explicit drift check).
//   - Exit 0 on success, 1 with a violations report on failure.
//
// Usage:
//   node scripts/assert-asymmetric-drift.mjs              # checks repo root
//   node scripts/assert-asymmetric-drift.mjs --root <dir> # checks <dir>

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}/start.mjs";
const PLUGIN_KEY = "context-mode";

function parseArgs(argv) {
  const out = { root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      out.root = argv[i + 1];
      i++;
    }
  }
  return out;
}

function readArgs0(filePath) {
  if (!existsSync(filePath)) return { ok: false, error: `missing: ${filePath}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    return { ok: false, error: `parse-failed (${filePath}): ${err && err.message}` };
  }
  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== "object") {
    return { ok: false, error: `no mcpServers in ${filePath}` };
  }
  const ours = servers[PLUGIN_KEY];
  if (!ours || typeof ours !== "object" || !Array.isArray(ours.args) || ours.args.length === 0) {
    return { ok: false, error: `no args[] for ${PLUGIN_KEY} in ${filePath}` };
  }
  const a0 = ours.args[0];
  if (typeof a0 !== "string") {
    return { ok: false, error: `args[0] not a string in ${filePath}` };
  }
  return { ok: true, value: a0 };
}

function main() {
  const { root: explicitRoot } = parseArgs(process.argv.slice(2));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = explicitRoot
    ? resolve(explicitRoot)
    : resolve(__dirname, "..");

  const mcpJsonPath = resolve(root, ".mcp.json");
  const pluginJsonPath = resolve(root, ".claude-plugin", "plugin.json");

  /** @type {string[]} */
  const violations = [];

  const mcp = readArgs0(mcpJsonPath);
  const plg = readArgs0(pluginJsonPath);

  if (!mcp.ok) violations.push(mcp.error);
  if (!plg.ok) violations.push(plg.error);

  if (mcp.ok && mcp.value !== PLACEHOLDER) {
    violations.push(
      `.mcp.json args[0] is "${mcp.value}" but must equal "${PLACEHOLDER}". ` +
        `Fresh marketplace installs spawn MCP with session CWD (not pluginRoot) so any other shape throws MODULE_NOT_FOUND. (Issue #531 / #253 class.)`,
    );
  }
  if (plg.ok && plg.value !== PLACEHOLDER) {
    violations.push(
      `.claude-plugin/plugin.json args[0] is "${plg.value}" but must equal "${PLACEHOLDER}". (Issue #523 class.)`,
    );
  }
  if (mcp.ok && plg.ok && mcp.value !== plg.value) {
    violations.push(
      `asymmetric drift: .mcp.json args[0]="${mcp.value}" vs .claude-plugin/plugin.json args[0]="${plg.value}". The two siblings MUST agree or Claude Code (reads .mcp.json) and adapters (read plugin.json) diverge on which start.mjs to spawn.`,
    );
  }

  if (violations.length > 0) {
    process.stderr.write("asymmetric-drift: FAIL\n");
    for (const v of violations) {
      process.stderr.write(`  - ${v}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `asymmetric-drift: OK (.mcp.json + .claude-plugin/plugin.json both pin args[0] to ${PLACEHOLDER})\n`,
  );
}

main();
