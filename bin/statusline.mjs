#!/usr/bin/env node
/**
 * context-mode status line — Claude Code statusLine integration.
 *
 * Reads stats DIRECTLY from SessionDB (`session_events` + `session_resume`),
 * mirroring the `ctx_stats` MCP handler at src/server.ts:2807-2891 so the
 * statusline and ctx_stats never drift. The legacy per-PID sidecar JSON
 * (`stats-pid-*.json`) is no longer the source of truth — sidecars were
 * eventually-consistent (500ms+30s throttles) and PID-scoped (multiple
 * Claude sessions colliding on the same shell ppid).
 *
 * Discipline (Datadog / Stripe / Vercel pattern):
 *   - "context-mode" full brand label, never abbreviated
 *   - ONE chromatic accent (status dot ●), everything else monochrome
 *   - Bold for KPI numbers ($, %), dim for context
 *   - No counts (calls / tokens / events) — only $ and % pass the
 *     value-per-pixel test
 *
 * Wire it up in ~/.claude/settings.json:
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "context-mode statusline"
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Analytics import — resolved relative to this script ─────────────────
// statusline.mjs ships in `bin/`; the compiled analytics module lives in
// `build/session/analytics.js`. Import lazily so a missing build doesn't
// crash the renderer — degrade to the substantiated headline instead.
//
// The dynamic import target MUST be a `file://` URL on Windows. Node's
// ESM loader rejects absolute drive-letter paths (`C:\...`) with
// ERR_UNSUPPORTED_ESM_URL_SCHEME — which the catch below silently
// swallows, leaving `_analytics = null` and rendering the empty-state
// headline forever. Convert to a file URL so Windows accepts it.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ANALYTICS_PATH = resolve(__dirname, "..", "build", "session", "analytics.js");
const ANALYTICS_URL = pathToFileURL(ANALYTICS_PATH).href;

let _analytics = null;
async function loadAnalytics() {
  if (_analytics) return _analytics;
  try {
    _analytics = await import(ANALYTICS_URL);
  } catch {
    _analytics = null;
  }
  return _analytics;
}

// Test seams — keep production behaviour identical when env vars unset.
//   CTX_TEST_PLATFORM — override process.platform for cross-OS resolver tests
//   CTX_TEST_PROC_DIR — override /proc base dir for Linux PID-walk tests
const TEST_PLATFORM = process.env.CTX_TEST_PLATFORM;
const PROC_DIR = process.env.CTX_TEST_PROC_DIR || "/proc";
function platform() {
  return TEST_PLATFORM || process.platform;
}

// Single-shot stderr warning latch — keep noise out of Claude Code's
// statusline output even when our parent runs us repeatedly per session.
let __winWarned = false;
function warnOnce(key, msg) {
  if (key === "win" && __winWarned) return;
  if (key === "win") __winWarned = true;
  try { process.stderr.write(`context-mode statusline: ${msg}\n`); } catch { /* ignore */ }
}

// ── ANSI palette (single chromatic accent on the status dot) ────────────
const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const ansi = (code, text) => (NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);
const brand = (t) => ansi("1;36", t);   // bold cyan — brand presence
const bold = (t) => ansi("1", t);        // bold default fg — KPI numbers
const dim = (t) => ansi("2", t);         // dim default fg — context
const green = (t) => ansi("32", t);      // healthy dot
const yellow = (t) => ansi("33", t);     // degraded dot
const red = (t) => ansi("31", t);        // stale dot
const SEP = dim("·");

// ── Stdin drain ─────────────────────────────────────────────────────────
function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveSessionDir() {
  if (process.env.CONTEXT_MODE_SESSION_DIR) {
    return process.env.CONTEXT_MODE_SESSION_DIR;
  }
  return join(homedir(), ".claude", "context-mode", "sessions");
}

