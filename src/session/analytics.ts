/**
 * AnalyticsEngine — Runtime savings + session continuity reporting.
 *
 * Computes context-window savings from runtime stats and queries
 * session continuity data from SessionDB.
 *
 * Usage:
 *   const engine = new AnalyticsEngine(sessionDb);
 *   const report = engine.queryAll(runtimeStats);
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadDatabase as loadDatabaseImpl } from "../db-base.js";

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}


// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Context savings result (#1) */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Think in code comparison result (#2) */
export interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

/** Tool-level savings result (#3) */
export interface ToolSavingsRow {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

/** Sandbox I/O result (#19) */
export interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

/** MCP tool usage row — concurrency stats for batch-style tools. */
export interface McpToolUsageRow {
  tool_name: string;
  calls: number;
  median_concurrency: number | null;
  max_concurrency: number | null;
}

/**
 * Conversation-scoped stats — aggregated from `session_events` for a single
 * `session_id` across every worktree DB plus the compact-rescue snapshot from
 * `session_resume`. Replaces the broken in-memory `tool_call_counter` that
 * only saw `ctx_*` MCP calls and reset to 0 every time the MCP server PID
 * changed (which is what made hours-of-work conversations show "1 call · 5 KB").
 */
export interface ConversationStats {
  /** session_id this aggregate covers (the current Claude Code conversation). */
  sessionId: string;
  /** Total event count for this session_id, summed across all DBs. */
  events: number;
  /** Distinct DB files this session_id appeared in (a rotation indicator). */
  dbCount: number;
  /** Wall-clock days from first to last event. Captures real activity length. */
  daysAlive: number;
  /** Bytes restored from the compact snapshot for this session_id. 0 if no compact. */
  snapshotBytes: number;
  /** Number of compact snapshots consumed for this session_id. */
  snapshotsConsumed: number;
  /** Category breakdown for this session_id. */
  byCategory: Array<{ category: string; count: number; label: string }>;
}

// ─────────────────────────────────────────────────────────
// Runtime stats — passed in from server.ts (can't come from DB)
// ─────────────────────────────────────────────────────────

/** Runtime stats tracked by server.ts during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheBytesSaved: number;
}

// ─────────────────────────────────────────────────────────
// FullReport — single unified object returned by queryAll()
// ─────────────────────────────────────────────────────────

/** Unified report combining runtime stats, DB analytics, and continuity data. */
export interface FullReport {
  /** Runtime context savings (passed in, not from DB) */
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  cache?: {
    hits: number;
    bytes_saved: number;
    ttl_hours_left: number;
    total_with_cache: number;
    total_savings_ratio: number;
  };
  /** Session metadata from SessionDB */
  session: {
    id: string;
    uptime_min: string;
  };
  /** Session continuity data */
  continuity: {
    total_events: number;
    by_category: Array<{
      category: string;
      count: number;
      label: string;
      preview: string;
      why: string;
    }>;
    compact_count: number;
    resume_ready: boolean;
  };
  /** Persistent project memory — all events across all sessions */
  projectMemory: {
    total_events: number;
    session_count: number;
    by_category: Array<{ category: string; count: number; label: string }>;
  };
}

// ─────────────────────────────────────────────────────────
// Category labels and hints for session continuity display
// ─────────────────────────────────────────────────────────

/**
 * Human-readable labels for event categories.
 *
 * Each label is a sentence-case phrase that reads like a benefit, not a
 * column name. The user shouldn't see raw schema words like "external-ref"
 * or "agent-finding" — those leak the database into the UX. When a new
 * category lands without an entry here, the renderer falls through to the
 * raw category id; that's a copy-debt signal, fix it here.
 */
export const categoryLabels: Record<string, string> = {
  // Code & filesystem
  file: "Files tracked",
  cwd: "Working directory",
  // Configuration & intent
  rule: "Project rules (CLAUDE.md)",
  prompt: "Your requests saved",
  intent: "Session goal",
  role: "Behavior rules",
  constraint: "Constraints you set",
  // Tools & delegation
  mcp: "MCP tools called",
  skill: "Skills used",
  subagent: "Delegated work",
  // Knowledge & decisions
  decision: "Your decisions",
  "agent-finding": "Agent insights kept",
  "rejected-approach": "Approaches you rejected",
  "external-ref": "External docs indexed",
  data: "Data references",
  // System events
  git: "Git operations",
  env: "Environment setup",
  task: "Tasks in progress",
  error: "Errors caught",
  // Continuity proof
  compact: "Compactions weathered",
  resume: "Sessions resumed cleanly",
  snapshot: "Snapshots restored",
  cache: "Cache hits saved",
  // Operational
  latency: "Slow tools recorded",
  "user-prompt": "Your messages remembered",
  plan: "Plans drafted",
  "blocked-on": "Blockers logged",
};

/** Explains why each category matters for continuity. */
export const categoryHints: Record<string, string> = {
  file: "Restored after compact — no need to re-read",
  rule: "Your project instructions survive context resets",
  prompt: "Continues exactly where you left off",
  decision: "Applied automatically — won’t ask again",
  task: "Picks up from where it stopped",
  error: "Tracked and monitored across compacts",
  git: "Branch, commit, and repo state preserved",
  env: "Runtime config carried forward",
  mcp: "Tool usage patterns remembered",
  subagent: "Delegation history preserved",
  skill: "Skill invocations tracked",
};

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  /**
   * Create an AnalyticsEngine.
   *
   * Accepts either a SessionDB instance (extracts internal db via
   * the protected getter — use the static fromDB helper for raw adapters)
   * or any object with a prepare() method for direct usage.
   */
  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 3 — Runtime (4 metrics, stubs)
  // ═══════════════════════════════════════════════════════

  /**
   * #1 Context Savings Total — bytes kept out of context window.
   *
   * Stub: requires server.ts to accumulate rawBytes and contextBytes
   * during a live session. Call with tracked values.
   */
  static contextSavingsTotal(rawBytes: number, contextBytes: number): ContextSavings {
    const savedBytes = rawBytes - contextBytes;
    const savedPercent = rawBytes > 0
      ? Math.round((savedBytes / rawBytes) * 1000) / 10
      : 0;
    return { rawBytes, contextBytes, savedBytes, savedPercent };
  }

  /**
   * #2 Think in Code Comparison — ratio of file size to sandbox output size.
   *
   * Stub: requires server.ts tracking of execute/execute_file calls.
   */
  static thinkInCodeComparison(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
    const ratio = outputBytes > 0
      ? Math.round((fileBytes / outputBytes) * 10) / 10
      : 0;
    return { fileBytes, outputBytes, ratio };
  }

  /**
   * #3 Tool Savings — per-tool breakdown of context savings.
   *
   * Stub: requires per-tool accumulators in server.ts.
   */
  static toolSavings(
    tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>,
  ): ToolSavingsRow[] {
    return tools.map((t) => ({
      ...t,
      savedBytes: t.rawBytes - t.contextBytes,
    }));
  }

  /**
   * #19 Sandbox I/O — total input/output bytes processed by the sandbox.
   *
   * Stub: requires PolyglotExecutor byte counters.
   */
  static sandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
    return { inputBytes, outputBytes };
  }

  /**
   * MCP tool usage — call counts and concurrency stats per MCP tool.
   *
   * Reads `mcp_tool_call` events, parses the JSON payload, and aggregates:
   *  - call count per tool_name
   *  - median + max of `params.concurrency` (only for tools that take it,
   *    e.g. ctx_batch_execute, ctx_fetch_and_index). Returns null when the
   *    tool doesn't carry a concurrency param so callers can render N/A.
   *
   * Best-effort: malformed rows or truncated payloads are skipped silently.
   */
  getMcpToolUsage(): McpToolUsageRow[] {
    let rows: Array<{ data: string }>;
    try {
      rows = this.db.prepare(
        "SELECT data FROM session_events WHERE category = 'mcp_tool_call'",
      ).all() as Array<{ data: string }>;
    } catch {
      return [];
    }

    // toolName -> { calls, concurrencies }
    const agg = new Map<string, { calls: number; concurrencies: number[] }>();

    for (const row of rows) {
      let parsed: { tool_name?: unknown; params?: unknown; truncated?: unknown };
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : null;
      if (!toolName) continue;

      const bucket = agg.get(toolName) ?? { calls: 0, concurrencies: [] };
      bucket.calls += 1;

      // Skip concurrency extraction when the row was truncated — the params
      // blob is a substring of JSON that may not parse cleanly.
      if (parsed.truncated !== true && parsed.params && typeof parsed.params === "object") {
        const c = (parsed.params as Record<string, unknown>).concurrency;
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
          bucket.concurrencies.push(c);
        }
      }

      agg.set(toolName, bucket);
    }

    const out: McpToolUsageRow[] = [];
    for (const [tool_name, b] of agg) {
      let median: number | null = null;
      let max: number | null = null;
      if (b.concurrencies.length > 0) {
        const sorted = [...b.concurrencies].sort((a, c) => a - c);
        const mid = Math.floor(sorted.length / 2);
        median = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        max = sorted[sorted.length - 1];
      }
      out.push({
        tool_name,
        calls: b.calls,
        median_concurrency: median,
        max_concurrency: max,
      });
    }

    // Stable sort: most-called first, then alphabetical
    out.sort((a, c) => c.calls - a.calls || a.tool_name.localeCompare(c.tool_name));
    return out;
  }

  // ═══════════════════════════════════════════════════════
  // queryAll — single unified report from ONE source
  // ═══════════════════════════════════════════════════════

  /**
   * Build a FullReport by merging runtime stats (passed in)
   * with continuity data from the DB.
   *
   * This is the ONE call that ctx_stats should use.
   */
  queryAll(runtimeStats: RuntimeStats): FullReport {
    // ── Resolve latest session ID ──
    const latestSession = this.db.prepare(
      "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { session_id: string } | undefined;
    const sid = latestSession?.session_id ?? "";

    // ── Runtime savings ──
    const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce(
      (sum, b) => sum + b, 0,
    );
    const totalCalls = Object.values(runtimeStats.calls).reduce(
      (sum, c) => sum + c, 0,
    );
    const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0
      ? Math.round((1 - totalBytesReturned / totalProcessed) * 100)
      : 0;

    const toolNames = new Set([
      ...Object.keys(runtimeStats.calls),
      ...Object.keys(runtimeStats.bytesReturned),
    ]);
    const byTool = Array.from(toolNames).sort().map((tool) => ({
      tool,
      calls: runtimeStats.calls[tool] || 0,
      context_kb: Math.round((runtimeStats.bytesReturned[tool] || 0) / 1024 * 10) / 10,
      tokens: Math.round((runtimeStats.bytesReturned[tool] || 0) / 4),
    }));

    const uptimeMs = Date.now() - runtimeStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // ── Cache ──
    let cache: FullReport["cache"];
    if (runtimeStats.cacheHits > 0 || runtimeStats.cacheBytesSaved > 0) {
      const totalWithCache = totalProcessed + runtimeStats.cacheBytesSaved;
      const totalSavingsRatio = totalWithCache / Math.max(totalBytesReturned, 1);
      const ttlHoursLeft = Math.max(0, 24 - Math.floor((Date.now() - runtimeStats.sessionStart) / (60 * 60 * 1000)));
      cache = {
        hits: runtimeStats.cacheHits,
        bytes_saved: runtimeStats.cacheBytesSaved,
        ttl_hours_left: ttlHoursLeft,
        total_with_cache: totalWithCache,
        total_savings_ratio: totalSavingsRatio,
      };
    }

    // ── Continuity data (scoped to current session) ──
    const eventTotal = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?",
    ).get(sid) as { cnt: number }).cnt;

    const byCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events WHERE session_id = ? GROUP BY category ORDER BY cnt DESC",
    ).all(sid) as Array<{ category: string; cnt: number }>;

    const meta = this.db.prepare(
      "SELECT compact_count FROM session_meta WHERE session_id = ?",
    ).get(sid) as { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db.prepare(
      "SELECT event_count, consumed FROM session_resume WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sid) as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // Build category previews (current session only)
    const previewRows = this.db.prepare(
      "SELECT category, type, data FROM session_events WHERE session_id = ? ORDER BY id DESC",
    ).all(sid) as Array<{ category: string; type: string; data: string }>;

    const previews = new Map<string, Set<string>>();
    for (const row of previewRows) {
      if (!previews.has(row.category)) previews.set(row.category, new Set());
      const set = previews.get(row.category)!;
      if (set.size < 5) {
        let display = row.data;
        if (row.category === "file") {
          display = row.data.split("/").pop() || row.data;
        } else if (row.category === "prompt" || row.category === "user-prompt") {
          display = display.length > 50 ? display.slice(0, 47) + "..." : display;
        }
        if (display.length > 40) display = display.slice(0, 37) + "...";
        set.add(display);
      }
    }

    const continuityByCategory = byCategory.map((row) => ({
      category: row.category,
      count: row.cnt,
      label: categoryLabels[row.category] || row.category,
      preview: previews.get(row.category)
        ? Array.from(previews.get(row.category)!).join(", ")
        : "",
      why: categoryHints[row.category] || "Survives context resets",
    }));

    // ── Project-wide persistent memory (all sessions, no session_id filter) ──
    const projectTotals = this.db.prepare(
      "SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions FROM session_events",
    ).get() as { cnt: number; sessions: number };

    const projectByCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
    ).all() as Array<{ category: string; cnt: number }>;

    const projectMemoryByCategory = projectByCategory
      .filter((row) => row.cnt > 0)
      .map((row) => ({
        category: row.category,
        count: row.cnt,
        label: categoryLabels[row.category] || row.category,
      }));

    return {
      savings: {
        processed_kb: Math.round(totalProcessed / 1024 * 10) / 10,
        entered_kb: Math.round(totalBytesReturned / 1024 * 10) / 10,
        saved_kb: Math.round(keptOut / 1024 * 10) / 10,
        pct: reductionPct,
        savings_ratio: Math.round(savingsRatio * 10) / 10,
        by_tool: byTool,
        total_calls: totalCalls,
        total_bytes_returned: totalBytesReturned,
        kept_out: keptOut,
        total_processed: totalProcessed,
      },
      cache,
      session: {
        id: sid,
        uptime_min: uptimeMin,
      },
      continuity: {
        total_events: eventTotal,
        by_category: continuityByCategory,
        compact_count: compactCount,
        resume_ready: resumeReady,
      },
      projectMemory: {
        total_events: projectTotals.cnt,
        session_count: projectTotals.sessions,
        by_category: projectMemoryByCategory,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// Adapter dir enumeration (B3a multi-adapter aggregation)
// ─────────────────────────────────────────────────────────

/**
 * Where one adapter stores its context-mode sidecars on disk. Mirrors the
 * map in `src/adapters/detect.ts:92-111` (`getSessionDirSegments`) so we
 * never go out of sync as a single source of truth.
 *
 * `sessionsDir` = `<home>/<segments>/context-mode/sessions`
 * `contentDir`  = `<home>/<segments>/context-mode/content`
 *
 * Why duplicated here: `getSessionDirSegments` returns segments relative to
 * `homedir()`; analytics needs the absolute joined paths for both `sessions`
 * and `content` siblings. Keeping a parallel hard-coded list avoids importing
 * detect.ts (which pulls in adapter loaders) into the stats path.
 */
export interface AdapterDirEntry {
  /** Adapter id matching `src/adapters/detect.ts` PlatformId. */
  name: string;
  /** Absolute path to `<home>/<segments>/context-mode/sessions`. */
  sessionsDir: string;
  /** Absolute path to `<home>/<segments>/context-mode/content`. */
  contentDir: string;
}

/**
 * Enumerate every known adapter's sessions + content dirs under `home`.
 * Used by `getMultiAdapterLifetimeStats` and `getMultiAdapterRealBytesStats`
 * so a single call surfaces "your work everywhere on this machine across
 * all AI tools" (the marketing line).
 *
 * Returns ALL 15 adapters even when the dir doesn't exist on disk — the
 * scanner functions filter to existing dirs. That keeps the enumeration
 * pure / testable without filesystem dependencies.
 */
export function enumerateAdapterDirs(opts?: { home?: string }): AdapterDirEntry[] {
  const home = opts?.home ?? homedir();
  // Mirrors `getSessionDirSegments` in src/adapters/detect.ts:92-111.
  const map: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["claude-code",      [".claude"]],
    ["gemini-cli",       [".gemini"]],
    ["antigravity",      [".gemini"]],
    ["openclaw",         [".openclaw"]],
    ["codex",            [".codex"]],
    ["cursor",           [".cursor"]],
    ["vscode-copilot",   [".vscode"]],
    ["kiro",             [".kiro"]],
    ["pi",               [".pi"]],
    ["omp",              [".omp"]],
    ["qwen-code",        [".qwen"]],
    ["kilo",             [".config", "kilo"]],
    ["opencode",         [".config", "opencode"]],
    ["zed",              [".config", "zed"]],
    ["jetbrains-copilot", [".config", "JetBrains"]],
  ];
  return map.map(([name, segments]) => {
    const base = join(home, ...segments, "context-mode");
    return {
      name,
      sessionsDir: join(base, "sessions"),
      contentDir: join(base, "content"),
    };
  });
}

// ─────────────────────────────────────────────────────────
// Lifetime stats (Bug #3 + #4)
// ─────────────────────────────────────────────────────────

/** Aggregated stats spanning every SessionDB + auto-memory under the user's profile. */
export interface LifetimeStats {
  totalEvents: number;
  totalSessions: number;
  autoMemoryCount: number;
  autoMemoryProjects: number;
  /** Per-prefix breakdown of auto-memory files (user/feedback/project/...). */
  autoMemoryByPrefix: Record<string, number>;
  /**
   * Per-category event counts aggregated across every SessionDB on disk.
   * Keys are the raw category strings (file/cwd/rule/...) — the renderer
   * looks them up against `categoryLabels` for display. Empty `{}` when no
   * sidecar has any events. Optional for back-compat with older fixtures.
   */
  categoryCounts: Record<string, number>;
  /**
   * Total bytes restored from compact-rescue snapshots across every DB on
   * disk. Adds the rescue benefit to lifetime $ so the headline isn't
   * silently undercounting the killer feature. 0 when no compact has fired
   * or older fixtures don't pass this. Optional for back-compat with tests.
   */
  rescueBytes?: number;
  /**
   * Earliest event timestamp (ms epoch) across every DB. Used for the
   * "since 2026-04-14" lifetime narrative. 0 when unknown. Optional.
   */
  firstEventMs?: number;
  /**
   * Distinct project_dir count across every DB. Different from
   * `autoMemoryProjects` (which only counts dirs with auto-memory files).
   * Captures every cwd context-mode has ever seen events for. Optional.
   */
  distinctProjects?: number;
}

/** Extract leading prefix from auto-memory filename: `feedback_push.md` → `feedback`. */
function autoMemoryPrefix(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const m = base.match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : "other";
}

/**
 * Aggregate lifetime stats from all SessionDB files in `sessionsDir` and
 * all auto-memory markdown files under `memoryRoot/<project>/memory/`.
 *
 * Best-effort: silently ignores missing/unreadable files so ctx_stats
 * can never be broken by a corrupt sidecar.
 */
export function getLifetimeStats(opts?: {
  sessionsDir?: string;
  memoryRoot?: string;
  /** Override for tests — defaults to db-base loadDatabase(). */
  loadDatabase?: () => unknown;
}): LifetimeStats {
  const sessionsDir = opts?.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  const memoryRoot = opts?.memoryRoot
    ?? join(homedir(), ".claude", "projects");

  let totalEvents = 0;
  let totalSessions = 0;
  let rescueBytes = 0;
  let firstEventMs = Number.POSITIVE_INFINITY;
  const distinctProjectsSet = new Set<string>();
  const categoryCounts: Record<string, number> = {};

  // ── SessionDB aggregation ──
  if (existsSync(sessionsDir)) {
    let dbFiles: string[] = [];
    try {
      dbFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".db"));
    } catch { /* unreadable */ }

    if (dbFiles.length > 0) {
      // Lazy-load better-sqlite3 / bun-sqlite via the same path the runtime uses.
      let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
      try {
        DatabaseCtor = opts?.loadDatabase
          ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
          : loadDatabaseImpl();
      } catch { /* sqlite unavailable */ }

      if (DatabaseCtor) {
        for (const file of dbFiles) {
          const dbPath = join(sessionsDir, file);
          try {
            const sdb = new DatabaseCtor(dbPath, { readonly: true });
            try {
              const ev = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_events").get() as { cnt: number } | undefined;
              const ss = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_meta").get() as { cnt: number } | undefined;
              totalEvents += ev?.cnt ?? 0;
              totalSessions += ss?.cnt ?? 0;
              // Per-category aggregation across every sidecar so the
              // Persistent memory bars stay populated even when the
              // current project's local DB is fresh / empty.
              try {
                const catRows = sdb.prepare(
                  "SELECT category, COUNT(*) AS cnt FROM session_events GROUP BY category",
                ).all() as Array<{ category: string; cnt: number }>;
                for (const row of catRows) {
                  if (!row.category) continue;
                  categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + (row.cnt ?? 0);
                }
              } catch {
                // older schema / no category column — ignore
              }
              // Lifetime rescue: compact-snapshot bytes restored across every DB.
              // Without this, the lifetime $ silently undercounts the killer
              // continuity-after-/compact feature.
              try {
                const snap = sdb.prepare(
                  "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1",
                ).get() as { bytes: number } | undefined;
                if (snap?.bytes) rescueBytes += snap.bytes;
              } catch { /* old schema */ }
              // Earliest event timestamp + distinct project_dirs for the
              // "since X · Y projects" lifetime narrative.
              try {
                const mn = sdb.prepare(
                  "SELECT MIN(created_at) AS t FROM session_events",
                ).get() as { t: string | null } | undefined;
                if (mn?.t) {
                  const stamp = mn.t.endsWith("Z") ? mn.t : mn.t + "Z";
                  const ms = Date.parse(stamp);
                  if (Number.isFinite(ms) && ms < firstEventMs) firstEventMs = ms;
                }
              } catch { /* old schema */ }
              try {
                const projRows = sdb.prepare(
                  "SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''",
                ).all() as Array<{ p: string }>;
                for (const row of projRows) if (row.p) distinctProjectsSet.add(row.p);
              } catch { /* old schema */ }
            } finally {
              sdb.close();
            }
          } catch {
            // missing tables / corrupt file — skip
          }
        }
      }
    }
  }

  // ── Auto-memory file scan ──
  let autoMemoryCount = 0;
  let autoMemoryProjects = 0;
  const autoMemoryByPrefix: Record<string, number> = {};

  if (existsSync(memoryRoot)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(memoryRoot).filter((entry) => {
        try {
          return statSync(join(memoryRoot, entry)).isDirectory();
        } catch { return false; }
      });
    } catch { /* unreadable */ }

    for (const proj of projectDirs) {
      const memDir = join(memoryRoot, proj, "memory");
      if (!existsSync(memDir)) continue;
      let mdFiles: string[] = [];
      try {
        mdFiles = readdirSync(memDir).filter((f) => f.endsWith(".md"));
      } catch { continue; }
      if (mdFiles.length === 0) continue;
      autoMemoryProjects++;
      autoMemoryCount += mdFiles.length;
      for (const f of mdFiles) {
        const prefix = autoMemoryPrefix(f);
        autoMemoryByPrefix[prefix] = (autoMemoryByPrefix[prefix] ?? 0) + 1;
      }
    }
  }

  return {
    totalEvents,
    totalSessions,
    autoMemoryCount,
    autoMemoryProjects,
    autoMemoryByPrefix,
    categoryCounts,
    rescueBytes,
    firstEventMs: Number.isFinite(firstEventMs) ? firstEventMs : 0,
    distinctProjects: distinctProjectsSet.size,
  };
}

