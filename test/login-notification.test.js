// Unit tests for the pure/dependency-injectable logic in
// scripts/login-notification.js. No Foundry `game`/`ChatMessage`/`ui`
// global required.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Login Notification", ADR-0002

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fnv1aHash,
  stableStringify,
  hashResults,
  shouldNotifyForFrequency,
  shouldShowToast,
  summarizeCompatibilityResults,
  NOTIFICATION_FREQUENCIES,
} from "../scripts/login-notification.js";

function pkg(overrides = {}) {
  return {
    id: "pkg",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    verified: "13",
    severity: null,
    possiblyUnmaintained: false,
    status: "ok",
    ...overrides,
  };
}

// --- fnv1aHash / stableStringify -------------------------------------------

test("fnv1aHash is deterministic for the same input", () => {
  assert.equal(fnv1aHash("hello"), fnv1aHash("hello"));
});

test("fnv1aHash differs for different input", () => {
  assert.notEqual(fnv1aHash("hello"), fnv1aHash("world"));
});

test("stableStringify produces identical output regardless of key order", () => {
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
});

test("stableStringify sorts nested arrays of objects consistently", () => {
  const a = [{ y: 1, x: 2 }, { x: 3, y: 4 }];
  const b = [{ x: 2, y: 1 }, { y: 4, x: 3 }];
  assert.equal(stableStringify(a), stableStringify(b));
});

// --- hashResults -------------------------------------------------------

test("hashResults is stable regardless of package array order", () => {
  const a = [pkg({ id: "a" }), pkg({ id: "b", severity: "soft" })];
  const b = [pkg({ id: "b", severity: "soft" }), pkg({ id: "a" })];
  assert.equal(hashResults(a), hashResults(b));
});

test("hashResults changes when a package's severity changes", () => {
  const before = [pkg({ id: "a", severity: null })];
  const after = [pkg({ id: "a", severity: "hard" })];
  assert.notEqual(hashResults(before), hashResults(after));
});

test("hashResults changes when possiblyUnmaintained changes", () => {
  const before = [pkg({ id: "a", possiblyUnmaintained: false })];
  const after = [pkg({ id: "a", possiblyUnmaintained: true })];
  assert.notEqual(hashResults(before), hashResults(after));
});

test("hashResults is identical for logically identical results", () => {
  const a = [pkg({ id: "a" }), pkg({ id: "b" })];
  const b = [pkg({ id: "a" }), pkg({ id: "b" })];
  assert.equal(hashResults(a), hashResults(b));
});

test("hashResults changes when a soft-severity package's data changes (open design question resolved: hash covers all severities, not just hard)", () => {
  const before = [pkg({ id: "a", severity: "soft" })];
  const after = [pkg({ id: "a", severity: null })];
  assert.notEqual(hashResults(before), hashResults(after));
});

// --- shouldNotifyForFrequency -------------------------------------------

test("everyLogin always notifies, regardless of hash or last-notified time", () => {
  const now = Date.now();
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.EVERY_LOGIN, {
      currentHash: "abc",
      storedHash: "abc",
      lastNotifiedAt: now,
      now,
    }),
    true
  );
});

test("onlyWhenChanged notifies when hash differs from stored hash", () => {
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.ONLY_WHEN_CHANGED, {
      currentHash: "abc",
      storedHash: "def",
    }),
    true
  );
});

test("onlyWhenChanged does not notify when hash matches stored hash", () => {
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.ONLY_WHEN_CHANGED, {
      currentHash: "abc",
      storedHash: "abc",
    }),
    false
  );
});

test("onlyWhenChanged notifies on first-ever check (no stored hash yet)", () => {
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.ONLY_WHEN_CHANGED, {
      currentHash: "abc",
      storedHash: null,
    }),
    true
  );
});

test("onlyWhenChanged is the default frequency (falls back for unknown values)", () => {
  assert.equal(
    shouldNotifyForFrequency("some-unrecognized-value", {
      currentHash: "abc",
      storedHash: "abc",
    }),
    false
  );
});

test("daily notifies on first-ever notification (no lastNotifiedAt yet)", () => {
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.DAILY, {
      currentHash: "abc",
      lastNotifiedAt: null,
      now: Date.now(),
    }),
    true
  );
});

