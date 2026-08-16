/**
 * Login notification: on `ready`, whispers GMs a chat summary of the
 * compatibility check and (per ADR-0002) only escalates to a
 * `ui.notifications.warn` toast for pinned modules with a hard-severity
 * status or the "possibly unmaintained" flag.
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 *
 * As with manifest-fetcher.js and compatibility-classifier.js, the core
 * decision logic below is plain, pure, and dependency-injectable (no
 * Foundry `game`/`ChatMessage`/`ui` globals), so it's unit-testable with
 * Node's built-in test runner. Only the functions in the "Foundry glue"
 * section at the bottom read those globals.
 */

import { classifyActiveCompatibility } from "./compatibility-classifier.js";
import {
  STATUS_LABEL_KEYS,
  STATUS_LABEL_I18N_KEYS,
  deriveStatusLabelKey,
} from "./checker-table-logic.js";

const MODULE_ID = "the-plugin-plugin";

// ---------------------------------------------------------------------------
// Hashing (pure) — SPEC-0001 REQ "Login Notification": "determine 'changed'
// by comparing a hash of the current results against a hash stored in a
// world setting."
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit. Deterministic, dependency-free string hash — this only
 * needs to detect "did the classified results change since last login," not
 * cryptographic guarantees. ~10 lines, so no dependency is justified
 * (CLAUDE.md rule 2: no dependencies without justification).
 */
export function fnv1aHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic JSON stringification: object keys are sorted recursively so
 * the same logical data always serializes identically regardless of key
 * insertion order.
 */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

/**
 * Reduces classified packages (the `packages` array from
 * `classifyActiveCompatibility`/`classifyCompatibility`) to the fields that
 * matter for "did the results change," sorted by id for order-independence,
 * and hashes that stable shape.
 *
 * Judgment call: design.md left open whether the "results changed" hash
 * should include soft-severity packages or only hard/possibly-unmaintained
 * ones. This implementation includes every field the chat summary itself
 * reports (up-to-date, update-available, soft, hard, possibly-unmaintained,
 * couldn't-check) — "the results" means everything the notification
 * describes, not just the toast-eligible subset. The toast's own gating
 * stays separately governed by `shouldShowToast`/ADR-0002 regardless of
 * what this hash includes, so a soft-only change can cause a new *chat*
 * message under "only when changed" without ever triggering a toast.
 *
 * Issue #51 extends this same standard to the two new pieces of content the
 * chat summary now reports:
 *
 * - `pinnedModuleIds` — the pinned-module callout names a module by its
 *   pinned-and-not-clean status, so *which ids are pinned* changes what the
 *   summary renders even when every package's own classification is
 *   byte-for-byte identical to last login (e.g. a GM pins a module that
 *   already had a soft-severity status: no package field changes, but the
 *   summary now names it where it didn't before). Left out, "only when
 *   changed" would go stale exactly the way it already would have for
 *   package fields, per the reasoning above — so it's included, sorted for
 *   order-independence the same way `packages` is.
 * - `comparisonTarget` — the version-context line's wording (confirmed vs.
 *   inferred, "newer available" vs. "already current") is driven by
 *   `comparisonTarget.source`/`isNewer`/`hasPeerSignal`/`rawVersion`, which
 *   can change independently of any package's own `severity` field. The
 *   clearest case: a peer-inferred target becomes authoritative (Foundry's
 *   own update service starts reporting the same version a package had
 *   already suggested) — `comparisonTarget.value` is unchanged, so no
 *   package's severity classification moves, but the summary's confidence
 *   wording (inferred -> confirmed) does. That's a real content change the
 *   hash must catch, so the whole object is included (stableStringify
 *   handles the nested shape already).
 *
 * `runningVersion` (`game.release.version`) is deliberately NOT included:
 * it's read fresh by `runLoginNotification` on every call from the *live*
 * `game` global, and a running-version change only happens via a world
 * restart onto a new core build — which is itself a `ready` hook firing
 * fresh, not a hash lookup racing a stale cached value. Any resulting shift
 * in package severities already flows through the `packages` shape above.
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 *
 * @param {Array} packages - classified packages
 * @param {object} [options]
 * @param {Array<string>|Set<string>} [options.pinnedModuleIds]
 * @param {object|null} [options.comparisonTarget] - classification's
 *   `comparisonTarget` (see compatibility-classifier.js)
 */
