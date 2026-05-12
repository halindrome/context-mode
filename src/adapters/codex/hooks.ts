/**
 * adapters/codex/hooks — Codex CLI hook definitions.
 *
 * Codex CLI hooks run behind the current `hooks` feature flag surface.
 * Prefer `[features].hooks`; the legacy `[features].codex_hooks` alias is still
 * accepted in current Codex builds.
 * 6 hook events: PreToolUse, PostToolUse, PreCompact, SessionStart,
 * UserPromptSubmit, Stop. PreCompact is runtime-gated on Codex builds that emit
 * the event.
 * Same JSON stdin/stdout wire protocol as Claude Code.
 *
 * Config: $CODEX_HOME/hooks.json or ~/.codex/hooks.json.
 * MCP: full support via [mcp_servers] in $CODEX_HOME/config.toml.
 *
 * Known limitations:
 *   - PreToolUse: deny works, updatedInput not yet supported (openai/codex#18491)
 *   - PostToolUse: updatedMCPToolOutput parsed but logged as unsupported
 *   - PostToolUse does not fire on failing Bash calls (upstream bug)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Codex CLI hook types — mirrors Claude Code's continuity events. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

// ─────────────────────────────────────────────────────────
// External MCP routing matcher (#529)
// ─────────────────────────────────────────────────────────

/**
 * Negative-lookahead matcher for external MCP tool namespaces on Codex CLI (#529).
 *
 * Codex CLI's hook `tool_name` payload uses `mcp__<server>__<tool>` for any
 * MCP-namespaced tool — verified by configs/codex/hooks.json which already
 * matches `mcp__.*__ctx_execute` style for context-mode's OWN MCP tools. This
 * pattern fires PreToolUse for any external `mcp__<server>__<tool>` whose
 * server segment does NOT contain `context-mode`. Without it, large payloads
 * from slack / telegram / gdrive / notion-style MCPs bypass the routing nudge
 * and flood the model's context — PostToolUse runs too late to keep raw data
 * out.
 *
 * The negative lookahead `(?!.*context-mode)` covers both naming variants
 * Codex sees in practice: the canonical `mcp__context-mode__ctx_*` AND the
 * Claude Code plugin shim `mcp__plugin_context-mode_context-mode__ctx_*`.
 * Codex own bare names (ctx_execute, local_shell, …) are not `mcp__`-prefixed
 * and are unaffected.
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__(?!.*context-mode)";

// ─────────────────────────────────────────────────────────
// Routing instructions
// ─────────────────────────────────────────────────────────

/**
 * Path to the routing instructions file for Codex CLI.
 * Used as fallback routing awareness alongside hook-based enforcement.
 */
export const ROUTING_INSTRUCTIONS_PATH = "configs/codex/AGENTS.md";
