// Render tests for templates/checker-table.hbs: the piece of issue #8's
// scope that issue #8's own PR (checker-table-logic.test.js /
// language-strings.test.js) did not cover — actually compiling and
// rendering the Handlebars template with the exact view-model shape
// scripts/checker-table.js's `#buildRows` produces, and asserting on the
// resulting HTML.
//
// Uses the `handlebars` package directly (a devDependency added for this
// file) rather than Foundry's `renderTemplate` wrapper, since the latter
// only exists inside a running Foundry client. `handlebars` is the exact
// templating engine Foundry's wrapper delegates to for this file, so this
// is using the reference implementation directly rather than introducing a
// new templating approach (see PR description for the full justification;
// CLAUDE.md project rule 2 "no dependencies without justification").
//
// By the time `#buildRows` (scripts/checker-table.js) hands a row to this
// template, every string field (statusLabel, ariaLabels.*) is already the
// result of `game.i18n.localize`/`format` — plain text, not an i18n key. So
// test view-models below use plain already-localized strings for row
// fields, matching production. The template's OWN direct
// `{{localize "..."}}` calls (column headers, rescan button, loading/
// error/no-packages fallback text) are stubbed with a `localize` helper
// that echoes the key back, and assertions check for that key literal.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Checker Table", SPEC-0001 REQ "Pinned Critical
// Modules", SPEC-0001 REQ "Copy Report Button", SPEC-0001 "Accessibility
// Requirements", ADR-0002

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Handlebars from "handlebars";

const here = path.dirname(fileURLToPath(import.meta.url));
const templateSource = fs.readFileSync(
  path.join(here, "../templates/checker-table.hbs"),
  "utf8"
);

// Test-only stand-in for Foundry's `localize` Handlebars helper: echoes the
// localization key back unlocalized so assertions can check for the key
// literal rather than needing real translated strings from languages/en.json.
Handlebars.registerHelper("localize", (key) => key);

const template = Handlebars.compile(templateSource);

/** A single row matching the exact shape `#buildRows` (scripts/checker-table.js) produces. */
function row(overrides = {}) {
  return {
    id: "lib-wrapper",
    title: "libWrapper",
    installedVersion: "1.12.13",
    latestVersion: "1.13.0",
    verified: "13",
    statusLabel: "Up to date & verified",
    statusLabelKey: "upToDate",
    severityClass: null,
    isPinned: false,
    links: { url: null, issue: null, changelog: null },
    ariaLabels: {
      pin: "Pin libWrapper as a critical module",
      copy: "Copy bug-report snippet for libWrapper",
      url: "Open libWrapper's project page",
      issue: "Report an issue for libWrapper",
      changelog: "View libWrapper's changelog",
    },
    ...overrides,
  };
}

/** Base context matching what `_prepareContext` (scripts/checker-table.js) assembles. */
function baseContext(overrides = {}) {
  return {
    loading: false,
    scanError: false,
    scanStatusMessage: "Checked 1 package(s).",
    kindnessReminder: "Developers are volunteers.",
    developerDeclaredNote: "Developer-declared, not tested.",
    resultsRegionLabel: "Compatibility checker results",
    rows: [row()],
    ...overrides,
  };
}

// --- Status labels: all five taxonomy states appear in the output ---------

const STATUS_LABELS = [
  "Up to date & verified",
  "Update available",
  "Not yet verified for current/target Foundry version",
  "Possibly unmaintained",
  "Couldn't check",
];

for (const label of STATUS_LABELS) {
  test(`status label "${label}" appears in the rendered row`, () => {
    const html = template(baseContext({ rows: [row({ statusLabel: label })] }));
    // Handlebars HTML-escapes interpolated text (e.g. "&" -> "&amp;", "'" ->
    // "&#x27;"), so compare against the escaped form rather than the raw
    // label — two of the five taxonomy labels ("Up to date & verified",
    // "Couldn't check") contain characters Handlebars escapes.
    const expected = Handlebars.escapeExpression(label);
    assert.ok(html.includes(expected), `expected output to contain "${expected}"`);
  });
}

