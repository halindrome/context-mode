/**
 * Claude Code config directory resolver — single source of truth.
 *
 * Issue #460 follow-up: every Claude-aware reader (adapters, security policy
 * loader, hook helpers) MUST agree on where global settings live. Hardcoding
 * `~/.claude` in any one reader silently breaks `CLAUDE_CONFIG_DIR` for that
 * code path, producing policy drift that is invisible until a user sets the
 * env var and watches their settings get ignored.
 *
 * Mirrors the contract of `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir`:
 *   - env unset or empty string → ~/.claude
 *   - env starts with `~`, `~/`, or `~\` → expanded against homedir()
 *   - otherwise → resolved to absolute (relative paths anchor to cwd)
 *
 * Cross-platform note: tilde regex strips a single leading `/` OR `\` so
 * `~\Users\foo` works on Windows. `path.resolve` handles drive-letter joining.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const envVal = env.CLAUDE_CONFIG_DIR;
  if (envVal) {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".claude");
}

/** Resolve the global settings.json path, honoring CLAUDE_CONFIG_DIR. */
export function resolveClaudeGlobalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(resolveClaudeConfigDir(env), "settings.json");
}
