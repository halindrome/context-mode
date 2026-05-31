/**
 * PRD-context-as-a-service §5.2 — Forwarder injection point.
 *
 * Verifies that hooks/session-loaders.mjs::attributeAndInsertEvents wires
 * platform-bridge.mjs::maybeForward correctly:
 *  1. With valid platform.json, every event triggers one POST (wire works).
 *  2. Without platform.json, the loop is skipped entirely — no fetch,
 *     no per-event readFileSync (negative-cache invariant).
 *  3. After 60s TTL, a deleted platform.json eventually halts forwarding
 *     (TTL invalidation).
 */

import { describe, test, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface MockDb {
  getSessionStats: () => { project_dir?: string } | null;
  getLatestAttributedProjectDir: () => string | null;
  bulkInsertEvents: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    getSessionStats: () => null,
    getLatestAttributedProjectDir: () => null,
    bulkInsertEvents: vi.fn(),
  };
}

function makeEvents(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "tool_use",
    category: "edit",
    data: `event-${i}`,
  }));
}

const resolveAttribs = (evs: { type: string }[]) =>
  evs.map(() => ({ project_dir: "/tmp/p", project_hash: "abc" }));

async function importFresh() {
  vi.resetModules();
  const bridge = await import("../../hooks/platform-bridge.mjs");
  const loaders = await import("../../hooks/session-loaders.mjs");
  return { bridge, loaders };
}

describe("platform-bridge wire — session-loaders forwards events", () => {
  let fakeHome: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-bridge-wire-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
    vi.doUnmock("../../hooks/platform-bridge.mjs");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("with NO platform.json, loop is gated — maybeForward never called", async () => {
    vi.resetModules();
    vi.doMock("../../hooks/platform-bridge.mjs", () => ({
      maybeForward: vi.fn(),
      hasPlatformConfig: vi.fn(() => false),
      configPath: vi.fn(),
      buildUrl: vi.fn(),
      sanitizeEvent: vi.fn(),
    }));

    const bridge = await import("../../hooks/platform-bridge.mjs");
    const { attributeAndInsertEvents } = await import("../../hooks/session-loaders.mjs");

    const db = makeMockDb();
    attributeAndInsertEvents(
      db,
      "session-test",
      makeEvents(30),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );

    expect(bridge.hasPlatformConfig).toHaveBeenCalledTimes(1);
    expect(bridge.maybeForward).not.toHaveBeenCalled();

    vi.doUnmock("../../hooks/platform-bridge.mjs");
  });

  test("no platform.json + many calls: FS probed at most once per TTL window", async () => {
    // No platform.json written — HOME points at a fresh empty temp dir.
    const { loaders, bridge } = await importFresh();
    bridge._internal.resetState();

    const db = makeMockDb();
    for (let n = 0; n < 5; n++) {
      loaders.attributeAndInsertEvents(
        db,
        `session-${n}`,
        makeEvents(10),
        { workspace_roots: ["/tmp/p"] },
        "/tmp/p",
        "PostToolUse",
        resolveAttribs,
      );
    }

    expect(bridge._internal.fsLoads).toBe(1);
  });

  test("TTL invalidation: platform.json removed mid-session halts forwarding after TTL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    const cfgFile = join(fakeHome, ".context-mode", "platform.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        api_key: "ctxm_ttl_test",
        platform_url: "https://example.test/api/v1",
      }),
    );

    const { loaders, bridge } = await importFresh();
    bridge._internal.resetState();

    const db = makeMockDb();

    loaders.attributeAndInsertEvents(
      db,
      "session-before",
      makeEvents(2),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );
    await vi.advanceTimersByTimeAsync(10);

    const beforeRemove = fetchSpy.mock.calls.length;
    expect(beforeRemove).toBe(2);

    rmSync(cfgFile);
    vi.advanceTimersByTime(61_000);

    loaders.attributeAndInsertEvents(
      db,
      "session-after",
      makeEvents(2),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchSpy.mock.calls.length).toBe(beforeRemove);

    vi.useRealTimers();
  });

  test("with valid platform.json, N events triggers N fetch calls", async () => {
    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".context-mode", "platform.json"),
      JSON.stringify({
        api_key: "ctxm_wire_test",
        platform_url: "https://example.test/api/v1",
      }),
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();
    const events = makeEvents(3);

    loaders.attributeAndInsertEvents(
      db,
      "session-test",
      events,
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );

    // Wait for fire-and-forget POSTs to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(db.bulkInsertEvents).toHaveBeenCalledTimes(1);
  });

  test("project attribution: attributions[i].projectDir flows into POST body (sanitized)", async () => {
    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".context-mode", "platform.json"),
      JSON.stringify({
        api_key: "ctxm_proj_test",
        platform_url: "https://example.test/api/v1",
      }),
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();

    // Real resolveProjectAttributions returns objects with camelCase `projectDir`
    // (see src/session/project-attribution.ts:55). The wire must surface that
    // into the POST body so the platform can group events per project.
    const resolveWithProjectDir = (evs: { type: string }[]) =>
      evs.map(() => ({ projectDir: "/Users/realuser/myproj" }));

    loaders.attributeAndInsertEvents(
      db,
      "session-proj",
      makeEvents(1),
      { workspace_roots: ["/Users/realuser/myproj"] },
      "/Users/realuser/myproj",
      "PostToolUse",
      resolveWithProjectDir,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    // Project field MUST be populated (not undefined / null / empty)
    expect(body.project).toBeTruthy();
    // Privacy: username MUST be normalized away
    expect(body.project).not.toContain("realuser");
    // Identity: project basename MUST survive
    expect(body.project).toContain("myproj");
  });

  test("envelope ABI: unknown event fields passthrough to body unchanged", async () => {
    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".context-mode", "platform.json"),
      JSON.stringify({
        api_key: "ctxm_envelope_test",
        platform_url: "https://example.test/api/v1",
      }),
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();

    // Simulate a FUTURE event type that ships brand-new fields the bridge has
    // never seen. The envelope MUST pass them straight through to the platform
    // so adding new fields never requires a bridge release (PRD §5.4 ABI).
    const futureEvent = {
      type: "future_event_type",
      category: "future_cat",
      data: "payload",
      brand_new_field: "should-passthrough",
      nested: { deep: "value" },
      array_field: [1, 2, 3],
    };

    loaders.attributeAndInsertEvents(
      db,
      "sid",
      [futureEvent],
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      (evs: { type: string }[]) => evs.map(() => ({ projectDir: "/tmp/p" })),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);

    // Envelope metadata
    expect(body.platform).toBe("claude-code");
    expect(typeof body.ts).toBe("number");

    // Canonical event fields
    expect(body.type).toBe("future_event_type");
    expect(body.category).toBe("future_cat");
    expect(body.session_id).toBe("sid");

    // Future passthrough — this is the load-bearing invariant.
    expect(body.brand_new_field).toBe("should-passthrough");
    expect(body.nested).toEqual({ deep: "value" });
    expect(body.array_field).toEqual([1, 2, 3]);

    // Anti-regression: legacy hand-mapped fields MUST NOT reappear
    // (server reads canonical names now; hand-mapping was the smell).
    expect(body).not.toHaveProperty("tool");
    expect(body).not.toHaveProperty("session_type");
    expect(body).not.toHaveProperty("session_category");
    expect(body).not.toHaveProperty("session_data");
    expect(body).not.toHaveProperty("error");
  });
});
