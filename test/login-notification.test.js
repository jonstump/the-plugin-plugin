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
  buildStatusCountEntries,
  deriveVersionContext,
  VERSION_CONTEXT_CASES,
  buildPinnedCallout,
  NOTIFICATION_FREQUENCIES,
} from "../scripts/login-notification.js";
import { STATUS_LABEL_KEYS } from "../scripts/checker-table-logic.js";

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

// --- hashResults: pinned-ids and comparisonTarget coverage (issue #51) -----
// Governing: SPEC-0001 REQ "Login Notification" acceptance criteria —
// "hashResults still covers everything the message reports, so 'only when
// changed' does not go stale against the new content."

test("hashResults changes when the pinned-ids set changes, even though no package field changed", () => {
  const packages = [pkg({ id: "a", severity: "soft" })];
  const before = hashResults(packages, { pinnedModuleIds: [] });
  const after = hashResults(packages, { pinnedModuleIds: ["a"] });
  assert.notEqual(before, after);
});

test("hashResults is stable regardless of pinned-ids array order", () => {
  const packages = [pkg({ id: "a" })];
  const a = hashResults(packages, { pinnedModuleIds: ["x", "y"] });
  const b = hashResults(packages, { pinnedModuleIds: ["y", "x"] });
  assert.equal(a, b);
});

test("hashResults accepts a Set of pinned ids, equivalent to an array", () => {
  const packages = [pkg({ id: "a" })];
  const withArray = hashResults(packages, { pinnedModuleIds: ["a", "b"] });
  const withSet = hashResults(packages, { pinnedModuleIds: new Set(["a", "b"]) });
  assert.equal(withArray, withSet);
});

test("hashResults defaults to an empty pinned-ids set when the option is omitted (backward compatible)", () => {
  const packages = [pkg({ id: "a" })];
  assert.equal(hashResults(packages), hashResults(packages, { pinnedModuleIds: [] }));
});

test("hashResults changes when comparisonTarget's source flips from inferred to authoritative, even with identical packages and pins", () => {
  const packages = [pkg({ id: "a", severity: "soft" })];
  const inferred = hashResults(packages, {
    comparisonTarget: { source: "inferred", value: "14", rawVersion: "14", isNewer: true, hasPeerSignal: true },
  });
  const authoritative = hashResults(packages, {
    comparisonTarget: { source: "authoritative", value: "14", rawVersion: "14.366", isNewer: true, hasPeerSignal: false },
  });
  assert.notEqual(inferred, authoritative);
});

