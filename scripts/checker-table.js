/**
 * GM-only ApplicationV2 checker table window (issue #8): lists every active
 * package's compatibility/update status, a per-row pin toggle, link-outs,
 * and a copy-report button. Wraps the pure logic in checker-table-logic.js
 * with Foundry glue (game.settings, game.i18n, ApplicationV2 rendering,
 * clipboard) — kept in a separate file so checker-table-logic.js stays
 * importable from Node's test runner without a `foundry`/`game` global (the
 * `foundry.applications.api` reference below would throw at import time
 * under Node otherwise).
 *
 * Governing: SPEC-0001 REQ "Checker Table", SPEC-0001 REQ "Pinned Critical
 * Modules", SPEC-0001 REQ "Copy Report Button", SPEC-0001 "Accessibility
 * Requirements", ADR-0002.
 */

import { classifyActiveCompatibility } from "./compatibility-classifier.js";
import {
  deriveStatusLabelKey,
  deriveSeverityClass,
  deriveProvenanceInfo,
  isPinned,
  togglePinned,
  resolveIssueLink,
  formatCopyReportSnippet,
  STATUS_LABEL_I18N_KEYS,
} from "./checker-table-logic.js";

const MODULE_ID = "the-plugin-plugin";

// Governing: SPEC-0001 REQ "Pinned Critical Modules" — world-scoped setting
// storing pinned module ids as a plain array. `game.settings` has no native
// Set type; togglePinned/isPinned in checker-table-logic.js both accept and
// return plain arrays for exactly this reason. Registered additively in
// scripts/the-plugin-plugin.js's existing `init` hook, alongside this
// module's other world-scoped settings.
export const PINNED_MODULES_SETTING_KEY = "pinnedCriticalModules";

/** Reads the pinned-module-ids world setting; `[]` if unset/unavailable (e.g. setting not yet registered, or no world loaded). */
export function getPinnedModuleIds(gameInstance = globalThis.game) {
  try {
    return gameInstance?.settings?.get(MODULE_ID, PINNED_MODULES_SETTING_KEY) ?? [];
  } catch {
    return [];
  }
}

/**
 * Builds the plain-object context passed to `formatCopyReportSnippet` from
 * `game`/`navigator`. Kept separate from the pure formatter so the "read
 * live Foundry/browser state" step and the "format it as text" step can be
 * tested independently (the latter in test/checker-table-logic.test.js).
 *
 * Governing: SPEC-0001 REQ "Copy Report Button".
 */
export function buildReportContext(gameInstance = globalThis.game) {
  const system = gameInstance?.system;
  return {
    foundryVersion:
      gameInstance?.release?.version ?? String(gameInstance?.release?.generation ?? "unknown"),
    foundryBuild: gameInstance?.release?.build ?? "unknown",
    systemId: system?.id ?? "unknown",
    systemTitle: system?.title ?? "",
    systemVersion: system?.version ?? "unknown",
    userAgent: globalThis.navigator?.userAgent ?? "unknown",
  };
}

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * The checker table window itself. GM-only — `openCheckerTable` below is
 * the sole supported entry point and gates on `game.user.isGM` before this
 * class is even constructed (SPEC-0001 "Non-GM user" scenario).
 */
