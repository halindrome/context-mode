import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PiAdapter } from "../../src/adapters/pi/index.js";

describe("PiAdapter", () => {
  let adapter: PiAdapter;

  beforeEach(() => {
    adapter = new PiAdapter();
  });

  // ── Identity ───────────────────────────────────────────

  describe("identity", () => {
    it("name is Pi", () => {
      expect(adapter.name).toMatch(/Pi/i);
    });

    it("paradigm is mcp-only (Pi extension manages its own hook lifecycle)", () => {
      // Pi extension uses native pi.on(...) lifecycle handlers, not our
      // HookAdapter parse/format pipeline. From the MCP-server perspective
      // (which is what getAdapter() routes), Pi is mcp-only.
      expect(adapter.paradigm).toBe("mcp-only");
    });
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("all hook capabilities are false (Pi extension is self-managed)", () => {
      // The MCP-only adapter never invokes parsePreToolUseInput/etc.
      // Pi's extension.ts handles the lifecycle directly via the pi.on(...)
      // surface; this adapter exists purely so storage paths resolve under
      // ~/.pi instead of ~/.claude.
      expect(adapter.capabilities.preToolUse).toBe(false);
      expect(adapter.capabilities.postToolUse).toBe(false);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });
  });

  // ── Config paths — the BUG fix ────────────────────────
  // These paths MUST live under ~/.pi/, NEVER under ~/.claude/.
  // Mirrors omp.test.ts:127-146 — same family of issues (#473).

  describe("config paths", () => {
    it("session dir is under ~/.pi/context-mode/sessions/", () => {
      expect(adapter.getSessionDir()).toBe(
        join(homedir(), ".pi", "context-mode", "sessions"),
      );
    });

    it("session DB path contains project hash and lives under .pi", () => {
      const dbPath = adapter.getSessionDBPath("/test/project");
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".pi");
      expect(dbPath).not.toContain(".claude");
    });

    it("session events path contains project hash and lives under .pi", () => {
      const eventsPath = adapter.getSessionEventsPath("/test/project");
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".pi");
      expect(eventsPath).not.toContain(".claude");
    });

    it("settings path is ~/.pi/mcp_config.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".pi", "mcp_config.json"),
      );
    });

    it("config dir is ~/.pi", () => {
      expect(adapter.getConfigDir()).toBe(resolve(homedir(), ".pi"));
    });
  });

  // ── Instruction file ──────────────────────────────────

  describe("instruction files", () => {
    it("uses PI.md", () => {
      expect(adapter.getInstructionFiles()).toEqual(["PI.md"]);
    });
  });

  // ── Hook config (all empty — MCP-only) ────────────────

  describe("hook config", () => {
    it("generateHookConfig returns empty object", () => {
      expect(adapter.generateHookConfig("/some/plugin/root")).toEqual({});
    });

    it("configureAllHooks returns empty array", () => {
      expect(adapter.configureAllHooks("/some/plugin/root")).toEqual([]);
    });

    it("setHookPermissions returns empty array", () => {
      expect(adapter.setHookPermissions("/some/plugin/root")).toEqual([]);
    });
  });

  // ── Parse methods (all throw — MCP-only) ──────────────

  describe("parse methods", () => {
    it("parsePreToolUseInput throws", () => {
      expect(() => adapter.parsePreToolUseInput({})).toThrow(/Pi/);
    });

    it("parsePostToolUseInput throws", () => {
      expect(() => adapter.parsePostToolUseInput({})).toThrow(/Pi/);
    });
  });
});