test("hashResults is identical for a logically identical comparisonTarget object regardless of key order", () => {
  const packages = [pkg({ id: "a" })];
  const a = hashResults(packages, {
    comparisonTarget: { source: "authoritative", rawVersion: "14.366", isNewer: true, hasPeerSignal: false, value: "14" },
  });
  const b = hashResults(packages, {
    comparisonTarget: { value: "14", hasPeerSignal: false, isNewer: true, rawVersion: "14.366", source: "authoritative" },
  });
  assert.equal(a, b);
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

// --- buildStatusCountEntries ------------------------------------------------
// Governing: SPEC-0001 REQ "Login Notification" ("per-status counts ... as a
// structured list rather than a single prose sentence"), "Per-status counts
// are itemised" scenario.

test("buildStatusCountEntries returns exactly the five shared status labels, in checker-table order", () => {
  const summary = summarizeCompatibilityResults([]);
  const entries = buildStatusCountEntries(summary);
  assert.deepEqual(
    entries.map((e) => e.statusLabelKey),
    [
      STATUS_LABEL_KEYS.UP_TO_DATE,
      STATUS_LABEL_KEYS.UPDATE_AVAILABLE,
      STATUS_LABEL_KEYS.NOT_YET_VERIFIED,
      STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED,
      STATUS_LABEL_KEYS.COULDNT_CHECK,
    ]
  );
});

test("buildStatusCountEntries folds hardIssues and softIssues into the single notYetVerified count (no re-tally, just regrouping)", () => {
  const packages = [
    pkg({ id: "clean" }),
    pkg({ id: "soft-lag", severity: "soft" }),
    pkg({ id: "hard-problem", severity: "hard" }),
  ];
  const summary = summarizeCompatibilityResults(packages);
  const entries = buildStatusCountEntries(summary);
  const notYetVerified = entries.find((e) => e.statusLabelKey === STATUS_LABEL_KEYS.NOT_YET_VERIFIED);
  assert.equal(notYetVerified.count, 2);
});

test("buildStatusCountEntries maps every summary field to its matching entry's count", () => {
  const packages = [
    pkg({ id: "clean" }),
    pkg({ id: "update-only", updateAvailable: true }),
    pkg({ id: "unmaintained", possiblyUnmaintained: true }),
    pkg({ id: "failed", status: "error" }),
  ];
  const summary = summarizeCompatibilityResults(packages);
  const entries = buildStatusCountEntries(summary);
  const countFor = (key) => entries.find((e) => e.statusLabelKey === key).count;
  assert.equal(countFor(STATUS_LABEL_KEYS.UP_TO_DATE), summary.upToDate);
  assert.equal(countFor(STATUS_LABEL_KEYS.UPDATE_AVAILABLE), summary.updatesAvailable);
  assert.equal(countFor(STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED), summary.possiblyUnmaintained);
  assert.equal(countFor(STATUS_LABEL_KEYS.COULDNT_CHECK), summary.couldntCheck);
});

// --- deriveVersionContext ---------------------------------------------------
// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Login
// Notification" — "Version context with an authoritative target" / "Version
// context with no target beyond the running version" scenarios.

test("deriveVersionContext: authoritative + newer generation -> confirmedNewer, carrying the raw target version", () => {
  const result = deriveVersionContext({
    source: "authoritative",
    rawVersion: "14.366",
    isNewer: true,
    hasPeerSignal: false,
  });
  assert.equal(result.case, VERSION_CONTEXT_CASES.CONFIRMED_NEWER);
  assert.equal(result.targetVersion, "14.366");
});

test("deriveVersionContext: authoritative + already current -> confirmedCurrent, distinct from confirmedNewer", () => {
  const result = deriveVersionContext({
    source: "authoritative",
    rawVersion: "13.351",
    isNewer: false,
    hasPeerSignal: false,
  });
  assert.equal(result.case, VERSION_CONTEXT_CASES.CONFIRMED_CURRENT);
  assert.notEqual(result.case, VERSION_CONTEXT_CASES.CONFIRMED_NEWER);
});

test("deriveVersionContext: inferred with peer signal -> inferred, carrying the inferred target version", () => {
  const result = deriveVersionContext({
    source: "inferred",
    rawVersion: "14",
    isNewer: true,
    hasPeerSignal: true,
  });
  assert.equal(result.case, VERSION_CONTEXT_CASES.INFERRED);
  assert.equal(result.targetVersion, "14");
});

test("deriveVersionContext: inferred with no peer evidence -> noEvidence, with no target version to show", () => {
  const result = deriveVersionContext({
    source: "inferred",
    rawVersion: null,
    isNewer: false,
    hasPeerSignal: false,
  });
  assert.equal(result.case, VERSION_CONTEXT_CASES.NO_EVIDENCE);
  assert.equal(result.targetVersion, null);
});

test("deriveVersionContext: a null comparisonTarget (no classification yet) is treated as noEvidence, not omitted", () => {
  const result = deriveVersionContext(null);
  assert.equal(result.case, VERSION_CONTEXT_CASES.NO_EVIDENCE);
  assert.equal(result.targetVersion, null);
});

// --- buildPinnedCallout -----------------------------------------------------
// Governing: SPEC-0001 REQ "Login Notification" — "Pinned module needing
// attention is named" / "Pinned module that is clean" / "Soft-severity
// pinned module is named but not escalated" scenarios.

test("buildPinnedCallout: names a pinned module whose status is not Up to date & verified", () => {
  const packages = [pkg({ id: "critical-mod", title: "Critical Mod", severity: "hard" })];
  const entries = buildPinnedCallout(["critical-mod"], packages);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "critical-mod");
  assert.equal(entries[0].title, "Critical Mod");
  assert.equal(entries[0].statusLabelKey, STATUS_LABEL_KEYS.NOT_YET_VERIFIED);
});

test("buildPinnedCallout: omits a pinned module whose status is Up to date & verified", () => {
  const packages = [pkg({ id: "clean-mod", severity: null, updateAvailable: false })];
  const entries = buildPinnedCallout(["clean-mod"], packages);
  assert.deepEqual(entries, []);
});

test("buildPinnedCallout: returns an empty list (section omitted) when no module is pinned", () => {
  const packages = [pkg({ id: "hard-problem", severity: "hard" })];
  assert.deepEqual(buildPinnedCallout([], packages), []);
  assert.deepEqual(buildPinnedCallout(undefined, packages), []);
});

test("buildPinnedCallout: names a soft-severity pinned module (naming it does not require hard severity)", () => {
  const packages = [pkg({ id: "soft-mod", severity: "soft" })];
  const entries = buildPinnedCallout(["soft-mod"], packages);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].statusLabelKey, STATUS_LABEL_KEYS.NOT_YET_VERIFIED);
});

test("buildPinnedCallout: only names the pinned modules, never an unpinned one with the same issue", () => {
  const packages = [
    pkg({ id: "pinned-hard", severity: "hard" }),
    pkg({ id: "unpinned-hard", severity: "hard" }),
  ];
  const entries = buildPinnedCallout(["pinned-hard"], packages);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["pinned-hard"]
  );
});

test("buildPinnedCallout: accepts a Set of pinned ids as well as an array", () => {
  const packages = [pkg({ id: "critical-mod", severity: "hard" })];
  const entries = buildPinnedCallout(new Set(["critical-mod"]), packages);
  assert.equal(entries.length, 1);
});

test("buildPinnedCallout: falls back to id when a package has no title", () => {
  const packages = [{ ...pkg({ id: "no-title-mod", severity: "hard" }), title: undefined }];
  const entries = buildPinnedCallout(["no-title-mod"], packages);
  assert.equal(entries[0].title, "no-title-mod");
});
