/**
 * Issue #539: Claude Code running inside VS Code is misdetected as
 * vscode-copilot because Microsoft's `code` bootstrap exports VSCODE_PID
 * / VSCODE_CWD into every spawned child process — including a Claude Code
 * CLI launched from VS Code's integrated terminal.
 *
 * The classification table in `detect.ts` correctly lists `claude-code`
 * BEFORE `vscode-copilot` (line 37 vs line 63), but the only Claude Code
 * env-var markers were `CLAUDE_PROJECT_DIR` / `CLAUDE_SESSION_ID`. Neither
 * is set on every Claude Code boot (e.g., MCP server start before the hook
 * env hydrates). When those are absent and `VSCODE_PID` is present, detect
 * picks `vscode-copilot` and `getSettingsPath()` (copilot-base.ts:258)
 * writes `.github/hooks/context-mode.json` debris into the user's repo.
 *
 * Verified Claude-Code-set env vars (live `env` dump from a Claude Code
 * CLI process, 2026-05-11):
 *   CLAUDE_CODE_ENTRYPOINT=cli
 *   CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000
 *   CLAUDE_PLUGIN_DATA=/Users/.../plugins/data/<plugin>
 *   CLAUDE_PLUGIN_ROOT=/Users/.../plugins/cache/<plugin>/<version>
 *   CLAUDE_PROJECT_DIR=/Users/.../project
 *
 * `CLAUDE_CODE_ENTRYPOINT` is the most stable disambiguator — set on
 * every Claude Code session regardless of plugin/project state.
 * `CLAUDE_PLUGIN_ROOT` is set whenever Claude Code is running with a
 * plugin loaded (which is the case when context-mode itself is active).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectPlatform } from "../../src/adapters/detect.js";

describe("Issue #539 — Claude Code inside VS Code disambiguation", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Wipe every marker so each test starts from a clean slate.
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    delete process.env.VSCODE_PID;
    delete process.env.VSCODE_CWD;
    delete process.env.CONTEXT_MODE_PLATFORM;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns claude-code (NOT vscode-copilot) when VSCODE_PID set AND CLAUDE_CODE_ENTRYPOINT set", () => {
    // Reproduces issue #539: VS Code's integrated terminal exports
    // VSCODE_PID into the Claude Code CLI process; without this fix,
    // detect classified it as vscode-copilot and wrote .github/hooks/.
    process.env.VSCODE_PID = "12345";
    process.env.VSCODE_CWD = "/Users/me/project";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });

  it("returns claude-code when VSCODE_PID set AND CLAUDE_PLUGIN_ROOT set", () => {
    // CLAUDE_PLUGIN_ROOT is set when Claude Code runs with a plugin loaded
    // — context-mode is itself loaded as a Claude Code plugin so this var
    // is present whenever the issue manifests in practice.
    process.env.VSCODE_PID = "12345";
    process.env.CLAUDE_PLUGIN_ROOT =
      "/Users/me/.claude/plugins/cache/context-mode/context-mode/1.0.118";

    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("high");
  });
});
