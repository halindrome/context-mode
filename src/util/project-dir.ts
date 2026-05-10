/**
 * Project-dir resolution helpers — shared between `start.mjs` (the MCP entry
 * point) and `src/server.ts getProjectDir()` (the consumer).
 *
 * Background: when Claude Code runs `/ctx-upgrade`, it kills + respawns the
 * MCP server. The respawn happens with `cwd` set to the plugin install
 * directory (`~/.claude/plugins/cache/context-mode/context-mode/<version>/`).
 * The legacy `start.mjs` then set `CLAUDE_PROJECT_DIR = originalCwd`, which
 * poisoned every downstream `ctx_stats` / SessionDB / hash computation —
 * sessions silently re-rooted under the plugin install path.
 *
 * Defense-in-depth fix (v1.0.113):
 *   - `start.mjs` calls `isPluginInstallPath(originalCwd)` and skips the env
 *     auto-set when true (no poisoning at the source).
 *   - `getProjectDir()` calls `resolveProjectDir(...)` which rejects plugin-
 *     pathed env vars and the plugin cwd, preferring `process.env.PWD`
 *     (shell-set, survives `process.chdir`) before falling back.
 */

/**
 * Detect whether a path lives inside the Claude Code plugin install tree —
 * specifically `<home>/.claude/plugins/cache/<plugin>/<plugin>/<version>/`
 * or the marketplace mirror `<home>/.claude/plugins/marketplaces/...`.
 *
 * Cross-OS: matches both POSIX (`/`) and Windows (`\`) path separators.
 * Independent of `home` location — we only care about the `.claude/plugins/`
 * suffix pattern.
 */
export function isPluginInstallPath(p: string): boolean {
  if (!p) return false;
  return /[/\\]\.claude[/\\]plugins[/\\](cache|marketplaces)[/\\]/.test(p);
}

/**
 * Pure project-dir resolver. Mirror of the env-var chain inside
 * `src/server.ts getProjectDir()`, but takes its inputs explicitly so the
 * resolver can be exercised under test without process-level mutation.
 *
 * Resolution order:
 *   1. Adapter-priority env vars (CLAUDE / GEMINI / VSCODE / OPENCODE / PI /
 *      IDEA / CONTEXT_MODE) — first non-empty AND non-plugin-path wins.
 *   2. `process.env.PWD` — shell-set, NOT updated by `process.chdir()`, so
 *      it survives the `start.mjs` chdir into the plugin dir. Skipped if
 *      it too points at a plugin install path.
 *   3. `cwd` — last resort. Returned even if it is a plugin path; the
 *      caller is responsible for rendering a graceful "no project context"
 *      message rather than panicking. Keeping the function total preserves
 *      operation of project-independent tools (sandbox execute, fetch).
 */
export function resolveProjectDir(opts: {
  env: Record<string, string | undefined>;
  cwd: string;
  pwd: string | undefined;
}): string {
  const { env, cwd, pwd } = opts;
  const candidates = [
    env.CLAUDE_PROJECT_DIR,
    env.GEMINI_PROJECT_DIR,
    env.VSCODE_CWD,
    env.OPENCODE_PROJECT_DIR,
    env.PI_PROJECT_DIR,
    env.IDEA_INITIAL_DIRECTORY,
    env.CONTEXT_MODE_PROJECT_DIR,
  ];
  for (const c of candidates) {
    if (c && !isPluginInstallPath(c)) return c;
  }
  if (pwd && !isPluginInstallPath(pwd)) return pwd;
  return cwd;
}
