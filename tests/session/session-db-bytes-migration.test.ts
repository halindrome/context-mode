/**
 * SessionDB — bytes_avoided / bytes_returned schema migration (D2 PRD Phase 1).
 *
 * The session_events table must carry per-event byte accounting so the
 * Insight dashboard can compute "tokens returned" vs "tokens we kept out
 * of the model's context window". Both columns are NOT NULL with a
 * default of 0 so existing callers (and rows) keep working unchanged.
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, describe, test } from "vitest";
import Database from "better-sqlite3";
import { SessionDB } from "../../src/session/db.js";

interface ColInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
}

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

/**
 * Create a SessionDB at a known on-disk path so the test can open a
 * second read-only handle against the same file to inspect schema.
 */
function createTestDB(): { db: SessionDB; dbPath: string } {
  const dbPath = join(tmpdir(), `session-bytes-migration-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return { db, dbPath };
}

function getColumnInfo(dbPath: string, table: string): Map<string, ColInfo> {
  const reader = new Database(dbPath, { readonly: true });
  try {
    const rows = reader.pragma(`table_xinfo(${table})`) as ColInfo[];
    return new Map(rows.map((r) => [r.name, r]));
  } finally {
    reader.close();
  }
}

describe("SessionDB bytes columns (D2 PRD Phase 1)", () => {
  test("session_events has bytes_avoided NOT NULL DEFAULT 0", () => {
    const { dbPath } = createTestDB();
    const cols = getColumnInfo(dbPath, "session_events");
    const col = cols.get("bytes_avoided");
    assert.ok(col, "bytes_avoided column must exist");
    assert.equal(col!.notnull, 1, "bytes_avoided must be NOT NULL");
    assert.equal(Number(col!.dflt_value), 0, "bytes_avoided default must be 0");
  });

  test("session_events has bytes_returned NOT NULL DEFAULT 0", () => {
    const { dbPath } = createTestDB();
    const cols = getColumnInfo(dbPath, "session_events");
    const col = cols.get("bytes_returned");
    assert.ok(col, "bytes_returned column must exist");
    assert.equal(col!.notnull, 1, "bytes_returned must be NOT NULL");
    assert.equal(Number(col!.dflt_value), 0, "bytes_returned default must be 0");
  });
});
