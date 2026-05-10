/**
 * purgeSession — deep module that wipes ALL session-related on-disk artifacts
 * for a single project directory.
 *
 * Why a deep module instead of an inline handler:
 *   - The previous inline ctx_purge handler was 100+ lines split across three
 *     try/catch blocks. Only ONE of those blocks knew about the case-fold
 *     migration's dual-hash legacy filenames, so a partial upgrade could
 *     leak orphaned events.md / .cleanup files on macOS / Windows.
 *   - Centralizing the logic here means: one canonical sidecar list, one
 *     uniform dual-hash sweep, one place to add new file kinds.
 *
 * Worktree separation guarantee (carried over from the case-fold migration):
 *   Every path this module touches is derived deterministically from the input
 *   `projectDir`. There is NO `readdirSync` + glob-filter loop. Different
 *   worktrees → different physical paths → different canonical hashes →
 *   different file names → cannot collapse worktrees on disk.
 *
 * SQLite sidecar handling:
 *   Each `.db` file may be accompanied by `-wal` (write-ahead log) and `-shm`
 *   (shared memory index) sidecars. We unlink the triple unconditionally —
 *   missing sidecars are not an error. This matches the canonical SQLite
 *   sidecar naming used elsewhere (see refs/platforms/zed/crates/sqlez:
 *   `[main, "{main}-wal", "{main}-shm"]`).
 *
 * Cross-platform notes:
 *   - All paths are joined via `node:path.join` so Windows backslash
 *     separators and POSIX forward slashes both work.
 *   - On macOS / Windows (case-insensitive FS) we sweep BOTH the canonical
 *     (lowercased) and legacy (raw-cased) project-dir hash variants for the
 *     session-related kinds. On Linux the two hashes coincide, so the dual
 *     sweep collapses into a single unique-path pass.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  getWorktreeSuffix,
  hashProjectDirCanonical,
  hashProjectDirLegacy,
} from "./db.js";

/** Canonical SQLite sidecar suffixes. The empty string is the main DB. */
const SQLITE_SIDECARS = ["", "-wal", "-shm"] as const;

export interface PurgeOpts {
  /**
   * Absolute path to the project root. Drives every other path the module
   * touches via the project-dir hash. MUST be the same string the rest of
   * the system uses (e.g. `getProjectDir()`); otherwise the wrong DB is
   * targeted. Worktree separation is preserved — only files matching
   * THIS projectDir's hash are unlinked.
   */
  projectDir: string;
  /**
   * Adapter-specific session directory (e.g. `~/.claude/context-mode/sessions`).
   * Holds: `<hash><suffix>.db`, `<hash><suffix>-events.md`,
   * `<hash><suffix>.cleanup`.
   */
  sessionsDir: string;
  /**
   * Absolute path to the per-project FTS5 knowledge-base DB
   * (e.g. `~/.claude/context-mode/content/<hash>.db`). When omitted no
   * FTS5 wipe runs. Caller is responsible for closing any open handle
   * BEFORE invoking purgeSession (Windows file locks).
   */
  storePath?: string;
  /**
   * Legacy shared content directory at `~/.context-mode/content`. When
   * omitted, the legacy content sweep is skipped.
   */
  legacyContentDir?: string;
  /**
   * Hash used to locate the legacy shared content DB. Required when
   * `legacyContentDir` is provided. Computed by the caller because the
   * legacy code-path uses a different hash function than the canonical
   * session DB hash.
   */
  contentHash?: string;
}

export interface PurgeResult {
  /**
   * Human-readable labels rendered to the user by the ctx_purge handler.
   * MUST stay backward-compatible with the existing UI strings:
   *   "knowledge base (FTS5)", "session events DB", "session events markdown".
   * Each label appears at most once, and only when at least one matching
   * file was actually unlinked.
   */
  deleted: string[];
  /**
   * Every full path that was successfully `unlink`ed. Surfaced for tests
   * and for diagnostic logging — NEVER shown to end users (the labels
   * above carry the human story).
   */
  wipedPaths: string[];
}

/** Try to unlink one path; report success without throwing on ENOENT etc. */
function tryUnlink(p: string, wipedPaths: string[]): boolean {
  try {
    unlinkSync(p);
    wipedPaths.push(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlink a SQLite db at `path` plus its `-wal` / `-shm` sidecars.
 * Returns true when the MAIN db file (not a sidecar) was removed.
 */
function tryUnlinkSqliteTriple(path: string, wipedPaths: string[]): boolean {
  let mainRemoved = false;
  for (const suffix of SQLITE_SIDECARS) {
    const removed = tryUnlink(`${path}${suffix}`, wipedPaths);
    if (removed && suffix === "") mainRemoved = true;
  }
  return mainRemoved;
}

/**
 * Wipe every session-related on-disk artifact for `projectDir`.
 *
 * This function never throws on missing files (a fresh install is a no-op).
 * It throws only when given an invalid argument (e.g. `legacyContentDir`
 * without `contentHash`), which is a programmer bug not a runtime concern.
 */
export function purgeSession(opts: PurgeOpts): PurgeResult {
  const { projectDir, sessionsDir, storePath, legacyContentDir, contentHash } = opts;
  const deleted: string[] = [];
  const wipedPaths: string[] = [];

  // ── 1. Knowledge base FTS5 store (per-platform). ──────────────────────
  // Single-hash today: the FTS5 store has not undergone the case-fold
  // migration that the SessionDB underwent in commit a32cc29, so there is
  // no "legacy" variant to sweep. If/when that migration lands the caller
  // can pass an array of `storePath` candidates by computing them outside.
  if (storePath) {
    const removed = tryUnlinkSqliteTriple(storePath, wipedPaths);
    if (removed) deleted.push("knowledge base (FTS5)");
  }

  // ── 2. Legacy shared content DB at ~/.context-mode/content/<hash>.db.
  // Same reasoning as (1) — single hash, legacy code-path only.
  if (legacyContentDir) {
    if (!contentHash) {
      throw new TypeError("purgeSession: contentHash is required when legacyContentDir is provided");
    }
    const legacyPath = join(legacyContentDir, `${contentHash}.db`);
    tryUnlinkSqliteTriple(legacyPath, wipedPaths);
    // No user-facing label — this is a silent legacy cleanup.
  }

  // ── 3. Session-events kinds at BOTH canonical AND legacy hashes. ─────
  // This is the bug fix: the prior handler only dual-hashed the .db file
  // (after migration commit a32cc29). events.md and .cleanup were left
  // single-hash, so a casing-drift project on macOS/Windows could leak
  // orphan files past a purge. We now sweep all three uniformly.
  const worktreeSuffix = getWorktreeSuffix(projectDir);
  const canonicalHash = hashProjectDirCanonical(projectDir);
  const legacyHash = hashProjectDirLegacy(projectDir);
  const hashes = canonicalHash === legacyHash
    ? [canonicalHash]
    : [canonicalHash, legacyHash];

  let sessDbFound = false;
  let eventsFound = false;
  for (const h of hashes) {
    const base = join(sessionsDir, `${h}${worktreeSuffix}`);
    if (tryUnlinkSqliteTriple(`${base}.db`, wipedPaths)) sessDbFound = true;
    if (tryUnlink(`${base}-events.md`, wipedPaths)) eventsFound = true;
    tryUnlink(`${base}.cleanup`, wipedPaths); // no user-facing label
  }
  if (sessDbFound) deleted.push("session events DB");
  if (eventsFound) deleted.push("session events markdown");

  return { deleted, wipedPaths };
}
