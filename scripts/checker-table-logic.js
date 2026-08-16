/**
 * Pure, dependency-injectable logic for the checker table UI (issue #8):
 * status-label derivation, severity visual classification, pin-toggle set
 * logic, link-out resolution, and copy-report snippet formatting.
 *
 * No `game`/`foundry`/DOM/clipboard reference anywhere in this file, so it's
 * unit-testable with Node's built-in test runner, matching the precedent set
 * by manifest-fetcher.js / compatibility-classifier.js. See
 * scripts/checker-table.js for the ApplicationV2 window that wires this
 * logic to Foundry (i18n, game.settings, rendering, clipboard).
 *
 * Governing: SPEC-0001 REQ "Checker Table", SPEC-0001 REQ "Pinned Critical
 * Modules", SPEC-0001 REQ "Copy Report Button", ADR-0002.
 */

import { parseGithubRepo } from "./compatibility-classifier.js";

// ---------------------------------------------------------------------------
// Requirement: Checker Table — status label derivation
// ---------------------------------------------------------------------------

/**
 * The six permitted status labels (SPEC-0001 REQ "Checker Table" /
 * CLAUDE.md "Core v1 scope" — six as of ADR-0006; originally five). Keys map
 * to localization keys in languages/en.json — see STATUS_LABEL_I18N_KEYS.
 * CLAUDE.md project rule 1: never "dead"/"broken"/"abandoned" anywhere,
 * including here.
 */
export const STATUS_LABEL_KEYS = Object.freeze({
  UP_TO_DATE: "upToDate",
  UPDATE_AVAILABLE: "updateAvailable",
  NOT_YET_VERIFIED: "notYetVerified",
  POSSIBLY_UNMAINTAINED: "possiblyUnmaintained",
  VERIFIED_UPDATE_UNKNOWN: "verifiedUpdateUnknown",
  COULDNT_CHECK: "couldntCheck",
});

/** Maps STATUS_LABEL_KEYS values to their languages/en.json localization keys. */
export const STATUS_LABEL_I18N_KEYS = Object.freeze({
  [STATUS_LABEL_KEYS.UP_TO_DATE]: "THE-PLUGIN-PLUGIN.Status.UpToDate",
  [STATUS_LABEL_KEYS.UPDATE_AVAILABLE]: "THE-PLUGIN-PLUGIN.Status.UpdateAvailable",
  [STATUS_LABEL_KEYS.NOT_YET_VERIFIED]: "THE-PLUGIN-PLUGIN.Status.NotYetVerified",
  [STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED]: "THE-PLUGIN-PLUGIN.Status.PossiblyUnmaintained",
  [STATUS_LABEL_KEYS.VERIFIED_UPDATE_UNKNOWN]: "THE-PLUGIN-PLUGIN.Status.VerifiedUpdateUnknown",
  [STATUS_LABEL_KEYS.COULDNT_CHECK]: "THE-PLUGIN-PLUGIN.Status.CouldntCheck",
});

/**
 * Derives which of the six permitted status labels applies to a classified
 * package (the shape returned by compatibility-classifier.js's
 * `classifyActiveCompatibility` / `classifyCompatibility`: `status`,
 * `error`, `possiblyUnmaintained`, `severity` ('hard'|'soft'|null),
 * `updateAvailable`).
 *
 * Precedence (highest first) — a package can technically satisfy more than
 * one condition at once (e.g. hard-severity AND an update is available), so
 * this ordering is a judgment call, documented here rather than left
 * implicit:
 *   1. Couldn't check — a fetch failure means there's no other reliable data
 *      about this package at all, so it dominates every other signal.
 *   2. Possibly unmaintained — the most specific signal (it already requires
 *      two corroborating signals per SPEC-0001's own heuristic), more
 *      informative than a bare compatibility lag.
 *   3. Hard or soft severity → "Not yet verified...". Per the spec's
 *      taxonomy, hard severity does NOT get its own separate
 *      label — it renders the same text as soft, but is visually
 *      distinguished (see `deriveSeverityClass` below / ADR-0002 "hard
 *      escalates, soft stays quiet"). Foundry-version compatibility is
 *      treated as more important to surface than a routine version bump,
 *      since the fetched manifest already reflects the latest published
 *      version's own declared compatibility fields.
 *   4. Update available — `pkg.updateAvailable === true`.
 *   5. Verified, update unknown — `pkg.updateAvailable == null` (unknown,
 *      never `false`), with no severity issue and not possibly unmaintained.
 *      Per ADR-0006: manifest-fetcher.js returns `updateAvailable: null` for
 *      a fallback-sourced result (ADR-0003 as amended 2026-08-16 — a
 *      fallback-sourced `version` is not trustworthy enough to compare, in
 *      either direction), and per ADR-0003's own real-world measurement,
 *      fallback resolution is the *common* case for a checked package, not
 *      a rare edge. An earlier revision of this function (issue #48) mapped
 *      this state to "Couldn't check" instead — that collapsed most of the
 *      table into a label meaning "no reliable data at all," even though
 *      `compatibility.verified`, severity, and links were all still
 *      correctly known for these rows. This dedicated status keeps that
 *      distinction visible: "Couldn't check" now means only what it always
 *      meant (no reliable data, step 1), and this status means "we know
 *      this package is fine, we just don't know if a newer version exists."
 *   6. Up to date & verified — the default when nothing else applies, i.e.
 *      `pkg.updateAvailable === false` (a known, confirmed non-update) and
 *      every earlier condition is clear.
 *
 * Governing: SPEC-0001 REQ "Checker Table", SPEC-0002 REQ "Fallback Field
 * Trust" (issue #48), ADR-0002, ADR-0003 (amended 2026-08-16), ADR-0006.
 */
