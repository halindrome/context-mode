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
import { buildResumeSnapshot, type StoredEvent } from "../../src/session/snapshot.js";

function makeUserPromptEvent(data: string, isoTimestamp?: string): StoredEvent {
  return {
    type: "user_prompt",
    category: "user-prompt",
    data,
    priority: 1,
    created_at: isoTimestamp ?? new Date().toISOString(),
  };
}

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

// ════════════════════════════════════════════════════════════════════════════
// SLICE 7: blocker — programming-domain markers (language-neutral)
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 7: blocker — programming-domain error markers", () => {
  test('"Error: cannot read property" is a blocker', () => {
    assert.ok(hasBlocker("Error: cannot read property"));
  });

  test('Python "Traceback (most recent call last):" is a blocker', () => {
    assert.ok(hasBlocker("Traceback (most recent call last):"));
  });

  test('Java "Exception: NullPointerException" is a blocker', () => {
    assert.ok(hasBlocker("Exception: NullPointerException at line 42"));
  });

  test('Chinese-localised "Error: 找不到模块" is a blocker', () => {
    // Programming-domain markers like `Error:` are emitted by tooling
    // regardless of the user's native language — they are universal.
    assert.ok(hasBlocker("Error: 找不到模块"));
  });

  test('a plain greeting is NOT a blocker', () => {
    assert.equal(hasBlocker("hello there"), false);
  });

  test('a question is NOT a blocker', () => {
    assert.equal(hasBlocker("why does this fail?"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 8: blocker_resolved — Unicode checkmark / structural marker
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 8: blocker_resolved — Unicode checkmark or marker prefix", () => {
  test('"✅ Fixed the auth bug" is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("✅ Fixed the auth bug"));
  });

  test('"✓ done" (light checkmark) is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("✓ done"));
  });

  test('"🎉 ship it" (emoji celebration) is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("🎉 ship it"));
  });

  test('"fixed: 修复了登录问题" (cross-script marker prefix) is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("fixed: 修复了登录问题"));
  });

  test('"resolved: cache miss in dev" is a resolved blocker', () => {
    assert.ok(hasBlockerResolved("resolved: cache miss in dev"));
  });

  test('a checkmark beats a blocker marker — emits ONLY resolved', () => {
    const events = extractUserEvents("✅ Error: cannot read property (was a stale build)");
    assert.equal(events.filter(e => e.type === "blocker_resolved").length, 1);
    assert.equal(events.filter(e => e.type === "blocker").length, 0);
  });

  test('a message without checkmark/marker is NOT resolved', () => {
    assert.equal(hasBlockerResolved("the bug is back"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE 9: <recent_user_messages> raw-prompt fallback in the snapshot
// ════════════════════════════════════════════════════════════════════════════

describe("Slice 9: recent_user_messages safety-net section", () => {
  test('buildResumeSnapshot renders the last 3 user prompts verbatim', () => {
    const events: StoredEvent[] = [
      makeUserPromptEvent("first prompt that should be dropped"),
      makeUserPromptEvent("второе сообщение"),
      makeUserPromptEvent("第三条消息"),
      makeUserPromptEvent("الرسالة الأخيرة"),
    ];
    const xml = buildResumeSnapshot(events);

    assert.ok(xml.includes("<recent_user_messages"), "should emit the section");
    assert.ok(xml.includes("</recent_user_messages>"), "should close the section");
    assert.ok(xml.includes("второе сообщение"), "should keep Russian prompt");
    assert.ok(xml.includes("第三条消息"), "should keep Chinese prompt");
    assert.ok(xml.includes("الرسالة الأخيرة"), "should keep Arabic prompt");
    assert.ok(!xml.includes("first prompt that should be dropped"), "should drop older prompts");
  });

  test('individual prompts longer than 400 chars are truncated', () => {
    const long = "a".repeat(800);
    const xml = buildResumeSnapshot([makeUserPromptEvent(long)]);
    assert.ok(xml.includes("<recent_user_messages"));
    // The truncated message should be present but shorter than the original.
    const aRuns = xml.match(/a+/g) ?? [];
    const longestRun = aRuns.reduce((m, r) => Math.max(m, r.length), 0);
    assert.ok(
      longestRun <= 400,
      `expected longest run of 'a' ≤ 400, got ${longestRun}`,
    );
  });

  test('no user_prompt events -> section is omitted', () => {
    const xml = buildResumeSnapshot([]);
    assert.equal(xml.includes("<recent_user_messages"), false);
  });
});
