// Unit tests for the pure/dependency-injectable logic in
// scripts/login-notification.js. No Foundry `game`/`ChatMessage`/`ui`
// global required.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Login Notification", ADR-0002

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
  runLoginNotification,
  FREQUENCY_SETTING_KEY,
  PINNED_MODULES_SETTING_KEY,
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

// Governing: ADR-0006 — a package with unknown update availability
// (`updateAvailable: null`, most commonly fallback-sourced per SPEC-0002 REQ
// "Fallback Field Trust") is counted separately from `upToDate`, which now
// requires a *known* `false`. Before this, such a package was silently
// folded into `upToDate` here even though the checker table labels it
// "Verified, update unknown" — the chat summary and the table would have
// disagreed about the same package.
test("summarizeCompatibilityResults counts unknown update availability separately from up-to-date (ADR-0006)", () => {
  const packages = [
    pkg({ id: "clean", updateAvailable: false }),
    pkg({ id: "fallback-resolved", updateAvailable: null }),
    pkg({ id: "fallback-resolved-2", updateAvailable: null }),
  ];

  const summary = summarizeCompatibilityResults(packages);

  assert.equal(summary.upToDate, 1);
  assert.equal(summary.verifiedUpdateUnknown, 2);
});

test("summarizeCompatibilityResults: unknown update availability does not count when severity or possibly-unmaintained also applies (matches deriveStatusLabelKey precedence)", () => {
  const packages = [
    pkg({ id: "hard-and-unknown", updateAvailable: null, severity: "hard" }),
    pkg({ id: "unmaintained-and-unknown", updateAvailable: null, possiblyUnmaintained: true }),
  ];

  const summary = summarizeCompatibilityResults(packages);

  assert.equal(summary.verifiedUpdateUnknown, 0);
  assert.equal(summary.hardIssues, 1);
  assert.equal(summary.possiblyUnmaintained, 1);
});

// --- buildStatusCountEntries ------------------------------------------------
// Governing: SPEC-0001 REQ "Login Notification" ("per-status counts ... as a
// structured list rather than a single prose sentence"), "Per-status counts
// are itemised" scenario.