/**
 * Aggregate every event for one `session_id` across all SessionDB files in
 * `sessionsDir` plus the compact-rescue snapshot bytes from `session_resume`.
 *
 * Why this exists: the Claude Code session_id can persist across days while
 * the underlying DB file rotates (size cap), and a compact-rescue snapshot
 * carries hundreds of KB of context that would otherwise have been lost. The
 * old in-memory `tool_call_counter` saw none of this — it counted only `ctx_*`
 * MCP calls against the current MCP server PID and reset on every restart.
 * Reading from `session_events` + `session_resume` is the source-of-truth
 * version that matches what users actually experienced.
 */
export function getConversationStats(opts: {
  sessionId: string;
  sessionsDir?: string;
  /** Optional worktree filename prefix (sha256(cwd)[:16]). When omitted, scans every DB. */
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): ConversationStats {
  const sessionsDir = opts.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  const sessionId = opts.sessionId;

  const empty: ConversationStats = {
    sessionId,
    events: 0,
    dbCount: 0,
    daysAlive: 0,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [],
  };
  if (!sessionId || !existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch { return empty; }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return empty; }
  if (!DatabaseCtor) return empty;

  const catCounts: Record<string, number> = {};
  let events = 0;
  let dbCount = 0;
  let snapshotBytes = 0;
  let snapshotsConsumed = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;

  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    let touched = false;
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const cats = sdb.prepare(
          "SELECT category, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY category",
        ).all(sessionId) as Array<{ category: string; cnt: number }>;
        for (const row of cats) {
          if (!row.category) continue;
          catCounts[row.category] = (catCounts[row.category] ?? 0) + (row.cnt ?? 0);
          events += row.cnt ?? 0;
          touched = true;
        }
        const range = sdb.prepare(
          "SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events WHERE session_id = ?",
        ).get(sessionId) as { mn: string | null; mx: string | null } | undefined;
        if (range?.mn) {
          const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
          if (Number.isFinite(t) && t < firstMs) firstMs = t;
        }
        if (range?.mx) {
          const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
          if (Number.isFinite(t) && t > lastMs) lastMs = t;
        }
        try {
          const snap = sdb.prepare(
            "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes, COUNT(*) AS n FROM session_resume WHERE session_id = ? AND consumed = 1",
          ).get(sessionId) as { bytes: number; n: number } | undefined;
          if (snap?.bytes) snapshotBytes += snap.bytes;
          if (snap?.n) snapshotsConsumed += snap.n;
        } catch { /* old schema */ }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt */ }
    if (touched) dbCount++;
  }

  const daysAlive = firstMs < lastMs ? (lastMs - firstMs) / 86_400_000 : 0;
  const byCategory = Object.entries(catCounts)
    .filter(([, n]) => n > 0)
    .map(([category, count]) => ({
      category,
      count,
      label: categoryLabels[category] || category,
    }))
    .sort((a, b) => b.count - a.count);

  return { sessionId, events, dbCount, daysAlive, snapshotBytes, snapshotsConsumed, byCategory };
}

