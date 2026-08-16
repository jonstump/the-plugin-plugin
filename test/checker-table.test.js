// Tests for the GM-only visibility gate in scripts/checker-table.js's
// `openCheckerTable` entry point (SPEC-0001 "Non-GM user" scenario: "the
// system does not render the window for that user"). Everything else in
// this file (status/pin/link/copy-report logic) is already covered by
// test/checker-table-logic.test.js from issue #8's own PR — this file adds
// only the one thing that wasn't yet tested: the GM gate itself.
//
// scripts/checker-table.js destructures `foundry.applications.api` at
// module scope (so `CheckerTableApp` can `extends
// HandlebarsApplicationMixin(ApplicationV2)`), which would throw at import
// time under Node without a `foundry` global. A minimal stand-in is
// installed on `globalThis.foundry` below, before a dynamic `import()` (a
// static top-of-file import would run before this test file's own code
// does, too late to install the stub). `openCheckerTable` gates on
// `game.user.isGM` before ever constructing `CheckerTableApp`, so the stub
// only needs to be import-safe, not functionally complete — none of these
// tests exercise a constructed instance.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Checker Table"

import { test } from "node:test";
import assert from "node:assert/strict";

// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
// Determination", SPEC-0001 REQ "Inferred Latest Version" — issue #37. The
// `render` hook below is a mutable outer binding (`onNextRender`) rather
// than baked into a fresh stub per test, because `CheckerTableApp extends
// HandlebarsApplicationMixin(ApplicationV2)` resolves `foundry.applications.api`
// at class-definition time, i.e. on this file's *first* dynamic `import()`
// below — reassigning `globalThis.foundry` afterwards would not reach the
// already-defined class. `onNextRender` lets later tests (issue #37,
// "Comparison target view-model mapping" section) observe when
// `CheckerTableApp#render` fires without needing to redefine the stub.
let onNextRender = null;

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        // Minimal stand-in for ApplicationV2's own context-prep step,
        // which `CheckerTableApp#_prepareContext` extends via `super`.
        async _prepareContext() {
          return {};
        }
        render(...args) {
          onNextRender?.();
          return this;
        }
      },
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

const { openCheckerTable, CheckerTableApp } = await import("../scripts/checker-table.js");

test("openCheckerTable: resolves to null for a non-GM user", async () => {
  globalThis.game = { user: { isGM: false } };
  try {
    const result = await openCheckerTable();
    assert.equal(result, null);
  } finally {
    delete globalThis.game;
  }
});

test("openCheckerTable: resolves to null and does not throw when game.user is missing", async () => {
  globalThis.game = {};
  try {
    await assert.doesNotReject(() => openCheckerTable());
    assert.equal(await openCheckerTable(), null);
  } finally {
    delete globalThis.game;
  }
});

test("openCheckerTable: resolves to null and does not throw when game itself is missing", async () => {
  delete globalThis.game;
  await assert.doesNotReject(() => openCheckerTable());
  assert.equal(await openCheckerTable(), null);
});

// ---------------------------------------------------------------------------
// Comparison target view-model mapping (issue #37, companion to issue #36).
//
// `#buildComparisonTargetContext` (scripts/checker-table.js) is a private
// (`#`) method, so it cannot be invoked directly by name from this file. It
// is exercised here through `CheckerTableApp`'s actual public rendering
// entry point, `_prepareContext`, the same way a real render cycle would
// reach it — not by reimplementing or reaching around the private method.
//
// `_prepareContext` kicks off an unawaited scan (`#startScan`) the first
// time it's called on a fresh instance, so its *first* call always observes
// `comparisonTarget: null` (the "unknown/no target yet" state — see the
// dedicated test below) before that scan has had a chance to resolve. A
// *second* call, made after the scan settles, observes whatever
// `comparisonTarget` state the scan produced. `runComparisonTargetScenario`
// below drives exactly that two-call sequence, using the `onNextRender` hook
// (declared at the top of this file) to detect when the scan's
// fire-and-forget `this.render()` fires, i.e. when it's safe to call
// `_prepareContext` again.
//
// Every scenario's `game.modules` is either empty or (for the "inferred,
// peer signal present" scenario) backed by a stubbed `globalThis.fetch` —
// never a real network request — matching the "no browser test runner, keep
// assertions on pure logic / compiled output" guidance for this issue.
//
// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
// Determination", SPEC-0001 REQ "Inferred Latest Version".

