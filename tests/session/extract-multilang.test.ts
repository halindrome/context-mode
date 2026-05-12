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

// ════════════════════════════════════════════════════════════════════════════
// SLICE 4: implement intent — short directive without a question mark
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 4: implement intent — short imperative across scripts", () => {
  test('English "add login page" yields mode:"implement"', () => {
    assert.equal(intentMode("add login page"), "implement");
  });

  test('mixed Japanese/Latin "登录页面を作って" yields mode:"implement"', () => {
    assert.equal(intentMode("登录页面を作って"), "implement");
  });

  test('Spanish "crear página de inicio" yields mode:"implement"', () => {
    assert.equal(intentMode("crear página de inicio"), "implement");
  });

  test('Turkish "giriş sayfası ekle" yields mode:"implement"', () => {
    assert.equal(intentMode("giriş sayfası ekle"), "implement");
  });

  test('a long paragraph without `?` does NOT yield implement (too discursive)', () => {
    // 80+ chars of running text should fall through, not be classified.
    const longRun =
      "We have been discussing this architecture for a while now and there is a lot to unpack here.";
    assert.notEqual(intentMode(longRun), "implement");
  });

  test('a message ending with `?` yields investigate not implement', () => {
    assert.equal(intentMode("add login page?"), "investigate");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 5: decision — language-agnostic via negation/alternation structure
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 5: decision — universal negation+alternative pattern", () => {
  test('English "don\'t use useState, use useReducer instead" is a decision', () => {
    assert.ok(hasDecision("don't use useState, use useReducer instead"));
  });

  test('Russian "не используй X, используй Y вместо" is a decision', () => {
    assert.ok(hasDecision("не используй X, используй Y вместо"));
  });

  test('Chinese "不要用 setState，用 useReducer" is a decision', () => {
    assert.ok(hasDecision("不要用 setState，用 useReducer"));
  });

  test('Turkish "useState kullanma, useReducer kullan" is a decision', () => {
    assert.ok(hasDecision("useState kullanma, useReducer kullan"));
  });

  test('a plain question is NOT a decision', () => {
    assert.equal(hasDecision("what time is it?"), false);
  });

  test('a single-word noun is NOT a decision', () => {
    assert.equal(hasDecision("test"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 6: role — structural persona statement across scripts
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 6: role — second-person persona statements across scripts", () => {
  test('English "You are a senior backend engineer" is a role', () => {
    assert.ok(hasRole("You are a senior backend engineer"));
  });

  test('French "Tu es un développeur senior" is a role', () => {
    assert.ok(hasRole("Tu es un développeur senior"));
  });

  test('Japanese "あなたは経験豊富なエンジニアです" is a role', () => {
    assert.ok(hasRole("あなたは経験豊富なエンジニアです"));
  });

  test('Turkish "Sen kıdemli bir backend mühendisisin" is a role', () => {
    assert.ok(hasRole("Sen kıdemli bir backend mühendisisin"));
  });

  test('a question is NOT a role', () => {
    assert.equal(hasRole("what time is it?"), false);
  });

  test('a long discursive paragraph is NOT a role', () => {
    const longRun =
      "We have been discussing this architecture for a while and there are several trade-offs to weigh before committing to any single approach right now.";
    assert.equal(hasRole(longRun), false);
  });
});