export function deriveStatusLabelKey(pkg) {
  if (!pkg || pkg.status === "error" || pkg.error) {
    return STATUS_LABEL_KEYS.COULDNT_CHECK;
  }
  if (pkg.possiblyUnmaintained) {
    return STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED;
  }
  if (pkg.severity === "hard" || pkg.severity === "soft") {
    return STATUS_LABEL_KEYS.NOT_YET_VERIFIED;
  }
  if (pkg.updateAvailable) {
    return STATUS_LABEL_KEYS.UPDATE_AVAILABLE;
  }
  // Governing: ADR-0006 — unknown update availability (`null`, as
  // manifest-fetcher.js returns for every fallback-sourced result) MUST NOT
  // fall through to "Up to date & verified" below (only a known `false`
  // does), and MUST NOT collapse into "Couldn't check" either — that
  // conflates "no reliable data" with "compatibility is fine, update status
  // unknown," which real-world fallback-resolution rates make the *common*
  // case, not a rare edge. See the judgment-call note above the function.
  if (pkg.updateAvailable == null) {
    return STATUS_LABEL_KEYS.VERIFIED_UPDATE_UNKNOWN;
  }
  return STATUS_LABEL_KEYS.UP_TO_DATE;
}

/**
 * Visual-only severity classification for a row/status badge: 'hard' |
 * 'soft' | null. This is how hard severity is distinguished from soft
 * *within* the status taxonomy — both render identical "Not yet
 * verified..." text (see `deriveStatusLabelKey`); this class is what a
 * template/stylesheet uses to escalate hard's visual weight (e.g. a
 * stronger border/icon), consistent with ADR-0002's "hard escalates, soft
 * stays quiet" principle. Never used to change the label text itself.
 *
 * Governing: ADR-0002, SPEC-0001 REQ "Checker Table".
 */
export function deriveSeverityClass(pkg) {
  if (!pkg || pkg.status === "error") return null;
  return pkg.severity === "hard" || pkg.severity === "soft" ? pkg.severity : null;
}

// ---------------------------------------------------------------------------
// Requirement: Result Provenance (SPEC-0002)
// ---------------------------------------------------------------------------

/**
 * Derives the per-row provenance marking for a package whose manifest was
 * read via the raw.githubusercontent.com fallback (ADR-0003) rather than
 * from its own declared manifest URL. Returns `null` for a declared-sourced
 * package, and for any package with no provenance value at all (e.g. an
 * error result, where `provenance` is `null` per manifest-fetcher.js) — a
 * declared-sourced row carries no marking, per SPEC-0002 REQ "Result
 * Provenance" ("Declared-sourced row" scenario).
 *
 * Mirrors the shape `#buildComparisonTargetContext`
 * (scripts/checker-table.js) already establishes for a near-identical
 * "authoritative vs. inferred" distinction, but scoped per-row rather than
 * window-level: `statusClass`/`iconClass` give the template a visual hook,
 * `i18nKey` names the localization string checker-table.js resolves via
 * `game.i18n` (kept out of this file so it stays dependency-free and
 * Node-testable, matching `deriveStatusLabelKey`/`deriveSeverityClass`
 * above — no `game`/i18n reference here).
 *
 * Governing: SPEC-0002 REQ "Result Provenance", SPEC-0002 REQ "Inferred
 * Latest Participation" (this function only concerns display; participation
 * in `inferredLatest` is unconditional by construction in
 * compatibility-classifier.js's `computeInferredLatest`, which does not
 * branch on `provenance` at all), ADR-0003 "Confirmation" (a fallback result
 * MUST be distinguishable to the GM, both in the data model and in the UI).
 * CLAUDE.md project rule 1: the marking names the data source only — it
 * never implies the package itself is behind, neglected, or at fault, and
 * never calls fallback-sourced data "latest published"/"released".
 *
 * @param {object} pkg - a fetched/classified package result (needs
 *   `provenance`, the field manifest-fetcher.js's `buildOkResult`/
 *   `errorResult` already set on every result)
 * @returns {{statusClass: 'fallback', iconClass: string, i18nKey: string}|null}
 */