/**
 * @param {(game: object) => void} configureGame - mutates the default
 *   `game` stub (release/coreUpdate/modules/etc.) for one scenario.
 * @returns {Promise<{firstContext: object, secondContext: object}>}
 *   `firstContext` is always pre-scan (`comparisonTarget: null`);
 *   `secondContext` is captured once the scan has resolved.
 */
async function runComparisonTargetScenario(configureGame) {
  let resolveRendered;
  const rendered = new Promise((resolve) => {
    resolveRendered = resolve;
  });
  onNextRender = resolveRendered;

  globalThis.game = {
    user: { isGM: true },
    release: { generation: "13", version: "13.351", build: 351 },
    modules: [],
    data: {},
    settings: { get: () => undefined, set: async () => {} },
    i18n: {
      localize: (key) => key,
      // Test-only stand-in for Foundry's `format` — echoes the key and JSON
      // -serializes the interpolation data so assertions can check both
      // "which key was used" and "which version was interpolated" without
      // needing the real translated strings from languages/en.json (already
      // covered by the localization tests in test/language-strings.test.js).
      format: (key, data) => `${key}|${JSON.stringify(data ?? {})}`,
    },
  };
  configureGame(globalThis.game);

  const originalFetch = globalThis.fetch;
  try {
    const instance = new CheckerTableApp();

    const firstContext = await instance._prepareContext({});
    await rendered;
    const secondContext = await instance._prepareContext({});

    return { firstContext, secondContext };
  } finally {
    globalThis.fetch = originalFetch;
    onNextRender = null;
    delete globalThis.game;
  }
}

test("comparisonTarget: null (unknown/no target yet) before the first scan has resolved", async () => {
  const { firstContext } = await runComparisonTargetScenario((game) => {
    // No coreUpdate, no modules — irrelevant to this assertion; only the
    // pre-scan snapshot is checked.
  });
  assert.equal(firstContext.comparisonTarget, null);
});

test("comparisonTarget: authoritative + newer generation available maps to the 'confirmed' view-model", async () => {
  const { secondContext } = await runComparisonTargetScenario((game) => {
    game.data.coreUpdate = { couldReachWebsite: true, version: "14.366" };
    game.release = { generation: "13", version: "13.351", build: 351 };
  });
  assert.deepEqual(secondContext.comparisonTarget.statusClass, "confirmed");
  assert.deepEqual(secondContext.comparisonTarget.iconClass, "fa-circle-check");
  assert.ok(
    secondContext.comparisonTarget.note.startsWith(
      "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedNewer"
    )
  );
  assert.ok(secondContext.comparisonTarget.note.includes("14.366"));
});

test("comparisonTarget: authoritative + already current maps to the 'confirmed' view-model with different wording", async () => {
  const { secondContext } = await runComparisonTargetScenario((game) => {
    game.data.coreUpdate = { couldReachWebsite: true, version: "13.351" };
    game.release = { generation: "13", version: "13.351", build: 351 };
  });
  assert.deepEqual(secondContext.comparisonTarget.statusClass, "confirmed");
  assert.deepEqual(secondContext.comparisonTarget.iconClass, "fa-circle-check");
  assert.ok(
    secondContext.comparisonTarget.note.startsWith(
      "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedCurrent"
    )
  );
  // Different key from the "newer" scenario above — an inference is never
  // presented with the same wording as a confirmed-current state, and vice
  // versa.
  assert.ok(
    !secondContext.comparisonTarget.note.startsWith(
      "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedNewer"
    )
  );
});

