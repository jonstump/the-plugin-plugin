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
 * Governing: SPEC-0001 REQ "Login Notification".
 */
export function hashResults(packages) {
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
  return fnv1aHash(stableStringify(stableShape));
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
 * "issues"). `upToDate` requires no update, no severity, and no
 * possibly-unmaintained flag — a package with only a plain update available
 * isn't a compatibility "issue" but also isn't reported as fully clean.
 */
export function summarizeCompatibilityResults(packages) {
  const summary = {
    total: (packages ?? []).length,
    upToDate: 0,
    updatesAvailable: 0,
    hardIssues: 0,
    softIssues: 0,
    possiblyUnmaintained: 0,
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

    if (
      !pkg.updateAvailable &&
      pkg.severity == null &&
      !pkg.possiblyUnmaintained
    ) {
      summary.upToDate++;
    }
  }

  return summary;
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

/**
 * Builds the whispered chat message's HTML content and posts it via
 * `ChatMessage.create` (standard behavior — persists in the chat log like
 * any other message). Includes a button wired to the delegated click
 * listener below, which defensively no-ops if issue #8's
 * `api.openCheckerTable` isn't available yet.
 *
 * Governing: SPEC-0001 REQ "Login Notification" ("whispered chat message
 * ... with buttons or links to open the checker window ... MUST persist in
 * the chat log").
 */
async function postChatSummary(gameInstance, summary) {
  const i18n = gameInstance.i18n;
  const content = [
    `<div class="the-plugin-plugin-login-summary">`,
    `<p>${i18n.format("THE-PLUGIN-PLUGIN.LoginNotification.Summary", {
      total: summary.total,
      upToDate: summary.upToDate,
      updatesAvailable: summary.updatesAvailable,
      issues: summary.hardIssues,
      unmaintained: summary.possiblyUnmaintained,
      couldntCheck: summary.couldntCheck,
    })}</p>`,
    `<p class="the-plugin-plugin-volunteer-reminder">${i18n.localize(
      "THE-PLUGIN-PLUGIN.LoginNotification.VolunteerReminder"
    )}</p>`,
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
  const currentHash = hashResults(packages);
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
    await postChatSummary(gameInstance, summary);
  } catch (err) {
    console.error(`${MODULE_ID} | login notification: failed to post chat summary`, err);
  }

  const pinnedModuleIds = readPinnedModuleIds(gameInstance);
  if (shouldShowToast(pinnedModuleIds, packages)) {
    globalThis.ui?.notifications?.warn(
      gameInstance.i18n.localize("THE-PLUGIN-PLUGIN.LoginNotification.ToastWarning")
    );
  }

  await writeLastNotifiedAt(gameInstance, Date.now());
}