/**
 * Walk up the parent process chain to find the Claude Code PID.
 *
 * Claude Code spawns the status line through a shell, so process.ppid is
 * the intermediate shell, not Claude Code itself. We walk up until we find
 * a process whose name matches /claude/i.
 *
 * Per-OS resolver:
 *   - linux: read PPid + Name from /proc/<pid>/status
 *   - darwin: ps -o ppid=,comm= -p <pid> (BSD ps; works without /proc)
 *   - win32: degraded — process.ppid only, with a one-shot stderr warning
 *
 * Without this walk, multiple concurrent Claude sessions all see the same
 * shell ppid and collide on per-PID stats lookup.
 */
function findClaudePid() {
  const plat = platform();
  if (plat === "linux") return findClaudePidLinux();
  if (plat === "darwin") return findClaudePidDarwin();
  if (plat === "win32") {
    warnOnce(
      "win",
      "Windows process-tree walk unsupported; multiple concurrent Claude sessions may collide. Set CLAUDE_SESSION_ID for deterministic resolution.",
    );
    return process.ppid;
  }
  return process.ppid;
}

function findClaudePidLinux() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    try {
      const status = readFileSync(`${PROC_DIR}/${pid}/status`, "utf-8");
      const nameMatch = status.match(/^Name:\s+(.+)$/m);
      const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
      const name = nameMatch?.[1]?.trim() ?? "";
      if (/claude/i.test(name)) return pid;
      pid = ppidMatch ? Number(ppidMatch[1]) : 0;
    } catch {
      return process.ppid;
    }
  }
  return process.ppid;
}

function findClaudePidDarwin() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    try {
      const out = execFileSync(
        "ps",
        ["-o", "ppid=,comm=", "-p", String(pid)],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (!out) return process.ppid;
      const m = out.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) return process.ppid;
      const parentPid = Number(m[1]);
      const comm = m[2].trim();
      const base = comm.split("/").pop() || comm;
      if (/claude/i.test(base)) return pid;
      pid = parentPid;
    } catch {
      return process.ppid;
    }
  }
  return process.ppid;
}

function resolveSessionId() {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return `pid-${findClaudePid()}`;
}

// ── Formatters ───────────────────────────────────────────────────────────
function fmtUsd(n) {
  const safe = Number.isFinite(n) && n >= 0 ? n : 0;
  if (safe >= 100) return `$${safe.toFixed(0)}`;
  return `$${safe.toFixed(2)}`;
}

// ── Status dot — the ONE accent ──────────────────────────────────────────
function statusDot(pct) {
  if (pct >= 50) return green("●");
  if (pct >= 1) return yellow("●");
  return green("●");
}