test("comparisonTarget: inferred with peer signal maps to the 'inferred' view-model, distinct from 'confirmed'", async () => {
  const { secondContext } = await runComparisonTargetScenario((game) => {
    // No game.data.coreUpdate at all — falls through to peer inference.
    game.modules = [
      {
        id: "peer-pkg",
        title: "Peer Package",
        active: true,
        version: "1.0.0",
        manifest: "https://example.com/peer/module.json",
      },
    ];
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "1.1.0", compatibility: { verified: "14" } }),
    });
  });
  assert.deepEqual(secondContext.comparisonTarget.statusClass, "inferred");
  assert.deepEqual(secondContext.comparisonTarget.iconClass, "fa-circle-question");
  assert.ok(
    secondContext.comparisonTarget.note.startsWith(
      "THE-PLUGIN-PLUGIN.CheckerTable.TargetInferred"
    )
  );
  assert.ok(secondContext.comparisonTarget.note.includes("14"));
  // Never the "confirmed" classes/wording — an inference must not be
  // presented as Foundry-confirmed fact.
  assert.notEqual(secondContext.comparisonTarget.statusClass, "confirmed");
  assert.notEqual(secondContext.comparisonTarget.iconClass, "fa-circle-check");
});

// ---------------------------------------------------------------------------
// Fallback Field Trust: end-to-end regression for the reported bug (issue
// #48, SPEC-0002 REQ "Fallback Field Trust", ADR-0003 amended 2026-08-16).
//
// This is the one test in the whole PR that exercises the real bug
// end-to-end: manifest-fetcher.js's fallback path -> compatibility-
// classifier.js's severity/unmaintained classification ->
// checker-table-logic.js's deriveStatusLabelKey -> checker-table.js's
// #buildRows, the same call chain a real render cycle drives. Everything
// upstream and downstream of that chain is exercised in isolation
// elsewhere (manifest-fetcher.test.js, checker-table-logic.test.js); this
// test's job is only to prove the pieces compose correctly for the exact
// reported scenario, using `runComparisonTargetScenario`'s
// `_prepareContext`-driven harness (declared above) so it observes the same
// `context.rows` a real window render would.
// ---------------------------------------------------------------------------

test("a fallback-sourced, otherwise-clean package (installed 0.9.8, fallback version 0.5.1, verified passing) does NOT render as 'Up to date & verified' (issue #48 regression)", async () => {
  const { secondContext } = await runComparisonTargetScenario((game) => {
    // No game.data.coreUpdate — falls to peer inference, which finds no
    // signal here (the only package's `verified` matches the running
    // generation, not ahead of it), matching the real reported scenario
    // where the comparison target itself wasn't the issue.
    game.release = { generation: "13", version: "13.351", build: 351 };
    game.modules = [
      {
        id: "smarttarget-fallback-unknown-update",
        title: "Smart Target",
        active: true,
        version: "0.9.8",
        manifest:
          "https://github.com/theripper93/Smart-Target/releases/latest/download/module.json",
      },
    ];
    globalThis.fetch = async (url) => {
      if (url.includes("raw.githubusercontent.com")) {
        // Governing: ADR-0003's 2026-08-16 amendment — the real observed
        // Smart-Target row: a stale committed `version` (0.5.1, older than
        // the installed 0.9.8 and nowhere near the actual 4.0.0 release),
        // paired with a `compatibility.verified` that DOES verify the
        // running generation, so nothing else about this row is wrong.
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: "0.5.1", compatibility: { verified: "13" } }),
        };
      }
      // Declared URL (a GitHub release-asset link) always CORS-fails,
      // triggering the raw.githubusercontent.com fallback.
      throw new TypeError("Failed to fetch");
    };
  });

  const row = secondContext.rows.find((r) => r.id === "smarttarget-fallback-unknown-update");
  assert.ok(row, "expected the fallback-sourced package's row to be present");

  // The actual regression: this row must not read as confidently current.
  assert.notEqual(row.statusLabelKey, "upToDate");
  assert.notEqual(row.statusLabel, "THE-PLUGIN-PLUGIN.Status.UpToDate");
  // Per ADR-0006, it reads as "Verified, update unknown" — distinct from
  // "Couldn't check" (reserved for a total fetch failure; this row's
  // compatibility data is fully known and valid, only the update-version
  // comparison is unknown).
  assert.equal(row.statusLabelKey, "verifiedUpdateUnknown");
  assert.equal(row.statusLabel, "THE-PLUGIN-PLUGIN.Status.VerifiedUpdateUnknown");

  // The unknown `version` must never be surfaced as a latest-version figure.
  assert.equal(row.latestVersion, "—");
  // Provenance marking is still present — this is a fallback-sourced row.
  assert.ok(row.provenance, "expected a provenance marking on a fallback-sourced row");
  assert.equal(row.provenance.statusClass, "fallback");
});