// ─────────────────────────────────────────────────────────
// getRealBytesStats — Phase 8 of D2 PRD (stats-event-driven-architecture)
// ─────────────────────────────────────────────────────────

/**
 * Real-bytes counter the renderer uses to replace the conservative
 * `events × 256` token estimate. Reads four sources from disk and
 * returns the sum the renderer divides by 4 to get tokens.
 *
 * - `eventDataBytes`  = SUM(LENGTH(data))      FROM session_events
 * - `bytesAvoided`    = SUM(bytes_avoided)     FROM session_events
 * - `bytesReturned`   = SUM(bytes_returned)    FROM session_events
 * - `snapshotBytes`   = SUM(LENGTH(snapshot))  FROM session_resume
 * - `totalSavedTokens` = (eventDataBytes + bytesAvoided + snapshotBytes) / 4
 *
 * `bytesReturned` is reported but NOT folded into `totalSavedTokens`
 * because it represents bytes the model already paid for — adding it
 * would double-count what's already on the user's invoice.
 */
export interface RealBytesStats {
  eventDataBytes: number;
  bytesAvoided: number;
  bytesReturned: number;
  snapshotBytes: number;
  totalSavedTokens: number;
}

/**
 * Compute real-bytes stats across one session, one project (worktree
 * filter), or every session on disk (lifetime).
 *
 * - Pass `sessionId` for the conversation tier.
 * - Pass `worktreeHash` to filter `*.db` files by name prefix
 *   (per-project lifetime — `sha256(cwd).slice(0, 16)`).
 * - Pass neither — full lifetime aggregate.
 *
 * Best-effort: returns zeroes when the dir is missing, the DB is
 * corrupt, or the session has no events. Never throws — same
 * contract as `getConversationStats` / `getLifetimeStats` so the
 * stats-render path can never crash on a bad sidecar.
 */