// ── Main render ──────────────────────────────────────────────────────────
async function main() {
  readStdinJson(); // drain stdin even if unused, keeps Claude Code happy
  const sessionsDir = resolveSessionDir();
  const sessionId = resolveSessionId();

  const analytics = await loadAnalytics();

  // BRAND-NEW / build missing — substantiated headline only
  if (!analytics) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  const {
    getRealBytesStats,
    getMultiAdapterLifetimeStats,
    OPUS_INPUT_PRICE_PER_TOKEN,
  } = analytics;

  // Sessions dir doesn't exist yet — first ever launch
  if (!existsSync(sessionsDir)) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  // Lifetime real-bytes across this adapter's sessions dir.
  // Mirrors src/server.ts:2860 — the same call ctx_stats uses.
  let lifetime;
  try {
    lifetime = getRealBytesStats({ sessionsDir });
  } catch {
    lifetime = null;
  }

  // Per-conversation real-bytes for the session $ KPI.
  // Statusline doesn't know the worktree hash, so scan every db in the
  // dir and let getRealBytesStats filter by sessionId.
  let conversation;
  try {
    conversation = getRealBytesStats({ sessionsDir, sessionId });
  } catch {
    conversation = null;
  }

  // Cross-adapter lifetime — drives the "across N tools" headline when
  // 2+ real adapters are present. Mirrors src/server.ts:2840.
  let multi;
  try {
    multi = getMultiAdapterLifetimeStats();
  } catch {
    multi = null;
  }

  const PRICE = OPUS_INPUT_PRICE_PER_TOKEN ?? (15 / 1_000_000);
  const lifetimeTokens = lifetime?.totalSavedTokens ?? 0;
  const sessionTokens = conversation?.totalSavedTokens ?? 0;
  const lifetimeUsd = lifetimeTokens * PRICE;
  const sessionUsd = sessionTokens * PRICE;

  // Reduction % — bytes avoided + snapshot bytes vs returned bytes.
  // Mirrors persistStats() math in src/server.ts:565-568.
  const totalReturned = lifetime?.bytesReturned ?? 0;
  const totalKept =
    (lifetime?.bytesAvoided ?? 0)
    + (lifetime?.snapshotBytes ?? 0)
    + (lifetime?.eventDataBytes ?? 0);
  const totalProcessed = totalKept + totalReturned;
  const pct = totalProcessed > 0
    ? Math.round((totalKept / totalProcessed) * 100)
    : 0;

  const dot = statusDot(pct);

  // Multi-adapter aggregation. Real adapters = those passing the isReal
  // filter (>=100 events, >=5 distinct projects, recent activity, avg
  // bytes >= 50). When 2+ real adapters exist, surface a cross-tool $.
  // multi.totalBytes is dataBytes + rescueBytes, NOT bytes-avoided — so
  // it's a different (and typically smaller) lens than getRealBytesStats.
  // Render the multi $ alongside lifetime $ rather than instead of it.
  const realAdapters = (multi?.perAdapter ?? []).filter((a) => a?.isReal);
  const multiTotalTokens = (multi?.totalBytes ?? 0) / 4;
  const multiUsd = multiTotalTokens * PRICE;
  const showMultiAdapter = realAdapters.length >= 2 && multiUsd > 0;

  // BRAND-NEW: no local SessionDB data at all → headline.
  // Multi-adapter alone (without local data) means another tool has
  // history but THIS Claude session is fresh — still show headline,
  // not someone else's lifetime $, to avoid surprising users with a
  // number they can't trace to their current adapter.
  if (lifetimeTokens === 0 && sessionTokens === 0) {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
    return;
  }

  // FRESH session, no session $ yet — lead with persistence value.
  if (sessionUsd === 0 && lifetimeUsd > 0) {
    const blocks = [
      `${bold(fmtUsd(lifetimeUsd))} ${dim("saved across sessions")}`,
    ];
    if (showMultiAdapter) {
      blocks.push(`${bold(fmtUsd(multiUsd))} ${dim(`across ${realAdapters.length} tools`)}`);
    }
    blocks.push(dim("preserved across compact, restart & upgrade"));
    process.stdout.write(
      `${brand("context-mode")}  ${dot}  ${blocks.join(`  ${SEP}  `)}`,
    );
    return;
  }

  // ACTIVE: session $ · lifetime $ · [multi $] · % efficient
  const valueBlocks = [
    `${bold(fmtUsd(sessionUsd))} ${dim("saved this session")}`,
  ];
  if (lifetimeUsd > 0) {
    valueBlocks.push(`${bold(fmtUsd(lifetimeUsd))} ${dim("saved across sessions")}`);
  }
  if (showMultiAdapter) {
    valueBlocks.push(`${bold(fmtUsd(multiUsd))} ${dim(`across ${realAdapters.length} tools`)}`);
  }
  if (pct > 0) {
    valueBlocks.push(`${bold(`${pct}%`)} ${dim("efficient")}`);
  }

  const head = `${brand("context-mode")}  ${dot}  `;
  const tail = valueBlocks.join(`  ${SEP}  `);
  process.stdout.write(head + tail);
}

main().catch(() => {
  // Last-resort fallback — a thrown error must never produce a blank statusline.
  try {
    process.stdout.write(
      `${brand("context-mode")}  ${green("●")}  ${dim("saves ~98% of context window")}`,
    );
  } catch { /* ignore */ }
});