export class CheckerTableApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "the-plugin-plugin-checker-table",
    classes: ["the-plugin-plugin", "checker-table-app"],
    tag: "div",
    window: {
      title: "THE-PLUGIN-PLUGIN.CheckerTable.Title",
      icon: "fa-solid fa-list-check",
      resizable: true,
    },
    position: { width: 960, height: 720 },
    actions: {
      togglePin: CheckerTableApp.#onTogglePin,
      copyReport: CheckerTableApp.#onCopyReport,
      rescan: CheckerTableApp.#onRescan,
    },
  };

  static PARTS = {
    content: {
      template: "modules/the-plugin-plugin/templates/checker-table.hbs",
    },
  };

  /** @type {{comparisonTarget: object, packages: Array}|null} cached classification result for this window instance. */
  #classification = null;
  #loading = false;
  #scanError = null;
  #abortController = null;

  // Governing: SPEC-0001 "Accessibility Requirements" § Focus Management —
  // "The checker window ... MUST return focus to the element that opened
  // it ... when closed." Explicit capture/restore rather than assuming
  // ApplicationV2's default behavior already covers this (per issue
  // instructions: verify, don't assume). Set by `openCheckerTable` before
  // the first render.
  triggerElement = null;

  /**
   * @override Defense-in-depth GM gate: `openCheckerTable` is the documented
   * sole entry point and already refuses to construct/render this class for
   * a non-GM, but this guard keeps that guarantee true even if something
   * else ever calls `render()` directly on an existing instance (SPEC-0001
   * "Non-GM user" scenario: "the system does not render the window for that
   * user").
   */
  async render(...args) {
    if (!game.user?.isGM) return this;
    return super.render(...args);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    if (!this.#classification && !this.#loading) {
      // Fire-and-forget: `#startScan` re-renders itself when done, so the
      // window opens immediately with a loading state instead of blocking
      // the first paint on the network round-trip.
      this.#startScan();
    }

    // Governing: SPEC-0001 "Accessibility Requirements" § Dynamic Content
    // Regions — `aria-live="polite"` status text, rendered in the template.
    // Note: classifyActiveCompatibility resolves in one batch rather than
    // exposing per-package progress, so this is a single before/after
    // status transition rather than a running per-package tally — see the
    // PR description for the reasoning (manifest-fetcher.js/
    // compatibility-classifier.js are shared foundation code, out of this
    // issue's scope to change their public shape).
    context.loading = this.#loading;
    context.scanError = Boolean(this.#scanError);
    context.scanStatusMessage = this.#loading
      ? game.i18n.localize("THE-PLUGIN-PLUGIN.CheckerTable.Scanning")
      : this.#scanError
        ? game.i18n.localize("THE-PLUGIN-PLUGIN.CheckerTable.ScanError")
        : game.i18n.format("THE-PLUGIN-PLUGIN.CheckerTable.ScanComplete", {
            count: this.#classification?.packages?.length ?? 0,
          });

    // Governing: SPEC-0001 REQ "Checker Table" — "The window MUST display a
    // visible reminder that package developers are volunteers ...";
    // CLAUDE.md project rule 1.
    context.kindnessReminder = game.i18n.localize("THE-PLUGIN-PLUGIN.CheckerTable.KindnessReminder");
    context.developerDeclaredNote = game.i18n.localize(
      "THE-PLUGIN-PLUGIN.CheckerTable.DeveloperDeclaredNote"
    );
    context.resultsRegionLabel = game.i18n.localize(
      "THE-PLUGIN-PLUGIN.CheckerTable.ResultsRegionLabel"
    );

    // Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Inferred
    // Latest Version" — "MUST distinguish an authoritative target from an
    // inferred one wherever the target version is surfaced to the GM, so an
    // inference is never presented as fact."
    context.comparisonTarget = this.#classification
      ? this.#buildComparisonTargetContext(this.#classification.comparisonTarget)
      : null;

    context.rows = this.#classification ? this.#buildRows(this.#classification) : [];
    return context;
  }

  /**
   * Builds the GM-facing view-model for the current comparison target — the
   * Foundry version every row's status is (in part) measured against beyond
   * `game.release` — distinguishing an authoritative source
   * (`game.data.coreUpdate`) from a peer-inferred one, per REQ "Target
   * Version Determination" / REQ "Inferred Latest Version". `statusClass`
   * and `iconClass` give the template a visual hook (confirmed vs. inferred)
   * in addition to the text itself, so the distinction isn't carried by
   * wording alone.
   *
   * Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
   * Determination", SPEC-0001 REQ "Inferred Latest Version", CLAUDE.md
   * project rule 1 (no phrasing implies a package is at fault for a target
   * that couldn't be confirmed).
   */
  #buildComparisonTargetContext(comparisonTarget) {
    if (!comparisonTarget) return null;

    if (comparisonTarget.source === "authoritative") {
      const key = comparisonTarget.isNewer
        ? "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedNewer"
        : "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedCurrent";
      return {
        statusClass: "confirmed",
        iconClass: "fa-circle-check",
        note: game.i18n.format(key, { version: comparisonTarget.rawVersion }),
      };
    }

    if (comparisonTarget.hasPeerSignal) {
      return {
        statusClass: "inferred",
        iconClass: "fa-circle-question",
        note: game.i18n.format("THE-PLUGIN-PLUGIN.CheckerTable.TargetInferred", {
          version: comparisonTarget.rawVersion,
        }),
      };
    }

    return {
      statusClass: "inferred",
      iconClass: "fa-circle-question",
      note: game.i18n.localize("THE-PLUGIN-PLUGIN.CheckerTable.TargetNoEvidence"),
    };
  }

  /**
   * Maps classified packages (compatibility-classifier.js output) to the
   * flat view-model the Handlebars template renders, applying the pure
   * status/severity/pin/link logic from checker-table-logic.js and
   * localizing every icon-only control's `aria-label`.
   *
   * Governing: SPEC-0001 REQ "Checker Table", SPEC-0001 "Accessibility
   * Requirements" § Icon-Only Controls.
   */
  #buildRows(classification) {
    const pinnedIds = getPinnedModuleIds();
    return classification.packages.map((pkg) => {
      const pinned = isPinned(pinnedIds, pkg.id);
      const statusLabelKey = deriveStatusLabelKey(pkg);
      const severityClass = deriveSeverityClass(pkg);
      const issueLink = resolveIssueLink(pkg.links);
      const title = pkg.title ?? pkg.id;
      const provenanceInfo = deriveProvenanceInfo(pkg);

      return {
        id: pkg.id,
        title,
        installedVersion: pkg.installedVersion ?? "—",
        latestVersion: pkg.latestVersion ?? "—",
        verified: pkg.verified ?? "—",
        statusLabel: game.i18n.localize(STATUS_LABEL_I18N_KEYS[statusLabelKey]),
        statusLabelKey,
        severityClass,
        // Governing: SPEC-0002 REQ "Result Provenance" — null for a
        // declared-sourced row (no marking rendered at all, per the
        // "Declared-sourced row" scenario); the localization call belongs
        // here rather than in checker-table-logic.js's pure
        // `deriveProvenanceInfo`, same split already used for `statusLabel`.
        provenance: provenanceInfo
          ? {
              statusClass: provenanceInfo.statusClass,
              iconClass: provenanceInfo.iconClass,
              note: game.i18n.localize(provenanceInfo.i18nKey),
            }
          : null,
        isPinned: pinned,
        links: {
          url: pkg.links?.url ?? null,
          issue: issueLink,
          changelog: pkg.links?.changelog ?? null,
        },
        // Governing: SPEC-0001 "Accessibility Requirements" § Icon-Only
        // Controls — each icon-only control gets an aria-label describing
        // its *specific* action (e.g. "Pin lib-wrapper as a critical
        // module"), not a generic "Pin".
        ariaLabels: {
          pin: game.i18n.format(
            pinned
              ? "THE-PLUGIN-PLUGIN.CheckerTable.AriaUnpin"
              : "THE-PLUGIN-PLUGIN.CheckerTable.AriaPin",
            { title }
          ),
          copy: game.i18n.format("THE-PLUGIN-PLUGIN.CheckerTable.AriaCopyReport", { title }),
          url: game.i18n.format("THE-PLUGIN-PLUGIN.CheckerTable.AriaProjectPage", { title }),
          issue: game.i18n.format("THE-PLUGIN-PLUGIN.CheckerTable.AriaReportIssue", { title }),
          changelog: game.i18n.format("THE-PLUGIN-PLUGIN.CheckerTable.AriaChangelog", { title }),
        },
      };
    });
  }

  /**
   * Runs (or re-runs) the classification scan and re-renders when it
   * settles. Cancellable via `#abortController`, aborted on window close —
   * see `_onClose` below.
   *
   * Governing: SPEC-0001 REQ "Fetch Concurrency and Caching" (session cache
   * reused automatically by classifyActiveCompatibility/checkActivePackages
   * unless `forceRefresh` is passed; cancellation on close).
   */
  async #startScan(options = {}) {
    this.#loading = true;
    this.#scanError = null;
    this.#abortController = new AbortController();
    try {
      this.#classification = await classifyActiveCompatibility({
        signal: this.#abortController.signal,
        ...options,
      });
    } catch (err) {
      // Governing: SPEC-0001 REQ "Error Handling Standards" — a scan-level
      // failure (as opposed to a per-package one, already isolated by
      // manifest-fetcher.js) still must not leave the window in a silently
      // stuck loading state.
      console.error(`${MODULE_ID} | checker table scan failed`, err);
      this.#scanError = err;
    } finally {
      this.#loading = false;
      this.render();
    }
  }

  /** @override */
  _onClose(options) {
    super._onClose?.(options);
    // Governing: SPEC-0001 REQ "Fetch Concurrency and Caching" — "MUST
    // support cancellation of in-flight fetches (e.g., on window close) so
    // an abandoned check does not continue consuming concurrency slots."
    this.#abortController?.abort();
    // Governing: SPEC-0001 "Accessibility Requirements" § Focus Management.
    this.triggerElement?.focus?.();
  }

  static #onTogglePin(event, target) {
    const moduleId = target?.dataset?.moduleId;
    if (!moduleId) return;
    const next = togglePinned(getPinnedModuleIds(), moduleId);
    game.settings.set(MODULE_ID, PINNED_MODULES_SETTING_KEY, next).then(() => this.render());
  }

  static #onCopyReport(event, target) {
    const moduleId = target?.dataset?.moduleId;
    const pkg = this.#classification?.packages?.find((p) => p.id === moduleId);
    if (!pkg) return;
    const snippet = formatCopyReportSnippet(pkg, buildReportContext());
    navigator.clipboard
      .writeText(snippet)
      .then(() =>
        ui.notifications.info(game.i18n.localize("THE-PLUGIN-PLUGIN.CheckerTable.CopyReportSuccess"))
      )
      .catch((err) => {
        console.error(`${MODULE_ID} | copy report failed`, err);
        ui.notifications.error(
          game.i18n.localize("THE-PLUGIN-PLUGIN.CheckerTable.CopyReportFailure")
        );
      });
  }

  static #onRescan() {
    this.#startScan({ forceRefresh: true });
  }
}