export function getRealBytesStats(opts: {
  sessionId?: string;
  sessionsDir?: string;
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): RealBytesStats {
  const empty: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    totalSavedTokens: 0,
  };

  const sessionsDir = opts.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  if (!existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch { return empty; }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return empty; }
  if (!DatabaseCtor) return empty;

  let eventDataBytes = 0;
  let bytesAvoided = 0;
  let bytesReturned = 0;
  let snapshotBytes = 0;

  // Each branch returns the tuple in the SAME column order so callers
  // don't need to type-narrow per row.
  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        if (opts.sessionId) {
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events WHERE session_id = ?`,
          ).get(opts.sessionId) as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume WHERE session_id = ?",
            ).get(opts.sessionId) as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
        } else {
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events`,
          ).get() as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume",
            ).get() as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
        }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt — skip */ }
  }

  const totalSavedTokens = Math.floor(
    (eventDataBytes + bytesAvoided + snapshotBytes) / 4,
  );

  return { eventDataBytes, bytesAvoided, bytesReturned, snapshotBytes, totalSavedTokens };
}

// ─────────────────────────────────────────────────────────
// Multi-adapter aggregation (B3a — "your work everywhere")
// ─────────────────────────────────────────────────────────

/**
 * Real-usage filter thresholds. Decided in the B3a /diagnose conversation
 * to suppress fixture-noise dirs (test runs that touched ~/.X but never
 * carried real user work).
 *
 * An adapter is `isReal=true` iff ALL four hold:
 *   eventCount     >= 100
 *   distinctProjects >= 5
 *   lastActivity within 30 days
 *   avgEventBytes  >= 50
 *
 * Tuneable via `getMultiAdapterLifetimeStats({ filter })` for testing.
 */
export interface RealUsageFilter {
  minEvents?: number;
  minProjects?: number;
  recencyMs?: number;
  minAvgBytes?: number;
  /** Fixed "now" timestamp for deterministic testing. Defaults to Date.now(). */
  nowMs?: number;
}

const DEFAULT_REAL_USAGE_FILTER: Required<Omit<RealUsageFilter, "nowMs">> = {
  minEvents: 100,
  minProjects: 5,
  recencyMs: 30 * 86_400_000,
  minAvgBytes: 50,
};