test("comparisonTarget: inferred with no peer evidence maps to the 'inferred' view-model with the no-evidence wording", async () => {
  const { secondContext } = await runComparisonTargetScenario((game) => {
    // No coreUpdate, no modules at all — nothing to infer from.
    game.modules = [];
  });
  assert.deepEqual(secondContext.comparisonTarget.statusClass, "inferred");
  assert.deepEqual(secondContext.comparisonTarget.iconClass, "fa-circle-question");
  // TargetNoEvidence has no {version} placeholder, so it's localized rather
  // than formatted — the note is the bare key, unlike every other branch.
  assert.equal(
    secondContext.comparisonTarget.note,
    "THE-PLUGIN-PLUGIN.CheckerTable.TargetNoEvidence"
  );
});

// ---------------------------------------------------------------------------
// Active game system is fetched/classified but never rendered as a row
// (issue #60, ADR-0007, SPEC-0001 REQ "Checker Table" amended).
//
// `getActivePackagesFromGame` (manifest-fetcher.js) has always included the
// active system in the fetched/classified package set, via
// `toPackageInfo(system, true)` setting `isSystem: true`. That was always
// intentional — the system's `compatibility.verified` feeds
// `computeInferredLatest` peer inference (compatibility-classifier.js) — but
// the system was *also* showing up as its own row in the checker table,
// which was never the intent. `#buildRows` (checker-table.js) now filters
// `isSystem` packages out of the rendered rows array; this is the only
// change for this issue. These tests drive that through the same
// `_prepareContext`-based harness as the rest of this file, rather than
// reaching into the private `#buildRows` method directly.
//
// Governing: ADR-0007, SPEC-0001 REQ "Checker Table".
// ---------------------------------------------------------------------------

test("checker table rows: the active game system is fetched and feeds peer inference, but is not rendered as a row", async () => {
  const { secondContext } = await runComparisonTargetScenario((game) => {
    // No game.data.coreUpdate — falls to peer inference, so the system's
    // compatibility.verified (14, ahead of the running generation 13) is the
    // only thing that can produce an "inferred, peer signal present" target.
    game.release = { generation: "13", version: "13.351", build: 351 };
    game.system = {
      id: "starfinder",
      title: "Starfinder First Edition",
      version: "2.0.0",
      manifest: "https://example.com/starfinder/system.json",
    };
    game.modules = [
      {
        id: "some-module",
        title: "Some Module",
        active: true,
        version: "1.0.0",
        manifest: "https://example.com/some-module/module.json",
      },
    ];
    globalThis.fetch = async (url) => {
      if (url.includes("starfinder")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: "2.1.0", compatibility: { verified: "14" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "1.0.0", compatibility: { verified: "13" } }),
      };
    };
  });

  // The module still renders as its own row.
  const moduleRow = secondContext.rows.find((r) => r.id === "some-module");
  assert.ok(moduleRow, "expected the active module's row to be present");

  // The system does NOT render as a row, regardless of its own compatibility
  // status.
  const systemRow = secondContext.rows.find((r) => r.id === "starfinder");
  assert.equal(systemRow, undefined, "the active game system must not render as a row");

  // But its compatibility.verified (14) still reached peer inference: the
  // comparison target is "inferred" with the system's version as the peer
  // signal, proving the system was still fetched and still fed into
  // classification.packages — only the *rendered rows* filter excludes it.
  assert.deepEqual(secondContext.comparisonTarget.statusClass, "inferred");
  assert.ok(secondContext.comparisonTarget.note.includes("14"));
});
