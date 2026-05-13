/**
 * db-base platform gate — issue #551 follow-up.
 *
 * Node 26 removed `info.This()` from V8 PropertyCallbackInfo. better-sqlite3
 * 12.9.0 still calls it, so the native addon fails to compile on
 * darwin-arm64 + Node 26. Workaround: prefer the built-in `node:sqlite`
 * adapter (which ships its own SQLite, no native compile) on every platform
 * that has it — not just Linux.
 *
 * v1.0.124 gated `node:sqlite` adoption on `process.platform === "linux"`.
 * v1.0.125 widens the gate to `hasModernSqlite()` (Bun OR Node >= 22.5),
 * matching the helper that already exists in hooks/ensure-deps.mjs:61.
 *
 * Source-level guard: parses src/db-base.ts to assert the gate references
 * `hasModernSqlite` (not the legacy `process.platform === "linux"`).
 * Runtime guard: invokes the exported helper against synthetic Node
 * versions and asserts the expected boolean.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

describe("db-base platform gate (#551)", () => {
  const dbBasePath = resolve(__dirname, "..", "..", "src", "db-base.ts");
  const src = readFileSync(dbBasePath, "utf8");

  it("exports hasModernSqlite helper (Bun OR Node >= 22.5)", async () => {
    const mod = await import("../../src/db-base.js");
    expect(typeof (mod as Record<string, unknown>).hasModernSqlite).toBe("function");
    // The helper must return a boolean for the live runtime (true or false
    // depending on the test environment's Node version).
    const live = (mod as { hasModernSqlite: () => boolean }).hasModernSqlite();
    expect(typeof live).toBe("boolean");
  });

  it("loadDatabase ladder uses hasModernSqlite() — not the legacy linux gate", () => {
    // After the gate widening, the only Linux check that should survive is
    // inside the COMMENT explaining the SIGSEGV history; the runtime branch
    // must call hasModernSqlite().
    const loadDbRegion = src.split("export function loadDatabase")[1] ?? "";
    expect(loadDbRegion).toContain("hasModernSqlite()");
    // Defensive: ensure the legacy gate `process.platform === "linux"` no
    // longer appears as a runtime branch condition in loadDatabase.
    expect(loadDbRegion).not.toMatch(/process\.platform\s*===\s*"linux"/);
  });

  it("hasModernSqlite returns true for Bun and Node >= 22.5", async () => {
    // Sanity: when we mock process.versions.node to 26.0.0 the helper must
    // return true — this is the codepath that fixes the macOS+Node26 break.
    const { hasModernSqlite } = (await import("../../src/db-base.js")) as {
      hasModernSqlite: (versionsOverride?: NodeJS.ProcessVersions, bun?: unknown) => boolean;
    };
    expect(
      hasModernSqlite({ ...process.versions, node: "26.0.0" }, undefined),
    ).toBe(true);
    expect(
      hasModernSqlite({ ...process.versions, node: "22.5.0" }, undefined),
    ).toBe(true);
    // Bun runtime — always true.
    expect(
      hasModernSqlite({ ...process.versions, node: "18.0.0" }, /* fakeBun */ {}),
    ).toBe(true);
    // Old Node, no Bun — false.
    expect(
      hasModernSqlite({ ...process.versions, node: "22.4.0" }, undefined),
    ).toBe(false);
    expect(
      hasModernSqlite({ ...process.versions, node: "20.10.0" }, undefined),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 5 (#560): Per-DB lockfile primitive
// One context-mode server may hold the DB at a time; second openers
// fail loudly with the reporter's verbatim message instead of
// silently corrupting the WAL.
// ─────────────────────────────────────────────────────────
describe("acquireDbLock / releaseDbLock (#560)", () => {
  // Use a directory OUTSIDE tmpdir so the helper does NOT skip-gate
  // away. The skip-gate (tmpdir-prefixed paths) is exercised below.
  const homeOutsideTmp = mkdtempSync(join(process.env.HOME || "/tmp", ".ctx-mode-lock-test-"));
  let testDb: string;
  let lockPath: string;

  beforeEach(() => {
    testDb = join(homeOutsideTmp, `lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    lockPath = `${testDb}.lock`;
  });

  afterEach(() => {
    try { unlinkSync(lockPath); } catch { /* may not exist */ }
  });

  it("writes a lockfile containing the current PID via O_EXCL", async () => {
    const { acquireDbLock, releaseDbLock } = await import("../../src/util/db-lock.js");
    const result = acquireDbLock({ dbPath: testDb });
    expect(result.skipped).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
    releaseDbLock({ dbPath: testDb });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws DatabaseLockedError when another live PID holds the lock", async () => {
    const { acquireDbLock } = await import("../../src/util/db-lock.js");
    // Use the test runner's own PID — guaranteed alive.
    writeFileSync(lockPath, String(process.pid), { flag: "w" });
    expect(() => acquireDbLock({ dbPath: testDb }))
      .toThrow(/Another context-mode server is already running/);
  });

  it("claims a stale lockfile when the owning PID is dead", async () => {
    const { acquireDbLock, releaseDbLock } = await import("../../src/util/db-lock.js");
    // PID 99999999 is well beyond /proc/sys/kernel/pid_max (4194304 on
    // Linux, much smaller on macOS). isProcessAlive returns false.
    writeFileSync(lockPath, "99999999", { flag: "w" });
    const result = acquireDbLock({ dbPath: testDb });
    expect(result.skipped).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
    releaseDbLock({ dbPath: testDb });
  });

  it("two simultaneous claims — only one succeeds (O_EXCL atomicity)", async () => {
    const { acquireDbLock, releaseDbLock } = await import("../../src/util/db-lock.js");
    // First claim wins.
    acquireDbLock({ dbPath: testDb });
    // Second claim from the same process must fail because the lock
    // contains our own PID (which is alive). This proves atomicity:
    // a second opener never silently reuses the lock.
    expect(() => acquireDbLock({ dbPath: testDb })).toThrow(/already running/);
    releaseDbLock({ dbPath: testDb });
  });

  it("skips when dbPath is under the OS tmpdir (per-process DBs)", async () => {
    const { acquireDbLock, releaseDbLock } = await import("../../src/util/db-lock.js");
    const tmpDb = join(tmpdir(), `context-mode-${process.pid}-skip.db`);
    const result = acquireDbLock({ dbPath: tmpDb });
    expect(result.skipped).toBe(true);
    // No lockfile should have been created.
    expect(existsSync(`${tmpDb}.lock`)).toBe(false);
    // Release on a skipped path is a no-op (matches closeDB shape — never throws).
    expect(() => releaseDbLock({ dbPath: tmpDb })).not.toThrow();
  });

  it("releaseDbLock swallows errors when the lockfile is already gone", async () => {
    const { releaseDbLock } = await import("../../src/util/db-lock.js");
    expect(() => releaseDbLock({ dbPath: testDb })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────
// Slice 6 (#560): Wire lockfile + locking_mode=EXCLUSIVE into SQLiteBase
// Source-level + runtime checks. SessionDB ctor must claim the
// lockfile, and applyWALPragmas must set locking_mode=EXCLUSIVE on
// best-effort (try/catch like the existing mmap_size line).
// ─────────────────────────────────────────────────────────
describe("SQLiteBase lockfile + EXCLUSIVE locking (#560)", () => {
  const dbBasePath = resolve(__dirname, "..", "..", "src", "db-base.ts");
  const src = readFileSync(dbBasePath, "utf8");

  // v1.0.129 — Issue #560 hotfix. EXCLUSIVE pragma was moved OUT of
  // applyWALPragmas because ContentStore (multi-writer FTS5 shared
  // knowledge base) opens the SAME db file from multiple sessions by
  // design — applying EXCLUSIVE in the shared helper deadlocked the
  // second instance and broke the documented `withRetry`-based BUSY
  // path. The pragma now lives ONLY in `SQLiteBase` ctor (see test
  // below), so single-writer DBs (SessionDB) still get EXCLUSIVE while
  // multi-writer DBs (ContentStore) keep the SHARED locking default.
  it("applyWALPragmas does NOT apply locking_mode=EXCLUSIVE (multi-writer safe)", () => {
    const region = src.split("export function applyWALPragmas")[1] ?? "";
    const upToNextExport = region.split("\nexport ")[0] ?? "";
    // The line itself must be gone — the only mention left is the
    // explanatory NOTE comment that points readers at SQLiteBase.
    expect(upToNextExport).not.toMatch(/db\.pragma\s*\(\s*["']locking_mode\s*=\s*EXCLUSIVE/);
  });

  it("SQLiteBase ctor calls acquireDbLock before opening the database", () => {
    expect(src).toMatch(/from\s+["']\.\/util\/db-lock\.js["']/);
    const ctorRegion = src.split("constructor(dbPath: string)")[1] ?? "";
    const ctorBody = ctorRegion.split("\n  protected ")[0] ?? "";
    // Lock acquired BEFORE the `new Database(dbPath, ...)` call — the
    // EXCLUSIVE pragma is the secondary defense, the lockfile is primary.
    // Anchor on `new Database(dbPath` to avoid matching the literal
    // `new Database(...)` that appears inside the comment text.
    const lockIdx = ctorBody.indexOf("acquireDbLock");
    const dbOpenIdx = ctorBody.indexOf("new Database(dbPath");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(dbOpenIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(dbOpenIdx);
  });

  it("SQLiteBase close + cleanup release the lockfile", () => {
    // close() and cleanup() must both call releaseDbLock so the
    // graceful exit path leaves a clean slate for the next opener.
    // Scope to the SQLiteBase class body — there are unrelated close()
    // methods on the BunSQLiteAdapter / NodeSQLiteAdapter wrappers.
    const classIdx = src.indexOf("export abstract class SQLiteBase");
    expect(classIdx).toBeGreaterThan(-1);
    const classBody = src.slice(classIdx);

    const closeIdx = classBody.indexOf("close(): void");
    expect(closeIdx).toBeGreaterThan(-1);
    const closeRegion = classBody.slice(closeIdx, closeIdx + 600);
    expect(closeRegion).toMatch(/releaseDbLock/);

    const cleanupIdx = classBody.indexOf("cleanup(): void");
    expect(cleanupIdx).toBeGreaterThan(-1);
    const cleanupRegion = classBody.slice(cleanupIdx, cleanupIdx + 600);
    expect(cleanupRegion).toMatch(/releaseDbLock/);
  });

  it("opening the same DB twice from the same process throws lockfile error", async () => {
    // Use a real on-disk path OUTSIDE tmpdir so the lockfile actually
    // claims (tmpdir paths skip-gate by design — per-process DBs).
    const testDir = mkdtempSync(join(process.env.HOME || "/tmp", ".ctx-mode-twice-test-"));
    const dbPath = join(testDir, "twice.db");
    const { SessionDB } = await import("../../src/session/db.js");
    let first: InstanceType<typeof SessionDB> | null = null;
    try {
      first = new SessionDB({ dbPath });
      expect(() => new SessionDB({ dbPath })).toThrow(/Another context-mode server is already running/);
    } finally {
      try { first?.cleanup(); } catch { /* best effort */ }
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ─────────────────────────────────────────────────────────
// Slice 7 (#560): Lifecycle composition — kill old → release lock
// Verifies SessionDB.close() releases the lockfile so a second opener
// can claim it. Mirrors the real upgrade flow: process A holds the
// lock, receives SIGTERM, gracefully closes, lockfile released,
// process B claims successfully.
// ─────────────────────────────────────────────────────────
describe("DB lock lifecycle composition (#559 + #560)", () => {
  it("close() releases the lockfile so the next opener succeeds", async () => {
    const testDir = mkdtempSync(join(process.env.HOME || "/tmp", ".ctx-mode-lifecycle-"));
    const dbPath = join(testDir, "lifecycle.db");
    const lockPath = `${dbPath}.lock`;
    const { SessionDB } = await import("../../src/session/db.js");
    try {
      // Process A opens — lockfile claimed.
      const a = new SessionDB({ dbPath });
      expect(existsSync(lockPath)).toBe(true);

      // Process B attempt while A holds it — must throw.
      expect(() => new SessionDB({ dbPath })).toThrow(/already running/);

      // Process A graceful close — lockfile released.
      a.close();
      expect(existsSync(lockPath)).toBe(false);

      // Process B retries — clean lockfile, opens successfully.
      const b = new SessionDB({ dbPath });
      expect(existsSync(lockPath)).toBe(true);
      b.cleanup();
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