/** Per-adapter scan result returned by {@link scanOneAdapter}. */
export interface AdapterScanResult {
  /** Adapter id (matches `enumerateAdapterDirs().name`). */
  name: string;
  /** Total event rows across every `*.db` in this adapter's sessions dir. */
  eventCount: number;
  /** Total distinct session_meta rows across every db. */
  sessionCount: number;
  /** Sum of LENGTH(data) across every session_event row. */
  dataBytes: number;
  /** Sum of LENGTH(snapshot) across consumed compact-rescue snapshots. */
  rescueBytes: number;
  /** Reserved for future content/ scan (B3b). 0 today. */
  contentBytes: number;
  /** Distinct session_id count across all dbs (alias of sessionCount). */
  uuidConvs: number;
  /** Distinct project_dir values across all session_events. */
  projectDirs: string[];
  /** Earliest event ms epoch (Number.POSITIVE_INFINITY when no events). */
  firstMs: number;
  /** Latest event ms epoch (0 when no events). */
  lastMs: number;
  /** Real-usage flag — see {@link RealUsageFilter}. */
  isReal: boolean;
}

/**
 * Scan one adapter's sessions dir. Always returns a result — never throws.
 * When the dir is missing, the result has zeroed counts and `isReal=false`.
 *
 * Mirrors the inner SessionDB-walk inside `getLifetimeStats`
 * (analytics.ts:677-752) so the new multi-adapter path stays in lock-step
 * with the per-DB queries the single-dir path already trusts.
 */
function scanOneAdapter(
  entry: AdapterDirEntry,
  loadDb: () => unknown,
  filter: Required<Omit<RealUsageFilter, "nowMs">> & { nowMs: number },
): AdapterScanResult {
  const result: AdapterScanResult = {
    name: entry.name,
    eventCount: 0,
    sessionCount: 0,
    dataBytes: 0,
    rescueBytes: 0,
    contentBytes: 0,
    uuidConvs: 0,
    projectDirs: [],
    firstMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    isReal: false,
  };
  if (!existsSync(entry.sessionsDir)) return result;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(entry.sessionsDir).filter((f) => f.endsWith(".db"));
  } catch { return result; }
  if (dbFiles.length === 0) return result;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = loadDb() as ReturnType<typeof loadDatabaseImpl>;
  } catch { return result; }
  if (!DatabaseCtor) return result;

  const projectsSet = new Set<string>();
  const sessionsSet = new Set<string>();

  for (const file of dbFiles) {
    const dbPath = join(entry.sessionsDir, file);
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const ev = sdb.prepare(
          "SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM session_events",
        ).get() as { cnt: number; bytes: number } | undefined;
        if (ev) {
          result.eventCount += Number(ev.cnt ?? 0);
          result.dataBytes  += Number(ev.bytes ?? 0);
        }
        try {
          const ss = sdb.prepare(
            "SELECT COUNT(*) AS cnt FROM session_meta",
          ).get() as { cnt: number } | undefined;
          result.sessionCount += Number(ss?.cnt ?? 0);
        } catch { /* old schema */ }
        try {
          const snap = sdb.prepare(
            "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1",
          ).get() as { bytes: number } | undefined;
          if (snap?.bytes) result.rescueBytes += Number(snap.bytes);
        } catch { /* old schema */ }
        try {
          const range = sdb.prepare(
            "SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events",
          ).get() as { mn: string | null; mx: string | null } | undefined;
          if (range?.mn) {
            const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t < result.firstMs) result.firstMs = t;
          }
          if (range?.mx) {
            const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t > result.lastMs) result.lastMs = t;
          }
        } catch { /* old schema */ }
        try {
          const projRows = sdb.prepare(
            "SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''",
          ).all() as Array<{ p: string }>;
          for (const row of projRows) if (row.p) projectsSet.add(row.p);
        } catch { /* old schema */ }
        try {
          const sidRows = sdb.prepare(
            "SELECT DISTINCT session_id AS s FROM session_events",
          ).all() as Array<{ s: string }>;
          for (const row of sidRows) if (row.s) sessionsSet.add(row.s);
        } catch { /* old schema */ }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt — skip */ }
  }

  result.projectDirs = Array.from(projectsSet);
  result.uuidConvs = sessionsSet.size;

  // Real-usage filter — see RealUsageFilter docstring.
  const avgBytes = result.eventCount > 0 ? result.dataBytes / result.eventCount : 0;
  const recentEnough =
    result.lastMs > 0 && (filter.nowMs - result.lastMs) <= filter.recencyMs;
  result.isReal =
    result.eventCount  >= filter.minEvents &&
    projectsSet.size   >= filter.minProjects &&
    recentEnough &&
    avgBytes           >= filter.minAvgBytes;

  return result;
}

/** Aggregated multi-adapter lifetime stats. */
export interface MultiAdapterLifetimeStats {
  /** Sum of eventCount across every adapter that exists on disk. */
  totalEvents: number;
  /** Sum of sessionCount across every adapter. */
  totalSessions: number;
  /** Sum of dataBytes + rescueBytes across every adapter. */
  totalBytes: number;
  /** Per-adapter rows for adapters that have >= one .db file. */
  perAdapter: AdapterScanResult[];
}

/**
 * Aggregate lifetime stats across every adapter dir under `home`.
 * The marketing line — "your work everywhere on this machine across all
 * AI tools" — depends on this. Existing `getLifetimeStats` (single dir)
 * is untouched; this is purely additive.
 */
export function getMultiAdapterLifetimeStats(opts?: {
  home?: string;
  loadDatabase?: () => unknown;
  filter?: RealUsageFilter;
}): MultiAdapterLifetimeStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });
  const loadDb = opts?.loadDatabase ?? loadDatabaseImpl;
  const filter = {
    ...DEFAULT_REAL_USAGE_FILTER,
    ...(opts?.filter ?? {}),
    nowMs: opts?.filter?.nowMs ?? Date.now(),
  };

  const perAdapter: AdapterScanResult[] = [];
  let totalEvents = 0;
  let totalSessions = 0;
  let totalBytes = 0;

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue; // only surface adapters with a sessions dir
    const r = scanOneAdapter(entry, loadDb, filter);
    perAdapter.push(r);
    totalEvents   += r.eventCount;
    totalSessions += r.sessionCount;
    totalBytes    += r.dataBytes + r.rescueBytes;
  }

  return { totalEvents, totalSessions, totalBytes, perAdapter };
}

/** Aggregated multi-adapter real-bytes stats. */
export interface MultiAdapterRealBytesStats extends RealBytesStats {
  /** Per-adapter row in the same shape as {@link RealBytesStats}, keyed by name. */
  perAdapter: Array<RealBytesStats & { name: string }>;
}

/**
 * Aggregate real-bytes stats across every adapter dir under `home`.
 * Mirrors `getRealBytesStats` (single dir, analytics.ts:887-989) but
 * iterates {@link enumerateAdapterDirs}. Optional `sessionId` /
 * `worktreeHash` filters apply uniformly to every dir.
 */
export function getMultiAdapterRealBytesStats(opts?: {
  home?: string;
  sessionId?: string;
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): MultiAdapterRealBytesStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });

  const sum: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    totalSavedTokens: 0,
  };
  const perAdapter: MultiAdapterRealBytesStats["perAdapter"] = [];

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue;
    const one = getRealBytesStats({
      sessionsDir: entry.sessionsDir,
      sessionId: opts?.sessionId,
      worktreeHash: opts?.worktreeHash,
      loadDatabase: opts?.loadDatabase,
    });
    perAdapter.push({ name: entry.name, ...one });
    sum.eventDataBytes += one.eventDataBytes;
    sum.bytesAvoided   += one.bytesAvoided;
    sum.bytesReturned  += one.bytesReturned;
    sum.snapshotBytes  += one.snapshotBytes;
  }
  sum.totalSavedTokens = Math.floor(
    (sum.eventDataBytes + sum.bytesAvoided + sum.snapshotBytes) / 4,
  );

  return { ...sum, perAdapter };
}