// --- Versions ---------------------------------------------------------------

test("installed, latest, and verified core versions all appear in the output", () => {
  const html = template(
    baseContext({
      rows: [
        row({ installedVersion: "1.12.13", latestVersion: "1.13.0", verified: "13.335" }),
      ],
    })
  );
  assert.ok(html.includes("1.12.13"));
  assert.ok(html.includes("1.13.0"));
  assert.ok(html.includes("13.335"));
});

// --- Link-out buttons: present only when the corresponding field is set ----
// Governing: SPEC-0001 "Missing link-out field" scenario.

test("all three link-out anchors render when every links.* field is present", () => {
  const html = template(
    baseContext({
      rows: [
        row({
          links: {
            url: "https://example.com/lib-wrapper",
            issue: "https://github.com/o/lib-wrapper/issues",
            changelog: "https://example.com/lib-wrapper/changelog",
          },
        }),
      ],
    })
  );
  assert.ok(html.includes('href="https://example.com/lib-wrapper"'));
  assert.ok(html.includes('href="https://github.com/o/lib-wrapper/issues"'));
  assert.ok(html.includes('href="https://example.com/lib-wrapper/changelog"'));
  // Three link-out anchors, exactly.
  const anchorCount = (html.match(/<a\s/g) ?? []).length;
  assert.equal(anchorCount, 3);
});

test("no link-out anchors render when every links.* field is null (SPEC-0001 'Missing link-out field')", () => {
  const html = template(
    baseContext({ rows: [row({ links: { url: null, issue: null, changelog: null } })] })
  );
  assert.ok(!html.includes("<a "));
});

test("only the issue link-out anchor renders when url and changelog are null but bugs-derived issue link is present (partial field coverage)", () => {
  const html = template(
    baseContext({
      rows: [row({ links: { url: null, issue: "https://example.com/issues", changelog: null } })],
    })
  );
  const anchorCount = (html.match(/<a\s/g) ?? []).length;
  assert.equal(anchorCount, 1);
  assert.ok(html.includes('href="https://example.com/issues"'));
});

// --- aria-labels on icon-only controls --------------------------------------
// Governing: SPEC-0001 "Accessibility Requirements" § Icon-Only Controls.

test("pin toggle, copy-report button, and every link-out icon carry their expected aria-label", () => {
  const html = template(
    baseContext({
      rows: [
        row({
          links: {
            url: "https://example.com/u",
            issue: "https://example.com/i",
            changelog: "https://example.com/c",
          },
          ariaLabels: {
            pin: "Pin libWrapper as a critical module",
            copy: "Copy bug-report snippet for libWrapper",
            url: "Open libWrapper's project page",
            issue: "Report an issue for libWrapper",
            changelog: "View libWrapper's changelog",
          },
        }),
      ],
    })
  );
  assert.ok(html.includes('aria-label="Pin libWrapper as a critical module"'));
  assert.ok(html.includes('aria-label="Copy bug-report snippet for libWrapper"'));
  // Handlebars HTML-escapes the apostrophe in these two labels.
  assert.ok(html.includes(`aria-label="${Handlebars.escapeExpression("Open libWrapper's project page")}"`));
  assert.ok(html.includes('aria-label="Report an issue for libWrapper"'));
  assert.ok(html.includes(`aria-label="${Handlebars.escapeExpression("View libWrapper's changelog")}"`));
});

test("pin toggle aria-label switches to the unpin phrasing when the row is pinned", () => {
  const html = template(
    baseContext({
      rows: [row({ isPinned: true, ariaLabels: { ...row().ariaLabels, pin: "Unpin libWrapper as a critical module" } })],
    })
  );
  assert.ok(html.includes('aria-label="Unpin libWrapper as a critical module"'));
  assert.ok(html.includes('aria-pressed="true"'));
});

