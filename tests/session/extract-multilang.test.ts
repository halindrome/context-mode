/**
 * Multilingual extract-user-events behavior tests.
 *
 * Verifies that universal-rule detectors (structural / Unicode-aware) work
 * for any human language — not just the keyword sets baked into the old
 * keyword arrays. Drives behavior through the public `extractUserEvents`
 * interface so the tests survive any internal refactor.
 *
 * Issue: mksglu/context-mode#535
 */

import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractUserEvents } from "../../src/session/extract.js";
import type { SessionEvent } from "../../src/session/extract.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function findEvent(events: SessionEvent[], type: string): SessionEvent | undefined {
  return events.find(e => e.type === type);
}

function intentMode(message: string): string | undefined {
  const events = extractUserEvents(message);
  return findEvent(events, "intent")?.data;
}

function hasDecision(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "decision"));
}

function hasRole(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "role"));
}

function hasBlocker(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "blocker"));
}

function hasBlockerResolved(message: string): boolean {
  return Boolean(findEvent(extractUserEvents(message), "blocker_resolved"));
}

// ════════════════════════════════════════════════════════════════════════════
// SLICE 1: investigate intent via Unicode question-mark family
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 1: investigate intent — Chinese fullwidth question mark", () => {
  test('"为什么这个 hook 没有触发？" yields mode:"investigate"', () => {
    assert.equal(intentMode("为什么这个 hook 没有触发？"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 2: investigate intent via Arabic question mark
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 2: investigate intent — Arabic question mark U+061F", () => {
  test('"لماذا لم يعمل هذا؟" yields mode:"investigate"', () => {
    assert.equal(intentMode("لماذا لم يعمل هذا؟"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 3: investigate intent via Spanish opening question mark U+00BF
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 3: investigate intent — Spanish opening ¿", () => {
  test('"¿Por qué falla esto?" yields mode:"investigate"', () => {
    assert.equal(intentMode("¿Por qué falla esto?"), "investigate");
  });

  test('opening-only "¿qué hora es" still yields mode:"investigate"', () => {
    // Some users drop the closing mark on chat / mobile keyboards.
    assert.equal(intentMode("¿qué hora es"), "investigate");
  });
});