/**
 * Marketing-grade labels for auto-memory file prefixes. The renderer sees raw
 * filename prefixes (`project_codex_hooks.md` → `project`) — without this map
 * the user gets schema words in the UI, which leaks the database into UX.
 */
export const autoMemoryLabels: Record<string, string> = {
  project: "What you're building",
  feedback: "How you work",
  user: "Who you are",
  reference: "Where to look",
  memory: "Long-term context",
  other: "Other notes",
};

// ─────────────────────────────────────────────────────────
// formatReport — renders FullReport as sales-grade savings dashboard
// ─────────────────────────────────────────────────────────

/** Format bytes as human-readable KB or MB. */
function kb(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}

/** Format session uptime as human-readable duration. */
function formatDuration(uptimeMin: string): string {
  const min = parseFloat(uptimeMin);
  if (isNaN(min) || min < 1) return "< 1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Format large numbers with K/M suffixes */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─────────────────────────────────────────────────────────
// Pricing (Bug #6) — Anthropic Opus input rate
// ─────────────────────────────────────────────────────────

/** Opus 4 input price: $15 per 1M tokens. */
export const OPUS_INPUT_PRICE_PER_TOKEN = 15 / 1_000_000;

/** Convert a token count to a USD string at the Opus input rate. */
export function tokensToUsd(tokens: number): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return `$${(safe * OPUS_INPUT_PRICE_PER_TOKEN).toFixed(2)}`;
}

/**
 * Build a proportional bar using █ chars, scaled to a fixed width.
 * Returns e.g. "████████████████████████████████████████" for full width.
 */
function dataBar(bytes: number, maxBytes: number, width: number = 40): string {
  if (maxBytes <= 0) return "░".repeat(width);
  const filled = Math.max(1, Math.round((bytes / maxBytes) * width));
  return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));
}

/**
 * Render project memory section with category bars.
 *
 * Shows persistent event data, and — when supplied — lifetime totals
 * across every project's SessionDB so users see the cumulative value
 * (Bug #3).
 *
 * Caps the category list at `topN` and prints "N more categories" with the
 * actual remaining count (Bug #5 — was hardcoded "9 more").
 */
function renderProjectMemory(
  pm: FullReport["projectMemory"],
  opts?: { lifetime?: LifetimeStats; topN?: number; sessionTokensSaved?: number },
): string[] {
  const sessionTokensSaved = opts?.sessionTokensSaved ?? 0;
  // Render when EITHER disk has data OR current session has earnings.
  if (
    pm.total_events === 0 &&
    (opts?.lifetime?.totalEvents ?? 0) === 0 &&
    sessionTokensSaved === 0
  ) {
    return [];
  }
  // Show enough categories that the user can SEE what's actually being
  // tracked, instead of "Files tracked + Project rules · 21 more" hiding
  // the storytelling. 15 covers the 14-category-and-below typical case
  // fully and still keeps the terminal output under one screen height.
  // (Restored after #424 squash-merge silently reverted the v1.0.111 fix.)
  const topN = opts?.topN ?? 15;
  const out: string[] = [];
  out.push("");
  // Header switches based on whether we have rich lifetime data from the new
  // pipeline. With it: forward-leaning "All your work" framing. Without it:
  // legacy "Persistent memory" line for back-compat with older fixtures + tests.
  const lifeEvents = opts?.lifetime?.totalEvents ?? pm.total_events;
  const lifeSessions = opts?.lifetime?.totalSessions ?? pm.session_count;
  const distinctProj = opts?.lifetime?.distinctProjects;
  if (lifeEvents > 0 && distinctProj && distinctProj > 0) {
    out.push(`  All your work  ·  ${fmtNum(lifeEvents)} events captured across ${distinctProj} project${distinctProj === 1 ? "" : "s"}  ·  ${fmtNum(lifeSessions)} conversations`);
  } else {
    out.push("Persistent memory  ✓ preserved across compact, restart & upgrade");
    // Current session counts as 1 when no prior session has been recorded yet.
    const effectiveSessions =
      lifeSessions === 0 && sessionTokensSaved > 0 ? 1 : lifeSessions;
    const sessionLabel =
      effectiveSessions === 1 ? "1 session" : `${fmtNum(effectiveSessions)} sessions`;
    // Estimate lifetime savings: ~1KB per event → ~256 tokens/event at Opus rates,
    // plus current session's already-tracked token savings (in-memory).
    const lifetimeTokens = lifeEvents * 256 + sessionTokensSaved;
    out.push(`  ${fmtNum(lifeEvents)} events · ${sessionLabel} · ~${tokensToUsd(lifetimeTokens)} saved lifetime`);
  }
  out.push("");

  // Prefer lifetime categoryCounts (aggregated across every SessionDB) so
  // the bar block matches the lifetime header above. Falls back to the
  // project-local pm.by_category when lifetime data is absent (tests, older
  // callers) or when no sidecar has any events yet.
  const lifetimeCats = opts?.lifetime?.categoryCounts;
  let cats: Array<{ category: string; count: number; label: string }>;
  if (lifetimeCats && Object.keys(lifetimeCats).length > 0) {
    cats = Object.entries(lifetimeCats)
      .filter(([, c]) => c > 0)
      .map(([category, count]) => ({
        category,
        count,
        label: categoryLabels[category] || category,
      }))
      .sort((a, b) => b.count - a.count);
  } else {
    // Defensive: filter zero/null counts on the fallback path too — bumping
    // topN to 15 made any leaked empty rows visible as "label  0  ░░░░░░".
    cats = (pm.by_category ?? []).filter((c) => c && c.count > 0);
  }
  const visible = cats.slice(0, topN);
  const maxCount = visible.length > 0 ? visible[0].count : 1;
  for (const cat of visible) {
    out.push(`  ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, maxCount, 30)}`);
  }

  // Bug #5: real overflow count, not hardcoded.
  const remaining = Math.max(0, cats.length - topN);
  if (remaining > 0) {
    out.push(`  ... ${remaining} more categor${remaining === 1 ? "y" : "ies"}`);
  }
  return out;
}

/**
 * Render the auto-memory section (Bug #4) — files Claude Code captured
 * under ~/.claude/projects/<project>/memory/ across the user's machine.
 */
function renderAutoMemory(lifetime: LifetimeStats | undefined): string[] {
  if (!lifetime || lifetime.autoMemoryCount === 0) return [];
  const out: string[] = [];
  out.push("");
  out.push(
    `  Preferences learned  ·  ${lifetime.autoMemoryCount} across ${lifetime.autoMemoryProjects} project${lifetime.autoMemoryProjects === 1 ? "" : "s"}`,
  );

  const entries = Object.entries(lifetime.autoMemoryByPrefix)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  // Top entry sets the bar scale so the visual stays proportional even when
  // the absolute counts are tiny. Entries are pre-sorted desc.
  const maxCount = entries.length > 0 ? entries[0][1] : 1;
  for (const [prefix, count] of entries) {
    const label = autoMemoryLabels[prefix] ?? prefix;
    out.push(
      `  ${label.padEnd(26)} ${String(count).padStart(2)}   ${dataBar(count, maxCount, 20)}`,
    );
  }
  return out;
}

/** Render the closing "Bottom line" footer (Bug #8). */
function renderBottomLine(sessionTokensSaved: number, lifetime: LifetimeStats | undefined): string[] {
  const out: string[] = [];
  const sessionUsd = tokensToUsd(sessionTokensSaved);
  // Lifetime = disk-aggregated events × 256 tokens + current session's
  // in-memory token savings. Two pipelines unified at the render edge so
  // lifetime ≥ session always (never the surprising "$X session · $0 lifetime"
  // a fresh user sees pre-flush).
  const lifetimeTokens = (lifetime?.totalEvents ?? 0) * 256 + sessionTokensSaved;
  const lifetimeUsd = tokensToUsd(lifetimeTokens);
  out.push("");
  out.push("─".repeat(65));
  out.push("Your AI talks less, remembers more, costs less.");
  out.push(`${sessionUsd} this session  ·  ${lifetimeUsd} lifetime`);
  out.push("─".repeat(65));
  return out;
}