let activeInstance = null;

/**
 * The sole supported entry point for opening the checker table. GM-only —
 * returns null without ever constructing `CheckerTableApp` for a non-GM
 * user (SPEC-0001 "Non-GM user" scenario: "the system does not render the
 * window for that user"). Reuses a single instance across calls so
 * re-opening (e.g. from the login notification's chat message, issue #9)
 * brings the existing window forward instead of stacking duplicates.
 *
 * Governing: SPEC-0001 REQ "Checker Table".
 *
 * @param {HTMLElement|null} [triggerElement] - the element that triggered
 *   opening (e.g. a chat message button), captured for focus restoration on
 *   close (SPEC-0001 "Accessibility Requirements" § Focus Management).
 *   Defaults to whatever currently has focus.
 */
export async function openCheckerTable(triggerElement = globalThis.document?.activeElement ?? null) {
  // `globalThis.game` (not a bare `game` reference) so this gate degrades to
  // "not a GM" — never a thrown ReferenceError — when no world is loaded at
  // all, matching the defensive-default pattern the rest of this file
  // already uses for `getPinnedModuleIds`/`buildReportContext`.
  if (!globalThis.game?.user?.isGM) return null;
  if (!activeInstance) {
    activeInstance = new CheckerTableApp();
  }
  activeInstance.triggerElement = triggerElement;
  await activeInstance.render(true);
  return activeInstance;
}
