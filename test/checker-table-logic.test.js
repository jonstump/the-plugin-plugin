// Unit tests for the pure/dependency-injectable logic in
// scripts/checker-table-logic.js. No Foundry `game`/`foundry` global or DOM
// required.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Checker Table", SPEC-0001 REQ "Pinned Critical
// Modules", SPEC-0001 REQ "Copy Report Button", ADR-0002

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_LABEL_KEYS,
  deriveStatusLabelKey,
  deriveSeverityClass,
  deriveProvenanceInfo,
  isPinned,
  togglePinned,
  resolveIssueLink,
  formatCopyReportSnippet,
} from "../scripts/checker-table-logic.js";

function okPkg(overrides = {}) {
  return {
    id: "pkg",
    title: "Pkg",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    verified: null,
    severity: null,
    possiblyUnmaintained: false,
    links: { url: null, bugs: null, changelog: null },
    status: "ok",
    error: null,
    ...overrides,
  };
}

// --- deriveStatusLabelKey: precedence -------------------------------------

test("deriveStatusLabelKey: couldn't check wins over everything else (error status)", () => {
  const pkg = okPkg({
    status: "error",
    error: { packageId: "pkg", message: "boom" },
    possiblyUnmaintained: true,
    severity: "hard",
    updateAvailable: true,
  });
  assert.equal(deriveStatusLabelKey(pkg), STATUS_LABEL_KEYS.COULDNT_CHECK);
});

test("deriveStatusLabelKey: possibly unmaintained wins over severity and update-available", () => {
  const pkg = okPkg({ possiblyUnmaintained: true, severity: "hard", updateAvailable: true });
  assert.equal(deriveStatusLabelKey(pkg), STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED);
});

test("deriveStatusLabelKey: hard severity maps to the same 'not yet verified' label as soft (no separate hard label in the taxonomy)", () => {
  const hard = okPkg({ severity: "hard", updateAvailable: true });
  const soft = okPkg({ severity: "soft", updateAvailable: true });
  assert.equal(deriveStatusLabelKey(hard), STATUS_LABEL_KEYS.NOT_YET_VERIFIED);
  assert.equal(deriveStatusLabelKey(soft), STATUS_LABEL_KEYS.NOT_YET_VERIFIED);
});

test("deriveStatusLabelKey: update available when no severity/unmaintained flag applies", () => {
  const pkg = okPkg({ updateAvailable: true });
  assert.equal(deriveStatusLabelKey(pkg), STATUS_LABEL_KEYS.UPDATE_AVAILABLE);
});

test("deriveStatusLabelKey: up to date & verified is the default", () => {
  const pkg = okPkg();
  assert.equal(deriveStatusLabelKey(pkg), STATUS_LABEL_KEYS.UP_TO_DATE);
});

test("deriveStatusLabelKey: treats a missing/null package as couldn't check", () => {
  assert.equal(deriveStatusLabelKey(null), STATUS_LABEL_KEYS.COULDNT_CHECK);
  assert.equal(deriveStatusLabelKey(undefined), STATUS_LABEL_KEYS.COULDNT_CHECK);
});

// --- deriveSeverityClass ---------------------------------------------------

test("deriveSeverityClass: passes through 'hard' and 'soft', null otherwise", () => {
  assert.equal(deriveSeverityClass(okPkg({ severity: "hard" })), "hard");
  assert.equal(deriveSeverityClass(okPkg({ severity: "soft" })), "soft");
  assert.equal(deriveSeverityClass(okPkg({ severity: null })), null);
});

test("deriveSeverityClass: null for an errored package regardless of a stale severity field", () => {
  assert.equal(deriveSeverityClass(okPkg({ status: "error", severity: "hard" })), null);
});

// --- deriveProvenanceInfo ---------------------------------------------------
// Requirement: Result Provenance (SPEC-0002 REQ "Result Provenance")

test("deriveProvenanceInfo: null for a declared-sourced package (no marking)", () => {
  assert.equal(deriveProvenanceInfo(okPkg({ provenance: "declared" })), null);
});

test("deriveProvenanceInfo: null when provenance is absent/null (e.g. an error result)", () => {
  assert.equal(deriveProvenanceInfo(okPkg({ provenance: null })), null);
  assert.equal(deriveProvenanceInfo(okPkg({ provenance: undefined })), null);
});

test("deriveProvenanceInfo: null for a missing/null package", () => {
  assert.equal(deriveProvenanceInfo(null), null);
  assert.equal(deriveProvenanceInfo(undefined), null);
});

test("deriveProvenanceInfo: a fallback-sourced package gets a statusClass/iconClass/i18nKey view-model", () => {
  const info = deriveProvenanceInfo(okPkg({ provenance: "fallback" }));
  assert.ok(info);
  assert.equal(info.statusClass, "fallback");
  assert.ok(info.iconClass && info.iconClass.length > 0);
  assert.equal(info.i18nKey, "THE-PLUGIN-PLUGIN.CheckerTable.ProvenanceFallbackNote");
});

