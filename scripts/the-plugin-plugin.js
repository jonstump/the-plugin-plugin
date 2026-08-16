import {
  checkActivePackages,
  clearManifestCache,
  DEFAULT_CONCURRENCY,
} from "./manifest-fetcher.js";
import {
  classifyActiveCompatibility,
  classifyCompatibility,
} from "./compatibility-classifier.js";
import {
  CheckerTableApp,
  openCheckerTable,
  PINNED_MODULES_SETTING_KEY,
} from "./checker-table.js";
import {
  registerLoginNotificationSettings,
  registerCheckerOpenClickListener,
  runLoginNotification,
} from "./login-notification.js";

const MODULE_ID = "the-plugin-plugin";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | initializing`);

  // Governing: SPEC-0001 REQ "Pinned Critical Modules" — world-scoped set of
  // pinned module ids (stored as a plain array; see checker-table.js's
  // togglePinned/isPinned). Not a GM-facing settings-menu option (it's
  // toggled from the checker table's per-row pin control), hence
  // `config: false`.
  game.settings.register(MODULE_ID, PINNED_MODULES_SETTING_KEY, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  // Governing: SPEC-0001 REQ "Login Notification" — frequency setting plus
  // its internal bookkeeping (last-seen results hash, last-notified time).
  registerLoginNotificationSettings(game);
});

// Governing: SPEC-0001 REQ "Login Notification" — GM-only whispered chat
// summary on `ready`, escalating to a toast only for pinned modules with a
// hard-severity status or the "possibly unmaintained" flag (ADR-0002).
Hooks.once("ready", () => {
  registerCheckerOpenClickListener();
  runLoginNotification();
});

// Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Fetch
// Concurrency and Caching", SPEC-0001 REQ "Inferred Latest Version",
// SPEC-0001 REQ "Compatibility Severity Classification", SPEC-0001 REQ
// "Possibly Unmaintained Heuristic", SPEC-0001 REQ "Checker Table" — expose
// the manifest-fetch pass, the classification layer, and the checker table
// window on the module's API namespace so the login notification (issue #9)
// can open the same checker window (e.g. from its chat message button)
// without re-implementing fetch, cache, classification, or rendering logic.
Hooks.once("setup", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      checkActivePackages,
      clearManifestCache,
      DEFAULT_CONCURRENCY,
      classifyActiveCompatibility,
      classifyCompatibility,
      openCheckerTable,
      CheckerTableApp,
    };
  }
});