test("daily does not notify again on the same calendar day", () => {
  const lastNotifiedAt = new Date(2026, 7, 15, 8, 0, 0).getTime(); // Aug 15, 08:00
  const now = new Date(2026, 7, 15, 20, 0, 0).getTime(); // Aug 15, 20:00
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.DAILY, {
      currentHash: "abc",
      lastNotifiedAt,
      now,
    }),
    false
  );
});

test("daily notifies again once the calendar day has changed", () => {
  const lastNotifiedAt = new Date(2026, 7, 15, 8, 0, 0).getTime(); // Aug 15
  const now = new Date(2026, 7, 16, 0, 5, 0).getTime(); // Aug 16, just after midnight
  assert.equal(
    shouldNotifyForFrequency(NOTIFICATION_FREQUENCIES.DAILY, {
      currentHash: "abc",
      lastNotifiedAt,
      now,
    }),
    true
  );
});

// --- shouldShowToast (ADR-0002 enforcement point) -------------------------

test("shouldShowToast: pinned module with hard severity -> toast", () => {
  const packages = [pkg({ id: "critical-mod", severity: "hard" })];
  assert.equal(shouldShowToast(["critical-mod"], packages), true);
});

test("shouldShowToast: pinned module with ONLY soft severity -> never toasts (critical ADR-0002 case)", () => {
  const packages = [pkg({ id: "critical-mod", severity: "soft" })];
  assert.equal(shouldShowToast(["critical-mod"], packages), false);
});

test("shouldShowToast: pinned module flagged possibly unmaintained -> toast", () => {
  const packages = [
    pkg({ id: "critical-mod", severity: null, possiblyUnmaintained: true }),
  ];
  assert.equal(shouldShowToast(["critical-mod"], packages), true);
});

test("shouldShowToast: unpinned module with hard severity -> never toasts", () => {
  const packages = [pkg({ id: "some-other-mod", severity: "hard" })];
  assert.equal(shouldShowToast(["critical-mod"], packages), false);
});

test("shouldShowToast: no pinned modules at all -> never toasts", () => {
  const packages = [pkg({ id: "critical-mod", severity: "hard" })];
  assert.equal(shouldShowToast([], packages), false);
  assert.equal(shouldShowToast(new Set(), packages), false);
  assert.equal(shouldShowToast(undefined, packages), false);
});

test("shouldShowToast: pinned module with no issues -> no toast", () => {
  const packages = [pkg({ id: "critical-mod", severity: null })];
  assert.equal(shouldShowToast(["critical-mod"], packages), false);
});

test("shouldShowToast: accepts a Set of pinned ids as well as an array", () => {
  const packages = [pkg({ id: "critical-mod", severity: "hard" })];
  assert.equal(shouldShowToast(new Set(["critical-mod"]), packages), true);
});

test("shouldShowToast: multiple pinned modules, only one with a qualifying issue -> toast", () => {
  const packages = [
    pkg({ id: "fine-mod", severity: null }),
    pkg({ id: "soft-mod", severity: "soft" }),
    pkg({ id: "hard-mod", severity: "hard" }),
  ];
  assert.equal(shouldShowToast(["fine-mod", "soft-mod", "hard-mod"], packages), true);
});

// --- summarizeCompatibilityResults -----------------------------------------

test("summarizeCompatibilityResults tallies each category correctly", () => {
  const packages = [
    pkg({ id: "clean" }), // up to date
    pkg({ id: "update-only", updateAvailable: true }),
    pkg({ id: "soft-lag", severity: "soft" }),
    pkg({ id: "hard-problem", severity: "hard" }),
    pkg({ id: "unmaintained", possiblyUnmaintained: true }),
    pkg({ id: "failed", status: "error" }),
  ];

  const summary = summarizeCompatibilityResults(packages);

  assert.equal(summary.total, 6);
  assert.equal(summary.upToDate, 1);
  assert.equal(summary.updatesAvailable, 1);
  assert.equal(summary.softIssues, 1);
  assert.equal(summary.hardIssues, 1);
  assert.equal(summary.possiblyUnmaintained, 1);
  assert.equal(summary.couldntCheck, 1);
});

test("summarizeCompatibilityResults handles an empty package list", () => {
  const summary = summarizeCompatibilityResults([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.upToDate, 0);
});