test("deriveProvenanceInfo: never calls game/foundry i18n itself — returns a key, not localized text", () => {
  // Governing: this file's docstring — checker-table-logic.js stays
  // dependency-free (no `game`/`foundry` reference), matching
  // deriveStatusLabelKey/deriveSeverityClass. The i18nKey is a
  // THE-PLUGIN-PLUGIN.* localization key, not human-readable prose;
  // checker-table.js is responsible for resolving it via game.i18n.
  const info = deriveProvenanceInfo(okPkg({ provenance: "fallback" }));
  assert.match(info.i18nKey, /^THE-PLUGIN-PLUGIN\./);
});

// --- pin toggle set logic --------------------------------------------------

test("togglePinned: adds a module id that isn't pinned yet", () => {
  const next = togglePinned([], "lib-wrapper");
  assert.deepEqual(next, ["lib-wrapper"]);
});

test("togglePinned: removes a module id that is already pinned", () => {
  const next = togglePinned(["lib-wrapper", "socketlib"], "lib-wrapper");
  assert.deepEqual(next, ["socketlib"]);
});

test("togglePinned: is idempotent-safe (double toggle returns to original membership)", () => {
  const once = togglePinned(["socketlib"], "lib-wrapper");
  const twice = togglePinned(once, "lib-wrapper");
  assert.deepEqual(new Set(twice), new Set(["socketlib"]));
});

test("togglePinned: always returns a plain array, even given a Set as input", () => {
  const next = togglePinned(new Set(["a", "b"]), "c");
  assert.ok(Array.isArray(next));
  assert.deepEqual(new Set(next), new Set(["a", "b", "c"]));
});

test("togglePinned: does not mutate the input array", () => {
  const input = ["a"];
  togglePinned(input, "b");
  assert.deepEqual(input, ["a"]);
});

test("isPinned: true/false for array input", () => {
  assert.equal(isPinned(["a", "b"], "a"), true);
  assert.equal(isPinned(["a", "b"], "z"), false);
});

test("isPinned: true/false for Set input, false for null/undefined", () => {
  assert.equal(isPinned(new Set(["a"]), "a"), true);
  assert.equal(isPinned(null, "a"), false);
  assert.equal(isPinned(undefined, "a"), false);
});

// --- resolveIssueLink -------------------------------------------------------

test("resolveIssueLink: prefers manifest `bugs` field when present", () => {
  const link = resolveIssueLink({ url: "https://github.com/o/r", bugs: "https://example.com/bugs" });
  assert.equal(link, "https://example.com/bugs");
});

test("resolveIssueLink: falls back to <url>/issues when url is a GitHub repo and bugs is absent", () => {
  const link = resolveIssueLink({ url: "https://github.com/o/r", bugs: null });
  assert.equal(link, "https://github.com/o/r/issues");
});

test("resolveIssueLink: strips a trailing slash before appending /issues", () => {
  const link = resolveIssueLink({ url: "https://github.com/o/r/", bugs: null });
  assert.equal(link, "https://github.com/o/r/issues");
});

test("resolveIssueLink: null when bugs is absent and url is not a GitHub repo (never a dead link)", () => {
  assert.equal(resolveIssueLink({ url: "https://example.com/o/r", bugs: null }), null);
});

test("resolveIssueLink: null when links object itself is missing", () => {
  assert.equal(resolveIssueLink(null), null);
  assert.equal(resolveIssueLink(undefined), null);
});

// --- formatCopyReportSnippet ------------------------------------------------

test("formatCopyReportSnippet: includes all five required fields", () => {
  const pkg = { id: "lib-wrapper", installedVersion: "1.12.13" };
  const context = {
    foundryVersion: "13.335",
    foundryBuild: 335,
    systemId: "dnd5e",
    systemTitle: "Dungeons & Dragons 5th Edition",
    systemVersion: "3.1.2",
    userAgent: "Mozilla/5.0 TestAgent",
  };
  const snippet = formatCopyReportSnippet(pkg, context);

  assert.match(snippet, /lib-wrapper/);
  assert.match(snippet, /1\.12\.13/);
  assert.match(snippet, /13\.335/);
  assert.match(snippet, /335/);
  assert.match(snippet, /dnd5e/);
  assert.match(snippet, /3\.1\.2/);
  assert.match(snippet, /Mozilla\/5\.0 TestAgent/);
});

test("formatCopyReportSnippet: falls back to 'unknown' for missing context fields instead of throwing", () => {
  const snippet = formatCopyReportSnippet({ id: "pkg", installedVersion: "1.0.0" }, {});
  assert.doesNotThrow(() => formatCopyReportSnippet({ id: "pkg" }, {}));
  assert.match(snippet, /unknown/);
});

test("formatCopyReportSnippet: is plain text (no HTML/markdown), one field per line", () => {
  const snippet = formatCopyReportSnippet(
    { id: "pkg", installedVersion: "1.0.0" },
    { foundryVersion: "13.335", foundryBuild: 335, systemId: "dnd5e", systemVersion: "3.1.2", userAgent: "UA" }
  );
  const lines = snippet.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(!/[<>]/.test(snippet));
});