export function deriveProvenanceInfo(pkg) {
  if (!pkg || pkg.provenance !== "fallback") return null;
  return {
    statusClass: "fallback",
    iconClass: "fa-code-branch",
    i18nKey: "THE-PLUGIN-PLUGIN.CheckerTable.ProvenanceFallbackNote",
  };
}

// ---------------------------------------------------------------------------
// Requirement: Pinned Critical Modules — pin/star toggle set logic
// ---------------------------------------------------------------------------

/** True when `moduleId` is present in the pinned-ids collection (array or Set). */
export function isPinned(pinnedIds, moduleId) {
  if (!pinnedIds) return false;
  if (pinnedIds instanceof Set) return pinnedIds.has(moduleId);
  return Array.isArray(pinnedIds) && pinnedIds.includes(moduleId);
}

/**
 * Toggles `moduleId`'s membership in the pinned-ids collection. Always
 * returns a plain array (the shape persisted in the world-scoped setting —
 * see PINNED_MODULES_SETTING_KEY in scripts/checker-table.js), regardless of
 * whether the input was an array or a Set, so callers can round-trip through
 * `game.settings` without any extra conversion step.
 *
 * Governing: SPEC-0001 REQ "Pinned Critical Modules" ("a GM toggle a
 * pin/star on any row, persisted as a set of module IDs").
 */
export function togglePinned(pinnedIds, moduleId) {
  const set = new Set(pinnedIds ?? []);
  if (set.has(moduleId)) {
    set.delete(moduleId);
  } else {
    set.add(moduleId);
  }
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Requirement: Checker Table — link-out resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the "report issue" link-out URL: prefers the manifest's own
 * `bugs` field, falling back to `<url>/issues` only when `url` is a GitHub
 * repository URL. Returns null when neither is available, so callers omit
 * the button entirely rather than rendering a dead link (SPEC-0001 "Missing
 * link-out field" scenario). Reuses compatibility-classifier.js's
 * `parseGithubRepo` rather than re-implementing GitHub URL detection.
 *
 * Governing: SPEC-0001 REQ "Checker Table".
 */
export function resolveIssueLink(links) {
  if (!links) return null;
  if (links.bugs) return links.bugs;
  if (links.url && parseGithubRepo(links.url)) {
    return links.url.replace(/\/+$/, "") + "/issues";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Requirement: Copy Report Button
// ---------------------------------------------------------------------------

/**
 * Formats the plain-text bug-report snippet copied to the clipboard,
 * intended for pasting into a GitHub issue. Pure — takes the package and a
 * plain `context` object rather than reading `game`/`navigator` directly, so
 * it's testable without a browser or a running Foundry world. See
 * `buildReportContext` in scripts/checker-table.js for how `context` is
 * assembled from `game`/`navigator` in the actual app.
 *
 * Governing: SPEC-0001 REQ "Copy Report Button" (package id + installed
 * version, Foundry version + build, active game system + version, browser
 * user agent — all five fields below).
 *
 * @param {object} pkg - classified package (needs `id`, `installedVersion`)
 * @param {object} context
 * @param {string} [context.foundryVersion]
 * @param {string|number} [context.foundryBuild]
 * @param {string} [context.systemId]
 * @param {string} [context.systemTitle]
 * @param {string} [context.systemVersion]
 * @param {string} [context.userAgent]
 */
export function formatCopyReportSnippet(pkg, context = {}) {
  const {
    foundryVersion = "unknown",
    foundryBuild = "unknown",
    systemId = "unknown",
    systemTitle = "",
    systemVersion = "unknown",
    userAgent = "unknown",
  } = context;

  const systemLabel = systemTitle ? `${systemTitle} (${systemId})` : systemId;

  return [
    `Package: ${pkg?.id ?? "unknown"} v${pkg?.installedVersion ?? "unknown"}`,
    `Foundry VTT: ${foundryVersion} (build ${foundryBuild})`,
    `Game system: ${systemLabel} v${systemVersion}`,
    `User agent: ${userAgent}`,
  ].join("\n");
}