/**
 * Constant token-per-event used everywhere we estimate session/lifetime $.
 * Kept in lockstep with `bin/statusline.mjs`'s persisted lifetime conversion.
 */
const TOKENS_PER_EVENT = 256;

/**
 * Render the LIFETIME Without/With hero — the screenshottable receipt.
 *
 * Why lifetime and not session: the "$X saved this session" framing is
 * arbitrary (a fresh PID can show $0 even while the user has weeks of work
 * banked). Lifetime is real, accumulating, and the number worth screenshotting.
 * The current conversation's contribution still shows below as a sub-block.
 */
function renderHero(args: {
  lifetimeTokensWithout: number;
  lifetimeTokensWith: number;
  lifetimeUsd: string;
  lifetimeWithUsd: string;
  savedPct: number;
  totalConversations: number;
  firstDate?: string;
}): string[] {
  const { lifetimeTokensWithout, lifetimeTokensWith, lifetimeUsd, lifetimeWithUsd, savedPct, totalConversations, firstDate } = args;
  const out: string[] = [];
  const since = firstDate ? `  ·  since ${firstDate}` : "";
  out.push(`  ${lifetimeUsd} saved with context-mode  ·  ${savedPct.toFixed(1)}% reduction${since}`);
  out.push("");
  const withoutBar = dataBar(lifetimeTokensWithout, lifetimeTokensWithout, 32);
  const withBar = dataBar(lifetimeTokensWith, lifetimeTokensWithout, 32);
  out.push(`  Without context-mode  ${fmtNum(lifetimeTokensWithout).padStart(7)} tokens  ${withoutBar}   ${lifetimeUsd}`);
  out.push(`  With context-mode     ${fmtNum(lifetimeTokensWith).padStart(7)} tokens  ${withBar}   ${lifetimeWithUsd}`);
  const kept = lifetimeTokensWithout - lifetimeTokensWith;
  out.push(`                        ${fmtNum(kept).padStart(7)} tokens kept out  ·  across ${totalConversations.toLocaleString("en-US")} conversations`);
  return out;
}

/**
 * Render the current conversation as a contribution narrative — not a hero.
 * Highlights the slice of lifetime savings this chat earned + concrete proof
 * (events, days alive, compact rescues).
 */
function renderConversation(c: ConversationStats, conversationUsd: string, contribPct: number): string[] {
  const out: string[] = [];
  const daysStr = c.daysAlive >= 1 ? `${c.daysAlive.toFixed(1)} days` : `${Math.max(1, Math.round(c.daysAlive * 24))} hr`;
  const pctStr = contribPct >= 1 ? `${contribPct.toFixed(0)}% of all-time` : `<1% of all-time`;
  out.push(`  This conversation contributed ${conversationUsd}  ·  ${pctStr}`);
  out.push(`  ${c.events.toLocaleString("en-US")} events  ·  ${daysStr} alive`);
  if (c.snapshotsConsumed > 0 && c.snapshotBytes > 0) {
    const rescuedTokens = Math.round(c.snapshotBytes / 4);
    out.push(`  ${c.snapshotsConsumed} compact weathered  ·  ${fmtNum(rescuedTokens)} tokens rescued from a ${(c.snapshotBytes / 1024).toFixed(0)} KB snapshot`);
  }
  out.push("");
  if (c.byCategory.length === 0) return out;
  const max = c.byCategory[0].count || 1;
  for (const cat of c.byCategory) {
    out.push(`    ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, max, 28)}`);
  }
  return out;
}

/**
 * Render a FullReport as a visual savings dashboard designed for screenshotting.
 *
 * Design principles:
 * - Before/After comparison bar is the HERO — one glance = "wow"
 * - "tokens saved" is the number people share
 * - Per-tool breakdown shows what each tool SAVED, sorted by impact
 * - Project memory: category bars showing persistent data across sessions
 * - No: Pct column, category tables, tips, jargon
 */
