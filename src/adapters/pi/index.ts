/**
 * adapters/pi — Pi Coding Agent platform adapter.
 *
 * Implements HookAdapter for Pi's MCP-only paradigm.
 *
 * Pi hook specifics:
 *   - NO HookAdapter parse/format pipeline. Pi's hook lifecycle
 *     (session_start, tool_call, tool_result, session_compact, ...) is
 *     handled directly by `src/adapters/pi/extension.ts` via the native
 *     `pi.on(...)` surface. From the MCP-server perspective — which is
 *     what `getAdapter()` routes — Pi is mcp-only.
 *   - Config: ~/.pi/mcp_config.json (JSON format)
 *   - MCP: full support via mcpServers in mcp_config.json
 *   - Session dir: ~/.pi/context-mode/sessions/
 *     Mirrors `src/adapters/pi/extension.ts:121-125` so the MCP-server path
 *     and the extension's own self-managed path resolve to the SAME directory.
 *   - Routing file: PI.md
 *
 * Why a dedicated adapter:
 *   Without `case "pi"` in `getAdapter()`'s switch, Pi sessions silently
 *   fell through to ClaudeCodeAdapter and were written to
 *   ~/.claude/context-mode/sessions/ instead of ~/.pi/context-mode/sessions/
 *   (issue #473 / B2 fix). This adapter restores the correct storage root
 *   so `_detectedAdapter.getSessionDir()` matches the extension's writes.
 *
 * Sources:
 *   - Pi extension: src/adapters/pi/extension.ts
 *   - clientInfo mapping: src/adapters/client-map.ts:25-26 ("Pi CLI" / "Pi Coding Agent")
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class PiAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".pi"]);
  }

  readonly name = "Pi Coding Agent";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
  };

  // ── Input parsing ──────────────────────────────────────
  // Pi's hook lifecycle is handled by extension.ts via pi.on(...).
  // These methods exist to satisfy the HookAdapter contract; they
  // throw if the MCP-server hook pipeline ever calls them by mistake.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("Pi extension manages its own hooks; HookAdapter parsers are not used");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("Pi extension manages its own hooks; HookAdapter parsers are not used");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("Pi extension manages its own hooks; HookAdapter parsers are not used");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("Pi extension manages its own hooks; HookAdapter parsers are not used");
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(_response: PreToolUseResponse): unknown {
    return undefined;
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): unknown {
    return undefined;
  }

  formatPreCompactResponse(_response: PreCompactResponse): unknown {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): unknown {
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".pi", "mcp_config.json");
  }

  getInstructionFiles(): string[] {
    return ["PI.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {};
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "warn",
        message:
          "Pi manages its own hook lifecycle via the extension API; " +
          "no JSON-stdio hook validation is required for the MCP-server path.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw);
      const mcpServers = (config as { mcpServers?: Record<string, unknown> })?.mcpServers ?? {};

      if ("context-mode" in mcpServers) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in mcpServers config",
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in mcpServers",
        fix: `Add context-mode to mcpServers in ${this.getSettingsPath()}`,
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: `Could not read ${this.getSettingsPath()}`,
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(homedir(), ".pi", "extensions", "context-mode", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "unknown";
    } catch {
      return "not installed";
    }
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    return [];
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Pi plugin registry is managed via mcp_config.json
  }

  getRoutingInstructions(): string {
    return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of bash/cat/curl for data-heavy operations.";
  }
}