export function hashResults(packages, { pinnedModuleIds = [], comparisonTarget = null } = {}) {
  const stableShape = (packages ?? [])
    .map((pkg) => ({
      id: pkg.id,
      installedVersion: pkg.installedVersion ?? null,
      latestVersion: pkg.latestVersion ?? null,
      updateAvailable: pkg.updateAvailable ?? null,
      verified: pkg.verified ?? null,
      severity: pkg.severity ?? null,
      possiblyUnmaintained: Boolean(pkg.possiblyUnmaintained),
      status: pkg.status ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const pinnedIds = Array.from(
    pinnedModuleIds instanceof Set ? pinnedModuleIds : (pinnedModuleIds ?? [])
  ).sort();

  return fnv1aHash(
    stableStringify({ packages: stableShape, pinnedModuleIds: pinnedIds, comparisonTarget })
  );
}

// ---------------------------------------------------------------------------
// Frequency gating (pure) — SPEC-0001 REQ "Login Notification": "every
// login" / "daily" / "only when results changed", default "only when
// changed."
// ---------------------------------------------------------------------------

export const NOTIFICATION_FREQUENCIES = Object.freeze({
  EVERY_LOGIN: "everyLogin",
  DAILY: "daily",
  ONLY_WHEN_CHANGED: "onlyWhenChanged",
});

export const DEFAULT_FREQUENCY = NOTIFICATION_FREQUENCIES.ONLY_WHEN_CHANGED;

function isSameCalendarDay(a, b) {
  const dateA = new Date(a);
  const dateB = new Date(b);
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

/**
 * Decides whether this login should notify at all (chat + toast are both
 * skipped together when this returns false — see Requirement: Login
 * Notification, "Results unchanged since last login" scenario).
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 *
 * @param {string} frequency - one of NOTIFICATION_FREQUENCIES
 * @param {object} state
 * @param {string} state.currentHash - hashResults() of this login's results
 * @param {string|null} [state.storedHash] - hash stored from the last
 *   *check* (persisted every login regardless of frequency, so switching
 *   frequency settings always compares against a fresh value)
 * @param {number|null} [state.lastNotifiedAt] - epoch ms of the last time a
 *   notification actually fired (only relevant to "daily")
 * @param {number} [state.now] - epoch ms "now", injectable for tests
 */
export function shouldNotifyForFrequency(
  frequency,
  { currentHash, storedHash = null, lastNotifiedAt = null, now = Date.now() } = {}
) {
  switch (frequency) {
    case NOTIFICATION_FREQUENCIES.EVERY_LOGIN:
      return true;
    case NOTIFICATION_FREQUENCIES.DAILY:
      if (lastNotifiedAt == null) return true;
      return !isSameCalendarDay(lastNotifiedAt, now);
    case NOTIFICATION_FREQUENCIES.ONLY_WHEN_CHANGED:
    default:
      return currentHash !== storedHash;
  }
}

// ---------------------------------------------------------------------------
// Toast escalation (pure) — this is the ADR-0002 enforcement point.
// ---------------------------------------------------------------------------

/**
 * Decides whether the additional `ui.notifications.warn` toast should fire,
 * on top of the chat summary (which always fires whenever `shouldNotify...`
 * says to notify at all).
 *
 * Governing: ADR-0002 (severity is scaled by declared `compatibility.
 * maximum`, not a bare `verified` lag — soft severity must NEVER escalate
 * to a toast, pinned or not), SPEC-0001 REQ "Login Notification" ("show a
 * ui.notifications.warn toast only when a pinned module has a hard-severity
 * status ... or is flagged possibly unmaintained. MUST NOT show the toast
 * for a pinned module whose only issue is soft-severity"). Pure decision
 * function — no Foundry globals — so the critical "soft-severity pinned
 * module never toasts" case is directly unit-tested.
 *
 * @param {Array<string>|Set<string>} pinnedModuleIds
 * @param {Array} packages - classified packages (each carries `id`,
 *   `severity` ('hard'|'soft'|null), `possiblyUnmaintained`)
 */
export function shouldShowToast(pinnedModuleIds, packages) {
  const pinned =
    pinnedModuleIds instanceof Set ? pinnedModuleIds : new Set(pinnedModuleIds ?? []);
  if (pinned.size === 0) return false;
  return (packages ?? []).some(
    (pkg) =>
      pinned.has(pkg.id) &&
      (pkg.severity === "hard" || pkg.possiblyUnmaintained === true)
  );
}

// ---------------------------------------------------------------------------
// Chat summary counts (pure) — feeds the whispered chat message's body.
// ---------------------------------------------------------------------------

/**
 * Reduces classified packages to the counts the chat summary reports.
 * `hardIssues`/`possiblyUnmaintained` are the "problem" figures per
 * ADR-0002/SPEC-0001 (soft severity is shown separately, never folded into
 * "issues"). `upToDate` requires no severity, no possibly-unmaintained flag,
 * and a *known* `updateAvailable === false` — a package with only a plain
 * update available isn't a compatibility "issue" but also isn't reported as
 * fully clean.
 *
 * Per ADR-0006, `updateAvailable === null` (unknown — most commonly a
 * fallback-sourced result, SPEC-0002 REQ "Fallback Field Trust") is counted
 * separately as `verifiedUpdateUnknown`, not folded into `upToDate`. Before
 * this, a package the checker table now labels "Verified, update unknown"
 * would still have been counted here as "up to date," making the chat
 * summary and the table disagree about the same package — exactly the
 * confidence-it-doesn't-have claim ADR-0006 exists to stop, just one layer
 * up.
 */
export function summarizeCompatibilityResults(packages) {
  const summary = {
    total: (packages ?? []).length,
    upToDate: 0,
    updatesAvailable: 0,
    hardIssues: 0,
    softIssues: 0,
    possiblyUnmaintained: 0,
    verifiedUpdateUnknown: 0,
    couldntCheck: 0,
  };

  for (const pkg of packages ?? []) {
    if (pkg.status === "error") {
      summary.couldntCheck++;
      continue;
    }
    if (pkg.updateAvailable) summary.updatesAvailable++;
    if (pkg.possiblyUnmaintained) summary.possiblyUnmaintained++;
    if (pkg.severity === "hard") summary.hardIssues++;
    else if (pkg.severity === "soft") summary.softIssues++;

    if (pkg.severity == null && !pkg.possiblyUnmaintained) {
      if (pkg.updateAvailable === false) {
        summary.upToDate++;
      } else if (pkg.updateAvailable == null) {
        summary.verifiedUpdateUnknown++;
      }
    }
  }

  return summary;
}

/**
 * Fixed left-to-right order the structured per-status list renders in —
 * same order as the checker table's own six-item taxonomy (see
 * `STATUS_LABEL_KEYS` in checker-table-logic.js; six as of ADR-0006), so a
 * GM who has looked at the checker window recognizes the list immediately.
 */
const STATUS_COUNT_ORDER = [
  STATUS_LABEL_KEYS.UP_TO_DATE,
  STATUS_LABEL_KEYS.UPDATE_AVAILABLE,
  STATUS_LABEL_KEYS.NOT_YET_VERIFIED,
  STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED,
  STATUS_LABEL_KEYS.VERIFIED_UPDATE_UNKNOWN,
  STATUS_LABEL_KEYS.COULDNT_CHECK,
];

/**
 * Maps `summarizeCompatibilityResults`' output onto the shared six-item
 * status taxonomy (`STATUS_LABEL_KEYS`/`STATUS_LABEL_I18N_KEYS` in
 * checker-table-logic.js — reused rather than reimplemented, per issue #51)
 * so the chat summary's structured list uses the exact same labels and
 * ordering as the checker table. `summarizeCompatibilityResults` itself is
 * untouched (its counts are not re-tallied here, only regrouped for
 * display): `hardIssues` and `softIssues` are both folded into the single
 * `notYetVerified` bucket, matching `deriveStatusLabelKey`'s own precedence
 * rule that hard and soft severity render identical status text and are
 * only ever visually (not textually) distinguished.
 *
 * Governing: SPEC-0001 REQ "Login Notification" ("per-status counts ... as
 * a structured list rather than a single prose sentence"), ADR-0006.
 *
 * @param {ReturnType<typeof summarizeCompatibilityResults>} summary
 * @returns {Array<{statusLabelKey: string, i18nKey: string, count: number}>}
 */
export function buildStatusCountEntries(summary) {
  const countByKey = {
    [STATUS_LABEL_KEYS.UP_TO_DATE]: summary?.upToDate ?? 0,
    [STATUS_LABEL_KEYS.UPDATE_AVAILABLE]: summary?.updatesAvailable ?? 0,
    [STATUS_LABEL_KEYS.NOT_YET_VERIFIED]: (summary?.hardIssues ?? 0) + (summary?.softIssues ?? 0),
    [STATUS_LABEL_KEYS.POSSIBLY_UNMAINTAINED]: summary?.possiblyUnmaintained ?? 0,
    [STATUS_LABEL_KEYS.VERIFIED_UPDATE_UNKNOWN]: summary?.verifiedUpdateUnknown ?? 0,
    [STATUS_LABEL_KEYS.COULDNT_CHECK]: summary?.couldntCheck ?? 0,
  };

  return STATUS_COUNT_ORDER.map((statusLabelKey) => ({
    statusLabelKey,
    i18nKey: STATUS_LABEL_I18N_KEYS[statusLabelKey],
    count: countByKey[statusLabelKey],
  }));
}

// ---------------------------------------------------------------------------
// Version context (pure) — SPEC-0001 REQ "Login Notification": "MUST state
// the running Foundry version and the active comparison target, and MUST
// identify whether that target is authoritative or inferred."
//
// Judgment call (documented per issue #51, not applied silently): this
// reimplements, rather than reuses, the same four-branch mapping
// `#buildComparisonTargetContext` (scripts/checker-table.js) already does
// for the checker window. That method is private, keyed to
// `CheckerTable.Target*` i18n strings scoped to the window's own longer
// paragraph copy, and this would only be its *second* call site —
// CLAUDE.md project rule 2 ("no abstraction until the third use") argues
// against extracting on that basis alone. Two more concrete reasons tip the
// same direction here:
//
// - The two surfaces need different output shapes. The window's version
//   needs CSS hook fields (`statusClass`/`iconClass`) for a persistent
//   badge; the chat summary is a single line in a whispered message with no
//   equivalent styling surface, and additionally has to fold in the running
//   Foundry version (which the window's note text doesn't mention at all —
//   see `#buildComparisonTargetContext`'s four strings). A shared function
//   would either grow parameters/branches to cover both call sites' needs,
//   or become a thin wrapper around little more than "which of 4 branches
//   applies," which is most of this function's actual logic anyway.
// - This file and scripts/checker-table.js are both mid-flight for a
//   sibling issue (#48) touching checker-table.js/checker-table-logic.js
//   for an unrelated concern in the same review window. Renaming
//   `CheckerTable.Target*` i18n keys to a neutral namespace and moving this
//   logic into checker-table-logic.js would touch the same files #48 is
//   already changing, for a refactor this issue doesn't strictly require.
//
// If a third call site for this exact branching ever shows up, that's the
// point to extract for real, with both existing call sites converted.
// ---------------------------------------------------------------------------

export const VERSION_CONTEXT_CASES = Object.freeze({
  CONFIRMED_NEWER: "confirmedNewer",
  CONFIRMED_CURRENT: "confirmedCurrent",
  INFERRED: "inferred",
  NO_EVIDENCE: "noEvidence",
});

/**
 * Maps a classification's `comparisonTarget` (see
 * compatibility-classifier.js's `determineComparisonTarget`) onto the four
 * cases the chat summary's version-context line distinguishes. Pure — the
 * caller resolves the returned `case`/`targetVersion` to actual i18n text.
 *
 * A `comparisonTarget` of `null` (classification never having run) is
 * treated the same as `NO_EVIDENCE` — "no target beyond the running
 * version is available" per REQ "Login Notification", rather than a
 * missing/omitted line.
 *
 * Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Login
 * Notification", SPEC-0001 REQ "Target Version Determination".
 *
 * @param {{source: 'authoritative'|'inferred', rawVersion: string|null, isNewer: boolean, hasPeerSignal: boolean}|null} comparisonTarget
 * @returns {{case: string, targetVersion: string|null}}
 */
export function deriveVersionContext(comparisonTarget) {
  if (!comparisonTarget) {
    return { case: VERSION_CONTEXT_CASES.NO_EVIDENCE, targetVersion: null };
  }

  if (comparisonTarget.source === "authoritative") {
    return {
      case: comparisonTarget.isNewer
        ? VERSION_CONTEXT_CASES.CONFIRMED_NEWER
        : VERSION_CONTEXT_CASES.CONFIRMED_CURRENT,
      targetVersion: comparisonTarget.rawVersion,
    };
  }

  if (comparisonTarget.hasPeerSignal) {
    return { case: VERSION_CONTEXT_CASES.INFERRED, targetVersion: comparisonTarget.rawVersion };
  }

  return { case: VERSION_CONTEXT_CASES.NO_EVIDENCE, targetVersion: null };
}

// ---------------------------------------------------------------------------
// Pinned-module callout (pure) — SPEC-0001 REQ "Login Notification": "MUST
// name each pinned module whose status is not 'Up to date & verified' ...
// Pinned modules with a clean status MUST NOT be named."
// ---------------------------------------------------------------------------

/**
 * Builds the list of pinned modules the chat summary names: every pinned
 * module whose derived status (via `deriveStatusLabelKey`, reused rather
 * than reimplemented — same status taxonomy as the checker table) is not
 * "Up to date & verified." A clean pinned module, or a pinned id with no
 * matching package in `packages` (e.g. no longer installed/active), is
 * silently excluded rather than listed. An empty return covers both "no
 * module pinned" and "every pinned module is clean" — the caller renders
 * no callout section in either case, matching REQ "Login Notification"
 * ("Pinned modules with a clean status MUST NOT be named ... the summary
 * MUST omit this section entirely" for the no-pins case).
 *
 * Naming a module here never changes `summarizeCompatibilityResults`'
 * counts or `shouldShowToast`'s decision — both are computed independently
 * from the same `packages`/`pinnedModuleIds` inputs, so a soft-severity
 * pinned module can appear in this list while still being excluded from
 * the "problem" figures and the toast (REQ "Login Notification", "Soft-
 * severity pinned module is named but not escalated" scenario).
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 *
 * @param {Array<string>|Set<string>} pinnedModuleIds
 * @param {Array} packages - classified packages
 * @returns {Array<{id: string, title: string, statusLabelKey: string, i18nKey: string}>}
 */
export function buildPinnedCallout(pinnedModuleIds, packages) {
  const pinned =
    pinnedModuleIds instanceof Set ? pinnedModuleIds : new Set(pinnedModuleIds ?? []);
  if (pinned.size === 0) return [];

  const entries = [];
  for (const pkg of packages ?? []) {
    if (!pinned.has(pkg.id)) continue;
    const statusLabelKey = deriveStatusLabelKey(pkg);
    if (statusLabelKey === STATUS_LABEL_KEYS.UP_TO_DATE) continue;
    entries.push({
      id: pkg.id,
      title: pkg.title ?? pkg.id,
      statusLabelKey,
      i18nKey: STATUS_LABEL_I18N_KEYS[statusLabelKey],
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Foundry glue: the only code below reads `game` / `game.settings` /
// `ChatMessage` / `ui` / `document`. Kept thin so the logic above stays
// testable without a running world.
// ---------------------------------------------------------------------------

export const FREQUENCY_SETTING_KEY = "notificationFrequency";
export const LAST_RESULTS_HASH_SETTING_KEY = "lastLoginNotificationHash";
export const LAST_NOTIFIED_AT_SETTING_KEY = "lastLoginNotificationAt";

// Governing: SPEC-0001 REQ "Pinned Critical Modules" — that setting is
// issue #8's scope, not this issue's. Judgment call: rather than this file
// also calling `game.settings.register` for `pinnedCriticalModules` (which
// would throw a duplicate-registration error once both branches are merged,
// since Foundry doesn't allow re-registering the same module/key pair),
// this reads the setting defensively and treats "not registered yet" the
// same as "registered but empty" — both mean "no pinned modules," which is
// already the correct default behavior (no toast fires until a GM has
// pinned something). No fallback registration needed. Key name matches
// issue #8's actual registration (`PINNED_MODULES_SETTING_KEY` in
// scripts/checker-table.js) — kept in sync during /sdd:work's post-PR
// cross-check since these two stories were implemented in parallel.
export const PINNED_MODULES_SETTING_KEY = "pinnedCriticalModules";

// data-action value read by the delegated click listener below, and
// written into the chat card's button by `postChatSummary`.
const CHECKER_OPEN_ACTION = "the-plugin-plugin-open-checker";

/**
 * Registers this file's world-scoped settings. Additive alongside
 * the-plugin-plugin.js's existing `init` hook registration — does not
 * touch `pinnedCriticalModules` (see judgment-call comment above).
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 */
export function registerLoginNotificationSettings(gameInstance = globalThis.game) {
  gameInstance.settings.register(MODULE_ID, FREQUENCY_SETTING_KEY, {
    name: "THE-PLUGIN-PLUGIN.Settings.NotificationFrequency.Name",
    hint: "THE-PLUGIN-PLUGIN.Settings.NotificationFrequency.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [NOTIFICATION_FREQUENCIES.EVERY_LOGIN]:
        "THE-PLUGIN-PLUGIN.Settings.NotificationFrequency.Choices.EveryLogin",
      [NOTIFICATION_FREQUENCIES.DAILY]:
        "THE-PLUGIN-PLUGIN.Settings.NotificationFrequency.Choices.Daily",
      [NOTIFICATION_FREQUENCIES.ONLY_WHEN_CHANGED]:
        "THE-PLUGIN-PLUGIN.Settings.NotificationFrequency.Choices.OnlyWhenChanged",
    },
    default: DEFAULT_FREQUENCY,
  });

  // Internal bookkeeping (not GM-facing), same pattern as issue #7's
  // `previousPackageVersions` setting in compatibility-classifier.js.
  gameInstance.settings.register(MODULE_ID, LAST_RESULTS_HASH_SETTING_KEY, {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  gameInstance.settings.register(MODULE_ID, LAST_NOTIFIED_AT_SETTING_KEY, {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  });
}

function readFrequencySetting(gameInstance) {
  try {
    return gameInstance?.settings?.get(MODULE_ID, FREQUENCY_SETTING_KEY) ?? DEFAULT_FREQUENCY;
  } catch {
    return DEFAULT_FREQUENCY;
  }
}

function readStoredHash(gameInstance) {
  try {
    return gameInstance?.settings?.get(MODULE_ID, LAST_RESULTS_HASH_SETTING_KEY) || null;
  } catch {
    return null;
  }
}

async function writeStoredHash(gameInstance, hash) {
  try {
    await gameInstance?.settings?.set(MODULE_ID, LAST_RESULTS_HASH_SETTING_KEY, hash);
  } catch (err) {
    console.warn(`${MODULE_ID} | login notification: failed to persist results hash`, err);
  }
}

function readLastNotifiedAt(gameInstance) {
  try {
    return gameInstance?.settings?.get(MODULE_ID, LAST_NOTIFIED_AT_SETTING_KEY) || null;
  } catch {
    return null;
  }
}

async function writeLastNotifiedAt(gameInstance, timestamp) {
  try {
    await gameInstance?.settings?.set(MODULE_ID, LAST_NOTIFIED_AT_SETTING_KEY, timestamp);
  } catch (err) {
    console.warn(`${MODULE_ID} | login notification: failed to persist last-notified time`, err);
  }
}

/** See PINNED_MODULES_SETTING_KEY comment: defensive read, empty default. */
function readPinnedModuleIds(gameInstance) {
  try {
    const value = gameInstance?.settings?.get(MODULE_ID, PINNED_MODULES_SETTING_KEY);
    if (!value) return [];
    return Array.isArray(value) ? value : Array.from(value);
  } catch {
    return [];
  }
}

/** Maps a `VERSION_CONTEXT_CASES` value to its languages/en.json key. */
const VERSION_CONTEXT_I18N_KEYS = {
  [VERSION_CONTEXT_CASES.CONFIRMED_NEWER]:
    "THE-PLUGIN-PLUGIN.LoginNotification.VersionContextConfirmedNewer",
  [VERSION_CONTEXT_CASES.CONFIRMED_CURRENT]:
    "THE-PLUGIN-PLUGIN.LoginNotification.VersionContextConfirmedCurrent",
  [VERSION_CONTEXT_CASES.INFERRED]: "THE-PLUGIN-PLUGIN.LoginNotification.VersionContextInferred",
  [VERSION_CONTEXT_CASES.NO_EVIDENCE]:
    "THE-PLUGIN-PLUGIN.LoginNotification.VersionContextNoEvidence",
};

/**
 * Builds the whispered chat message's HTML content and posts it via
 * `ChatMessage.create` (standard behavior — persists in the chat log like
 * any other message). Includes a button wired to the delegated click
 * listener below, which defensively no-ops if issue #8's
 * `api.openCheckerTable` isn't available yet.
 *
 * Governing: SPEC-0001 REQ "Login Notification" ("whispered chat message
 * ... with buttons or links to open the checker window ... MUST persist in
 * the chat log"; structured per-status list; version-context line;
 * pinned-module callout; volunteer reminder removed — see design.md "The
 * login notification answers 'does this need me?', the window answers
 * 'what exactly?'").
 *
 * @param {object} gameInstance
 * @param {object} summary - `summarizeCompatibilityResults` output
 * @param {object|null} comparisonTarget - classification's `comparisonTarget`
 * @param {string|null} runningVersion - `game.release.version`
 * @param {Array<string>|Set<string>} pinnedModuleIds
 * @param {Array} packages - classified packages (for the pinned callout)
 */
async function postChatSummary(
  gameInstance,
  { summary, comparisonTarget, runningVersion, pinnedModuleIds, packages }
) {
  const i18n = gameInstance.i18n;

  // Governing: SPEC-0001 REQ "Login Notification" — "MUST present its
  // per-status counts as a structured list rather than a single prose
  // sentence."
  const statusItems = buildStatusCountEntries(summary)
    .map(
      (entry) =>
        `<li>${i18n.format("THE-PLUGIN-PLUGIN.LoginNotification.StatusCountItem", {
          label: i18n.localize(entry.i18nKey),
          count: entry.count,
        })}</li>`
    )
    .join("");

  // Governing: SPEC-0001 REQ "Login Notification" — "MUST state the running
  // Foundry version and the active comparison target, and MUST identify
  // whether that target is authoritative or inferred ... When no target
  // beyond the running version is available, it MUST say so rather than
  // omitting the line."
  const versionContext = deriveVersionContext(comparisonTarget);
  const versionContextNote = i18n.format(VERSION_CONTEXT_I18N_KEYS[versionContext.case], {
    runningVersion: runningVersion ?? i18n.localize("THE-PLUGIN-PLUGIN.LoginNotification.VersionUnknown"),
    targetVersion: versionContext.targetVersion ?? "",
  });

  // Governing: SPEC-0001 REQ "Login Notification" — "MUST name each pinned
  // module whose status is not 'Up to date & verified' ... When no module
  // is pinned, the summary MUST omit this section entirely."
  const pinnedEntries = buildPinnedCallout(pinnedModuleIds, packages);
  const pinnedSection = pinnedEntries.length
    ? [
        `<p class="the-plugin-plugin-pinned-heading">${i18n.localize(
          "THE-PLUGIN-PLUGIN.LoginNotification.PinnedHeading"
        )}</p>`,
        `<ul class="the-plugin-plugin-pinned-list">`,
        pinnedEntries
          .map(
            (entry) =>
              `<li>${i18n.format("THE-PLUGIN-PLUGIN.LoginNotification.PinnedItem", {
                title: entry.title,
                status: i18n.localize(entry.i18nKey),
              })}</li>`
          )
          .join(""),
        `</ul>`,
      ].join("")
    : "";

  const content = [
    `<div class="the-plugin-plugin-login-summary">`,
    `<p class="the-plugin-plugin-version-context">${versionContextNote}</p>`,
    `<p>${i18n.format("THE-PLUGIN-PLUGIN.LoginNotification.ResultsHeading", {
      total: summary.total,
    })}</p>`,
    `<ul class="the-plugin-plugin-status-list">${statusItems}</ul>`,
    pinnedSection,
    `<button type="button" data-action="${CHECKER_OPEN_ACTION}">${i18n.localize(
      "THE-PLUGIN-PLUGIN.LoginNotification.OpenChecker"
    )}</button>`,
    `</div>`,
  ].join("");

  const whisper = ChatMessage.getWhisperRecipients("GM").map((user) => user.id);

  return ChatMessage.create({
    content,
    whisper,
    speaker: { alias: i18n.localize("THE-PLUGIN-PLUGIN.Title") },
  });
}

/**
 * Delegated click listener for the chat card's "open checker" button.
 * Delegated (attached once, to `document`) rather than attached per-message,
 * since chat messages render independently of when this module's `ready`
 * hook runs. Calls `api.openCheckerTable` defensively via optional
 * chaining — issue #8 (the checker window) may not have merged yet, in
 * which case the button still renders but silently does nothing when
 * clicked, per the coordination convention documented in this PR. Name
 * matches issue #8's actual export (`openCheckerTable` in
 * scripts/checker-table.js).
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 */
export function registerCheckerOpenClickListener(
  doc = globalThis.document,
  gameInstance = globalThis.game
) {
  doc?.addEventListener("click", (event) => {
    const trigger = event.target?.closest?.(`[data-action="${CHECKER_OPEN_ACTION}"]`);
    if (!trigger) return;
    gameInstance?.modules?.get(MODULE_ID)?.api?.openCheckerTable?.();
  });
}

/**
 * Thin wrapper run on `ready`: classifies active packages (reusing issue
 * #6/#7's fetch + classification pipeline via the module API), applies the
 * frequency gate, and — only when that gate says to notify — posts the
 * whispered chat summary and, per ADR-0002, conditionally the pinned-module
 * toast. GM-only (a non-GM `ready` is a silent no-op).
 *
 * Governing: SPEC-0001 REQ "Login Notification".
 */
export async function runLoginNotification(options = {}) {
  const gameInstance = options.game ?? globalThis.game;
  if (!gameInstance?.user?.isGM) return;

  let classification = options.classification;
  if (!classification) {
    try {
      classification = await classifyActiveCompatibility({ game: gameInstance });
    } catch (err) {
      console.error(`${MODULE_ID} | login notification: compatibility check failed`, err);
      return;
    }
  }

  const packages = classification?.packages ?? [];
  const comparisonTarget = classification?.comparisonTarget ?? null;
  // Read once up front (not just for toast gating, as before issue #51) so
  // the same pinned-ids snapshot feeds both the hash (see hashResults'
  // docstring for why the pin set must be covered) and the chat summary's
  // pinned-module callout.
  const pinnedModuleIds = readPinnedModuleIds(gameInstance);
  const currentHash = hashResults(packages, { pinnedModuleIds, comparisonTarget });
  const frequency = readFrequencySetting(gameInstance);
  const storedHash = readStoredHash(gameInstance);
  const lastNotifiedAt = readLastNotifiedAt(gameInstance);

  const notify = shouldNotifyForFrequency(frequency, {
    currentHash,
    storedHash,
    lastNotifiedAt,
  });

  // Always persist the freshest hash, independent of whether this specific
  // login notifies, so a later "onlyWhenChanged" check (or a frequency
  // setting change) always compares against the most recent results rather
  // than a stale one.
  await writeStoredHash(gameInstance, currentHash);

  if (!notify) return;

  const summary = summarizeCompatibilityResults(packages);

  try {
    await postChatSummary(gameInstance, {
      summary,
      comparisonTarget,
      runningVersion: gameInstance?.release?.version ?? null,
      pinnedModuleIds,
      packages,
    });
  } catch (err) {
    console.error(`${MODULE_ID} | login notification: failed to post chat summary`, err);
  }

  if (shouldShowToast(pinnedModuleIds, packages)) {
    globalThis.ui?.notifications?.warn(
      gameInstance.i18n.localize("THE-PLUGIN-PLUGIN.LoginNotification.ToastWarning")
    );
  }

  await writeLastNotifiedAt(gameInstance, Date.now());
}