// --- ARIA landmarks / dynamic content regions -------------------------------
// Governing: SPEC-0001 "Accessibility Requirements" § ARIA Landmarks, §
// Dynamic Content Regions.

test('the results region carries role="main"', () => {
  const html = template(baseContext());
  assert.match(html, /role="main"[^>]*class="checker-table-region"|class="checker-table-region"[^>]*role="main"/s);
  // Simpler, order-independent check as the primary assertion:
  assert.ok(/<div role="main"/.test(html));
});

test('the scan-status span carries aria-live="polite"', () => {
  const html = template(baseContext({ scanStatusMessage: "Checked 3 package(s)." }));
  assert.ok(html.includes('<span class="scan-status" aria-live="polite">Checked 3 package(s).</span>'));
});

// --- Empty-row fallback ({{else}} branch) -----------------------------------

test("empty-row fallback renders the loading message when rows is empty and loading is true", () => {
  const html = template(baseContext({ rows: [], loading: true, scanError: false }));
  assert.ok(html.includes("THE-PLUGIN-PLUGIN.CheckerTable.Scanning"));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.ScanError"));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.NoPackages"));
});

test("empty-row fallback renders the scan-error message when rows is empty, loading is false, and scanError is true", () => {
  const html = template(baseContext({ rows: [], loading: false, scanError: true }));
  assert.ok(html.includes("THE-PLUGIN-PLUGIN.CheckerTable.ScanError"));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.Scanning"));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.NoPackages"));
});

test("empty-row fallback renders the no-packages message when rows is empty, loading is false, and scanError is false", () => {
  const html = template(baseContext({ rows: [], loading: false, scanError: false }));
  assert.ok(html.includes("THE-PLUGIN-PLUGIN.CheckerTable.NoPackages"));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.Scanning"));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.ScanError"));
});

test("row loop renders no empty-row fallback text when rows is non-empty", () => {
  const html = template(baseContext({ rows: [row()], loading: true }));
  assert.ok(!html.includes("THE-PLUGIN-PLUGIN.CheckerTable.Scanning"));
});

// --- Comparison target note ---------------------------------------------
// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
// Determination", SPEC-0001 REQ "Inferred Latest Version" — "MUST
// distinguish an authoritative target from an inferred one wherever the
// target version is surfaced to the GM, so an inference is never presented
// as fact." `comparisonTarget` is the view-model `#buildComparisonTargetContext`
// (scripts/checker-table.js) produces.

test("comparison-target note is omitted entirely when no classification has run yet", () => {
  const html = template(baseContext({ comparisonTarget: null }));
  assert.ok(!html.includes("comparison-target-note"));
});

test("an authoritative comparison target renders the 'confirmed' class and note, never the 'inferred' one", () => {
  const html = template(
    baseContext({
      comparisonTarget: {
        statusClass: "confirmed",
        iconClass: "fa-circle-check",
        note: "Foundry confirms version 14.366 is available.",
      },
    })
  );
  assert.ok(html.includes('class="comparison-target-note developer-declared-note confirmed"'));
  assert.ok(html.includes("fa-circle-check"));
  assert.ok(html.includes("Foundry confirms version 14.366 is available."));
  assert.ok(!html.includes("fa-circle-question"));
});

test("an inferred comparison target renders the 'inferred' class and note, distinguishing it from a confirmed one", () => {
  const html = template(
    baseContext({
      comparisonTarget: {
        statusClass: "inferred",
        iconClass: "fa-circle-question",
        note: "Foundry couldn't confirm the latest version this session, so 14 is inferred from what other installed packages declare — not confirmed.",
      },
    })
  );
  assert.ok(html.includes('class="comparison-target-note developer-declared-note inferred"'));
  assert.ok(html.includes("fa-circle-question"));
  assert.ok(html.includes("not confirmed"));
  assert.ok(!html.includes("fa-circle-check"));
});