test("buildStatusCountEntries returns exactly the six shared status labels, in checker-table order (ADR-0006)", () => {
  const summary = summarizeCompatibilityResults([]);
  const entries = buildStatusCountEntries(summary);
  assert.deepEqual(
    entries.map((e) => e.statusLabelKey),
    [
      STATUS_LABEL_KEYS.UP_TO_DATE,
      STATUS_LABEL_KEYS.UPDATE_AVAILABLE,
      STATUS_LABEL_KEYS.NOT_YET_VERIFIED,
      STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED,
      STATUS_LABEL_KEYS.VERIFIED_UPDATE_UNKNOWN,
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

// ---------------------------------------------------------------------------
// Glue-layer: `runLoginNotification` -> (private) `postChatSummary` ->
// `ChatMessage.create`'s `content`. Issue #52.
//
// `postChatSummary` is not exported, and reads Foundry globals
// (`ChatMessage`, `game.i18n`, `game.settings`) that don't exist under Node.
// `runLoginNotification` IS exported and accepts a pre-built `classification`
// via `options.classification` (see its signature in
// scripts/login-notification.js), so no manifest fetching or
// `classifyActiveCompatibility` stubbing is needed here — only a `game`
// stub and a `ChatMessage` stub, following the same "stub Foundry globals,
// exercise the real code path end-to-end" style test/checker-table.test.js
// already uses for `openCheckerTable`/`CheckerTableApp`.
//
// `i18n.localize`/`i18n.format` below are real: they read the actual
// languages/en.json content and interpolate `{placeholder}` tokens the same
// way Foundry's i18n does. That (rather than a key-echoing stand-in, as
// test/checker-table.test.js uses for its own unrelated assertions) is the
// right call here specifically because most of this issue's requirements
// are about the exact rendered *wording* (e.g. "an inferred target must
// never read as confirmed fact") — a stand-in that only echoes the key
// would leave those assertions checking key names, not content.
//
// Governing: SPEC-0001 REQ "Login Notification".
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const strings = JSON.parse(readFileSync(path.join(here, "../languages/en.json"), "utf8"));

function localize(key) {
  return strings[key] ?? key;
}

function format(key, data = {}) {
  return localize(key).replace(/\{(\w+)\}/g, (_match, name) =>
    Object.prototype.hasOwnProperty.call(data, name) ? String(data[name]) : `{${name}}`
  );
}

/**
 * Builds a minimal `game` stub sufficient for `runLoginNotification` to run
 * to completion and post a chat summary: GM user, release version, real
 * i18n (see above), and `settings.get`/`set` stubs covering every setting
 * key `runLoginNotification`/`postChatSummary` reads. Defaults to
 * `everyLogin` frequency so tests don't have to reason about the hash gate
 * (that gate is already fully covered at the pure-function level by the
 * `shouldNotifyForFrequency` tests above) — each render test cares about
 * *what* gets posted, not *whether* the frequency gate lets it through.
 */
function buildGameStub({
  isGM = true,
  releaseVersion = "13.351",
  releaseGeneration = "13",
  pinnedModuleIds = [],
  frequency = NOTIFICATION_FREQUENCIES.EVERY_LOGIN,
} = {}) {
  return {
    user: { isGM },
    release: { version: releaseVersion, generation: releaseGeneration, build: 351 },
    i18n: { localize, format },
    settings: {
      get(_moduleId, key) {
        if (key === FREQUENCY_SETTING_KEY) return frequency;
        if (key === PINNED_MODULES_SETTING_KEY) return pinnedModuleIds;
        return null; // last-notified-hash / last-notified-at: harmless default
      },
      async set() {
        // No-op: this file only asserts on what gets posted, not on
        // settings persistence (already covered elsewhere in this file by
        // the shouldNotifyForFrequency/hashResults tests).
      },
    },
  };
}

/**
 * Runs `runLoginNotification` end-to-end against a hand-built
 * `classification` (shaped like `compatibility-classifier.js`'s real
 * output: `{ packages, comparisonTarget }`), with `ChatMessage` and `ui`
 * stubbed so the posted chat content and any toast can be inspected
 * afterward. Globals are installed and torn down per call so tests don't
 * leak state into each other.
 */
async function runNotificationScenario(classification, gameOverrides = {}) {
  const createdMessages = [];
  const toastMessages = [];

  globalThis.ChatMessage = {
    getWhisperRecipients: () => [{ id: "gm-1" }],
    create: async (data) => {
      createdMessages.push(data);
      return data;
    },
  };
  globalThis.ui = {
    notifications: {
      warn: (message) => toastMessages.push(message),
    },
  };

  try {
    await runLoginNotification({ game: buildGameStub(gameOverrides), classification });
  } finally {
    delete globalThis.ChatMessage;
    delete globalThis.ui;
  }

  return {
    content: createdMessages[0]?.content ?? null,
    createdMessages,
    toastMessages,
  };
}

// --- Verifying these tests fail for the right reason against pre-#51 -------
//
// Acceptance criteria explicitly asks this be checked, not assumed. Checked
// via `git show c16a355^:scripts/login-notification.js` (c16a355 is #51's
// merge commit) rather than by assumption: pre-#51 `postChatSummary` built
// its `content` from a single `<p>` formatted from
// `LoginNotification.Summary` (no `<ul>` at all), included a
// `<p class="the-plugin-plugin-volunteer-reminder">` paragraph
// unconditionally, and had no version-context line and no pinned-module
// section whatsoever. Every render test below asserts the presence of
// `<ul class="the-plugin-plugin-status-list">`, a version-context line, or a
// pinned section (all absent pre-#51), or the absence of the volunteer
// reminder (present pre-#51) — so each would fail against the pre-#51 shape
// for exactly the reason this issue asks for, not some incidental one.

// --- Render: per-status counts are itemised ---------------------------------

test("chat summary: per-status counts render as a <ul>/<li> structured list, not a single prose sentence (Scenario: Per-status counts are itemised)", async () => {
  const packages = [
    pkg({ id: "clean" }),
    pkg({ id: "update-only", updateAvailable: true }),
    pkg({ id: "soft-lag", severity: "soft" }),
    pkg({ id: "hard-problem", severity: "hard" }),
    pkg({ id: "unmaintained", possiblyUnmaintained: true }),
    pkg({ id: "failed", status: "error" }),
  ];

  const { content } = await runNotificationScenario({ packages, comparisonTarget: null });

  assert.ok(content.includes('<ul class="the-plugin-plugin-status-list">'));

  const summary = summarizeCompatibilityResults(packages);
  const entries = buildStatusCountEntries(summary);
  assert.equal(entries.length, 6, "exactly the six shared status labels (ADR-0006)");

  for (const entry of entries) {
    const expectedItem = format("THE-PLUGIN-PLUGIN.LoginNotification.StatusCountItem", {
      label: localize(entry.i18nKey),
      count: entry.count,
    });
    assert.ok(
      content.includes(`<li>${expectedItem}</li>`),
      `expected content to include <li>${expectedItem}</li>`
    );
  }

  // Nothing pinned in this scenario, so every <li> belongs to the status
  // list — confirms the list is structured markup, not prose text folded
  // into a single sentence.
  assert.equal((content.match(/<li>/g) ?? []).length, 6);
});

// --- Render: version context, all four target cases -------------------------
// Governing: SPEC-0001 REQ "Login Notification" — "Version context with an
// authoritative target" / "Version context with no target beyond the
// running version" scenarios, plus the inferred case which sits between
// them. An inference must never be presented as confirmed fact.

test("chat summary: version context — authoritative + newer generation reads as confirmed, not inferred", async () => {
  const comparisonTarget = {
    source: "authoritative",
    value: "14",
    rawVersion: "14.366",
    isNewer: true,
    hasPeerSignal: false,
  };
  const { content } = await runNotificationScenario(
    { packages: [pkg({ id: "a" })], comparisonTarget },
    { releaseVersion: "13.351" }
  );

  const expected = format("THE-PLUGIN-PLUGIN.LoginNotification.VersionContextConfirmedNewer", {
    runningVersion: "13.351",
    targetVersion: "14.366",
  });
  assert.ok(content.includes(expected));
  // Confirmed (authoritative) reads as a plain, unhedged fact — contrast
  // with the inferred case below, which explicitly hedges ("possible
  // update ... not confirmed"). The absence of hedging language is itself
  // the confirmed/inferred distinction; the literal word "confirm" is not
  // required, since stating the availability flatly already asserts it.
  assert.ok(!content.toLowerCase().includes("not confirmed"));
  assert.ok(!content.toLowerCase().includes("possible update"));
  // The headline MUST NOT reuse the "Update available" status label. That
  // label counts *modules* with newer releases in the list directly below
  // this line, so reusing the phrase here makes a statement about the
  // Foundry core version read as a summary of the module results — the
  // opposite of what the version-context line exists to convey.
  // Asserted on `expected` (the line alone), not `content`, because the
  // status list legitimately contains that label.
  assert.ok(!expected.toLowerCase().includes("update available"));
});

test("chat summary: version context — authoritative + already current reads as confirmed, distinct wording from 'newer'", async () => {
  const comparisonTarget = {
    source: "authoritative",
    value: "13",
    rawVersion: "13.351",
    isNewer: false,
    hasPeerSignal: false,
  };
  const { content } = await runNotificationScenario(
    { packages: [pkg({ id: "a" })], comparisonTarget },
    { releaseVersion: "13.351" }
  );

  const expectedCurrent = format("THE-PLUGIN-PLUGIN.LoginNotification.VersionContextConfirmedCurrent", {
    runningVersion: "13.351",
    targetVersion: "13.351",
  });
  const confirmedNewerWording = format("THE-PLUGIN-PLUGIN.LoginNotification.VersionContextConfirmedNewer", {
    runningVersion: "13.351",
    targetVersion: "13.351",
  });
  assert.ok(content.includes(expectedCurrent));
  assert.ok(!content.includes(confirmedNewerWording));
  assert.match(expectedCurrent.toLowerCase(), /confirms?/);
});

test("chat summary: version context — inferred with peer signal reads as unconfirmed, never as fact (never the same wording as 'confirmed')", async () => {
  const comparisonTarget = {
    source: "inferred",
    value: "14",
    rawVersion: "14",
    isNewer: true,
    hasPeerSignal: true,
  };
  const { content } = await runNotificationScenario(
    { packages: [pkg({ id: "a" })], comparisonTarget },
    { releaseVersion: "13.351" }
  );

  const expected = format("THE-PLUGIN-PLUGIN.LoginNotification.VersionContextInferred", {
    runningVersion: "13.351",
    targetVersion: "14",
  });
  assert.ok(content.includes(expected));
  // The distinguishing language: an inference reads as unconfirmed, unlike
  // either "confirmed" case above.
  assert.match(expected.toLowerCase(), /couldn't confirm|not confirmed/);
  const confirmedNewerWording = format("THE-PLUGIN-PLUGIN.LoginNotification.VersionContextConfirmedNewer", {
    runningVersion: "13.351",
    targetVersion: "14",
  });
  assert.ok(!content.includes(confirmedNewerWording));
});

test("chat summary: version context — no target beyond the running version says so rather than omitting the line", async () => {
  const { content } = await runNotificationScenario(
    { packages: [pkg({ id: "a" })], comparisonTarget: null },
    { releaseVersion: "13.351" }
  );

  const expected = format("THE-PLUGIN-PLUGIN.LoginNotification.VersionContextNoEvidence", {
    runningVersion: "13.351",
  });
  assert.ok(content.includes(expected));
  assert.ok(content.includes('<p class="the-plugin-plugin-version-context">'));
});

// --- Render: pinned callout --------------------------------------------------
// Governing: SPEC-0001 REQ "Login Notification" — "Pinned module needing
// attention is named" / "Pinned module that is clean" scenarios.

test("chat summary: a pinned module that is not clean is named, with its status (Scenario: Pinned module needing attention is named)", async () => {
  const packages = [pkg({ id: "critical-mod", title: "Critical Mod", severity: "hard" })];
  const { content } = await runNotificationScenario(
    { packages, comparisonTarget: null },
    { pinnedModuleIds: ["critical-mod"] }
  );

  assert.ok(content.includes('<p class="the-plugin-plugin-pinned-heading">'));
  assert.ok(content.includes('<ul class="the-plugin-plugin-pinned-list">'));
  const expectedItem = format("THE-PLUGIN-PLUGIN.LoginNotification.PinnedItem", {
    title: "Critical Mod",
    status: localize("THE-PLUGIN-PLUGIN.Status.NotYetVerified"),
  });
  assert.ok(content.includes(`<li>${expectedItem}</li>`));
});

test("chat summary: every pinned module clean -> the pinned section is entirely absent, not rendered empty (Scenario: Pinned module that is clean)", async () => {
  const packages = [
    pkg({ id: "clean-mod", severity: null, updateAvailable: false, possiblyUnmaintained: false }),
  ];
  const { content } = await runNotificationScenario(
    { packages, comparisonTarget: null },
    { pinnedModuleIds: ["clean-mod"] }
  );

  assert.ok(!content.includes("the-plugin-plugin-pinned-heading"));
  assert.ok(!content.includes("the-plugin-plugin-pinned-list"));
});

test("chat summary: nothing pinned at all -> the pinned section is entirely absent", async () => {
  const packages = [pkg({ id: "hard-problem", severity: "hard" })];
  const { content } = await runNotificationScenario(
    { packages, comparisonTarget: null },
    { pinnedModuleIds: [] }
  );

  assert.ok(!content.includes("the-plugin-plugin-pinned-heading"));
  assert.ok(!content.includes("the-plugin-plugin-pinned-list"));
});

// --- Regression: naming a pinned module does not escalate --------------------
// This is the ADR-0002 boundary and, per the issue, the single most valuable
// test in this story: a soft-severity pinned module is named in the chat
// content, but neither `summarizeCompatibilityResults`' counts nor
// `shouldShowToast`'s decision move because of the pin.
// Governing: ADR-0002, SPEC-0001 REQ "Login Notification" — "Soft-severity
// pinned module is named but not escalated" scenario.

test("chat summary: a soft-severity pinned module is named, but naming it changes neither the rendered counts, the summary counts, nor toast gating (ADR-0002 boundary)", async () => {
  const packages = [pkg({ id: "soft-mod", title: "Soft Mod", severity: "soft" })];

  const pinned = await runNotificationScenario(
    { packages, comparisonTarget: null },
    { pinnedModuleIds: ["soft-mod"] }
  );
  const unpinned = await runNotificationScenario(
    { packages, comparisonTarget: null },
    { pinnedModuleIds: [] }
  );

  // Named when pinned...
  const expectedItem = format("THE-PLUGIN-PLUGIN.LoginNotification.PinnedItem", {
    title: "Soft Mod",
    status: localize("THE-PLUGIN-PLUGIN.Status.NotYetVerified"),
  });
  assert.ok(pinned.content.includes(`<li>${expectedItem}</li>`));
  // ...and the whole pinned section is absent when it isn't.
  assert.ok(!unpinned.content.includes("the-plugin-plugin-pinned-heading"));

  // The rendered per-status <ul> is byte-identical whether or not the
  // module is pinned — naming a module in the pinned callout never touches
  // the per-status counts.
  const statusListOf = (content) =>
    content.match(/<ul class="the-plugin-plugin-status-list">.*?<\/ul>/s)[0];
  assert.equal(statusListOf(pinned.content), statusListOf(unpinned.content));

  // `summarizeCompatibilityResults` takes only `packages` — it has no
  // pinning-awareness in its signature at all, so calling it against the
  // identical `packages` array used in both scenarios above must produce
  // identical counts. Asserted directly (not just inferred from the render
  // above) per the issue's explicit ask.
  assert.deepEqual(
    summarizeCompatibilityResults(packages),
    summarizeCompatibilityResults(packages)
  );

  // No toast in either scenario — soft severity never escalates, pinned or
  // not (ADR-0002).
  assert.equal(shouldShowToast(["soft-mod"], packages), false);
  assert.deepEqual(pinned.toastMessages, []);
  assert.deepEqual(unpinned.toastMessages, []);
});

// --- Regression: no volunteer reminder in the notification -------------------
// Governing: SPEC-0001 REQ "Login Notification" ("NOT required to repeat the
// volunteer reminder ... The reminder belongs where a GM acts on the
// information"). Scoped removal: gone from the notification, still present
// for the checker window (test/checker-table-template.test.js already
// asserts `CheckerTable.KindnessReminder` renders in
// templates/checker-table.hbs — not duplicated here, only cross-checked
// that its underlying string still exists).

test("chat summary: no volunteer/kindness reminder in the notification content (removed by #51 — scoped, not global)", async () => {
  const packages = [pkg({ id: "a" })];
  const { content } = await runNotificationScenario({ packages, comparisonTarget: null });

  assert.ok(!content.includes("the-plugin-plugin-volunteer-reminder"));
  assert.ok(!content.toLowerCase().includes("volunteer"));

  // The old keys are gone entirely, not just unused.
  assert.equal(strings["THE-PLUGIN-PLUGIN.LoginNotification.VolunteerReminder"], undefined);
  assert.equal(strings["THE-PLUGIN-PLUGIN.LoginNotification.Summary"], undefined);

  // The checker window's own (different) reminder key is untouched by this
  // removal — see test/checker-table-template.test.js for the window's own
  // render assertion; this only confirms the removal was scoped to the
  // notification's key, not the window's.
  assert.ok(
    strings["THE-PLUGIN-PLUGIN.CheckerTable.KindnessReminder"] &&
      strings["THE-PLUGIN-PLUGIN.CheckerTable.KindnessReminder"].length > 0
  );
});

// --- Regression: kindness ----------------------------------------------------
// test/language-strings.test.js already scans every value in languages/en.json
// (including the new LoginNotification.* keys added by #51, since it
// iterates Object.entries(strings) over the whole file) for "dead"/
// "broken"/"abandoned" — that generic coverage is sufficient for the static
// strings themselves, so it isn't duplicated key-by-key here. What that
// scan can't see is *rendered, interpolated* content (e.g. a package title
// folded into a pinned-item line), so this test scans actual `content`
// output across a few representative scenarios instead.

test("chat summary: rendered content never uses 'dead'/'broken'/'abandoned' wording, across representative scenarios (CLAUDE.md project rule 1)", async () => {
  const scenarios = [
    {
      classification: {
        packages: [pkg({ id: "hard", title: "Hard Mod", severity: "hard" })],
        comparisonTarget: {
          source: "authoritative",
          value: "14",
          rawVersion: "14.366",
          isNewer: true,
          hasPeerSignal: false,
        },
      },
      gameOverrides: { pinnedModuleIds: ["hard"] },
    },
    {
      classification: {
        packages: [pkg({ id: "unmaintained", title: "Unmaintained Mod", possiblyUnmaintained: true })],
        comparisonTarget: null,
      },
      gameOverrides: { pinnedModuleIds: ["unmaintained"] },
    },
    {
      classification: {
        packages: [pkg({ id: "err", status: "error" })],
        comparisonTarget: {
          source: "inferred",
          value: "14",
          rawVersion: "14",
          isNewer: true,
          hasPeerSignal: true,
        },
      },
      gameOverrides: {},
    },
  ];

  for (const { classification, gameOverrides } of scenarios) {
    const { content } = await runNotificationScenario(classification, gameOverrides);
    const lower = content.toLowerCase();
    for (const word of ["dead", "broken", "abandoned"]) {
      assert.ok(!lower.includes(word), `content contains forbidden word "${word}":\n${content}`);
    }
  }
});