export function formatReport(
  report: FullReport,
  version?: string,
  latestVersion?: string | null,
  opts?: {
    lifetime?: LifetimeStats;
    mcpUsage?: McpToolUsageRow[];
    conversation?: ConversationStats;
    /**
     * Phase 8 of D2 PRD — pass realBytes pre-aggregated from
     * `getRealBytesStats(...)` and the renderer will use those numbers
     * for the $ math instead of the conservative `events × 256` estimate.
     *
     * - `realBytes.lifetime` overrides `lifetimeTokensWithout`.
     * - `realBytes.conversation` overrides `conversationTokens`.
     * - Either may be omitted independently — missing values fall back
     *   to the legacy estimate so this feature can never produce
     *   a smaller number than before (Mert: stats only go up).
     * - When the new value is SMALLER than the legacy estimate (fresh
     *   sessions before any sandbox events emit), we keep the larger
     *   number to honour the same monotonic-growth invariant.
     */
    realBytes?: {
      lifetime?: RealBytesStats;
      conversation?: RealBytesStats;
    };
  },
): string {
  const lines: string[] = [];
  const duration = formatDuration(report.session.uptime_min);
  const lifetime = opts?.lifetime;
  const mcpUsage = opts?.mcpUsage;
  const conversation = opts?.conversation;
  const realBytes = opts?.realBytes;

  // ── New layout: source-of-truth from session_events + session_resume.
  //    Used when the MCP handler has wired the current Claude Code session_id
  //    through to the renderer. Bypasses the broken in-memory tool-call counter
  //    (which only saw ctx_* MCP calls and showed "1 call · 5 KB" after hours
  //    of real conversation work).
  if (conversation && conversation.events > 0) {
    // Conversation tokens (this chat's contribution).
    const convEventsTokens = conversation.events * TOKENS_PER_EVENT;
    const convRescueTokens = Math.round((conversation.snapshotBytes ?? 0) / 4);
    const convLegacyTokens = convEventsTokens + convRescueTokens;
    // Phase 8: prefer realBytes.totalSavedTokens when present and bigger.
    // Monotonic-growth invariant — never SHRINK an existing $ number.
    const convRealTokens = realBytes?.conversation?.totalSavedTokens ?? 0;
    const conversationTokens = Math.max(convLegacyTokens, convRealTokens);
    const conversationUsd = tokensToUsd(conversationTokens);

    // Lifetime tokens — the screenshottable receipt. Includes events × 256
    // PLUS rescue benefit aggregated across every DB on disk so the killer
    // continuity-after-/compact feature isn't silently undercounted.
    const lifetimeEventsTokens = (lifetime?.totalEvents ?? 0) * TOKENS_PER_EVENT;
    const lifetimeRescueTokens = Math.round((lifetime?.rescueBytes ?? 0) / 4);
    const lifetimeLegacyTokens = lifetimeEventsTokens + lifetimeRescueTokens;
    // Phase 8: same monotonic-growth invariant for lifetime — prefer
    // realBytes when bigger (which it almost always is once sandbox-execute
    // events accumulate), fall back to the legacy estimate otherwise.
    const lifetimeRealTokens = realBytes?.lifetime?.totalSavedTokens ?? 0;
    const lifetimeTokensWithout = Math.max(lifetimeLegacyTokens, lifetimeRealTokens);
    // 2% heuristic — matches measured ratio across the test suite (~98% saved).
    // We don't have per-session bytes_returned on disk yet (D2 PRD scope).
    const lifetimeTokensWith = Math.max(1, Math.round(lifetimeTokensWithout * 0.02));
    const lifetimeUsd = tokensToUsd(lifetimeTokensWithout);
    const lifetimeWithUsd = tokensToUsd(lifetimeTokensWith);
    const savedPct = lifetimeTokensWithout > 0
      ? (1 - lifetimeTokensWith / lifetimeTokensWithout) * 100
      : 0;
    const contribPct = lifetimeTokensWithout > 0
      ? (conversationTokens / lifetimeTokensWithout) * 100
      : 0;
    const totalConversations = lifetime?.totalSessions ?? 1;
    const firstDate = lifetime?.firstEventMs
      ? new Date(lifetime.firstEventMs).toISOString().slice(0, 10)
      : undefined;

    lines.push("");
    lines.push(...renderHero({
      lifetimeTokensWithout,
      lifetimeTokensWith,
      lifetimeUsd,
      lifetimeWithUsd,
      savedPct,
      totalConversations,
      firstDate,
    }));
    lines.push("");
    lines.push("");
    // ALL YOUR WORK block — full lifetime breakdown, the proof beneath the receipt.
    // sessionTokensSaved=0: conversation events are already in lifetime.totalEvents,
    // adding conversationTokens again would double-count.
    lines.push(...renderProjectMemory(report.projectMemory, { lifetime, sessionTokensSaved: 0, topN: Number.POSITIVE_INFINITY }));
    lines.push("");
    // THIS CONVERSATION CONTRIBUTION — narrative slice of lifetime, not a competing hero.
    lines.push(...renderConversation(conversation, conversationUsd, contribPct));
    lines.push("");
    lines.push(...renderAutoMemory(lifetime));
    lines.push("");
    lines.push("  Your AI talks less, remembers more, costs less.");
    lines.push(`  Saved ${lifetimeUsd} across all your work  ·  ${conversationUsd} from this conversation`);
    lines.push("");
    const versionStr = version ? `v${version}` : "context-mode";
    lines.push(`  ${versionStr}`);
    if (version && latestVersion && latestVersion !== "unknown" && semverNewer(latestVersion, version)) {
      lines.push(`  Update available: v${version} -> v${latestVersion}  |  ctx_upgrade`);
    }
    return lines.join("\n");
  }

  // ── Compute real savings ──
  const totalKeptOut =
    report.savings.kept_out + (report.cache ? report.cache.bytes_saved : 0);
  const totalReturned = report.savings.total_bytes_returned;
  const totalCalls = report.savings.total_calls;
  const grandTotal = totalKeptOut + totalReturned;
  const savingsPct = grandTotal > 0 ? (totalKeptOut / grandTotal) * 100 : 0;
  const tokensSaved = Math.round(totalKeptOut / 4);
  const ratioMultiplier = totalReturned > 0
    ? Math.max(1, Math.round(grandTotal / Math.max(totalReturned, 1)))
    : 0;

  // ── Fresh session: no savings yet ──
  if (totalKeptOut === 0) {
    lines.push(`context-mode  ${duration}  ${totalCalls} calls`);
    lines.push("");

    if (totalCalls === 0) {
      lines.push("No tool calls yet. Use batch_execute or execute to start saving tokens.");
    } else {
      lines.push(`${kb(totalReturned)} entered context  |  0 tokens saved`);
    }

    // Project memory + auto-memory + bottom line
    lines.push(...renderProjectMemory(report.projectMemory, { lifetime, sessionTokensSaved: 0 }));
    lines.push(...renderAutoMemory(lifetime));
    lines.push(...renderBottomLine(0, lifetime));

    // Footer
    lines.push("");
    const versionStr = version ? `v${version}` : "context-mode";
    lines.push(versionStr);
    if (version && latestVersion && latestVersion !== "unknown" && semverNewer(latestVersion, version)) {
      lines.push(`Update available: v${version} -> v${latestVersion}  |  ctx_upgrade`);
    }
    return lines.join("\n");
  }

  // ── Active session: visual savings dashboard ──

  // Line 1: Hero metric — the screenshottable number
  // Bug #6: include Opus pricing on the hero line for credibility.
  lines.push(
    `${fmtNum(tokensSaved)} tokens saved  ·  ${savingsPct.toFixed(1)}% reduction  ·  ${duration}  ·  ~${tokensToUsd(tokensSaved)} saved (Opus)`,
  );
  lines.push("");

  // Lines 2-3: Before/After comparison bars — the visual proof
  lines.push(`Without context-mode  |${dataBar(grandTotal, grandTotal)}| ${kb(grandTotal)}`);
  lines.push(`With context-mode     |${dataBar(totalReturned, grandTotal)}| ${kb(totalReturned)}`);
  lines.push("");

  // Value statement — the line people share
  // Bug #7: replace meaningless "3.0x" ratio with "3× longer sessions".
  if (ratioMultiplier >= 2) {
    lines.push(`${kb(totalKeptOut)} kept out of your conversation — ${ratioMultiplier}× longer sessions before compact.`);
  } else {
    lines.push(`${kb(totalKeptOut)} kept out of your conversation. Never entered context.`);
  }
  lines.push("");

  // Compact stats row
  const statParts = [`${totalCalls} calls`];
  if (report.cache && report.cache.hits > 0) {
    statParts.push(`${report.cache.hits} cache hits (+${kb(report.cache.bytes_saved)})`);
  }
  lines.push(statParts.join("  ·  "));

  // ── Per-tool breakdown (only if 2+ tools, sorted by saved) ──
  const activatedTools = report.savings.by_tool.filter((t) => t.calls > 0);
  if (activatedTools.length >= 2) {
    lines.push("");

    // Estimate per-tool saved using global savings ratio
    const toolRows = activatedTools.map((t) => {
      const returnedBytes = t.context_kb * 1024;
      const estimatedTotal = savingsPct < 100
        ? returnedBytes / (1 - savingsPct / 100)
        : returnedBytes;
      const estimatedSaved = Math.max(0, estimatedTotal - returnedBytes);
      return { ...t, returnedBytes, estimatedSaved };
    }).sort((a, b) => b.estimatedSaved - a.estimatedSaved);

    // Compact table: tool name, calls, saved
    for (const t of toolRows) {
      const name = t.tool.length > 22 ? t.tool.slice(0, 19) + "..." : t.tool;
      lines.push(`  ${name.padEnd(22)}  ${String(t.calls).padStart(4)} calls  ${kb(t.estimatedSaved).padStart(8)} saved`);
    }
  }

  // ── Parallel I/O — value-forward framing for concurrent batch tools.
  // Suppressed when no tool ran with max_concurrency > 1 (don't claim
  // parallelism we didn't deliver). Internal mcp__*__ namespace stripped
  // for user-facing readability.
  if (mcpUsage && mcpUsage.length > 0) {
    const concurrent = mcpUsage.filter(
      (u) => u.median_concurrency != null && (u.max_concurrency ?? 1) > 1,
    );
    if (concurrent.length > 0) {
      lines.push("");
      lines.push(
        "Parallel I/O  ✓ one call did the work of many — faster runs, lower bill, same answer.",
      );
      for (const u of concurrent) {
        const name = u.tool_name.replace(/^mcp__.*?__/, "");
        lines.push(
          `  ${name.padEnd(22)} ${u.calls} batches · ${u.median_concurrency} typical, ${u.max_concurrency} peak`,
        );
      }
    }
  }

  // ── Project memory — persistent across sessions (Bug #3 + #5) ──
  lines.push(...renderProjectMemory(report.projectMemory, { lifetime, sessionTokensSaved: tokensSaved }));

  // ── Auto-memory — Claude Code's preference learnings (Bug #4) ──
  lines.push(...renderAutoMemory(lifetime));

  // ── Bottom line — business value framing (Bug #8) ──
  lines.push(...renderBottomLine(tokensSaved, lifetime));

  // ── Footer ──
  lines.push("");
  const versionStr = version ? `v${version}` : "context-mode";
  lines.push(versionStr);
  if (version && latestVersion && latestVersion !== "unknown" && latestVersion !== version) {
    lines.push(`Update available: v${version} -> v${latestVersion}  |  ctx_upgrade`);
  }

  return lines.join("\n");
}
