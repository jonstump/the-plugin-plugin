import {
  checkActivePackages,
  clearManifestCache,
  DEFAULT_CONCURRENCY,
} from "./manifest-fetcher.js";
import {
  classifyActiveCompatibility,
  classifyCompatibility,
  PREVIOUS_VERSIONS_SETTING_KEY,
} from "./compatibility-classifier.js";

const MODULE_ID = "the-plugin-plugin";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | initializing`);

  // Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" — internal
  // bookkeeping (last-seen manifest version per package, used to detect a
  // frozen version across logins), not a GM-facing option, hence
  // `config: false`.
  game.settings.register(MODULE_ID, PREVIOUS_VERSIONS_SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
});

// Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Fetch
// Concurrency and Caching", SPEC-0001 REQ "Inferred Latest Version",
// SPEC-0001 REQ "Compatibility Severity Classification", SPEC-0001 REQ
// "Possibly Unmaintained Heuristic" — expose the manifest-fetch pass and the
// classification layer on the module's API namespace so the checker table
// (issue #8) and login notification (issue #9) can consume both without
// re-implementing fetch, cache, or classification logic.
Hooks.once("setup", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      checkActivePackages,
      clearManifestCache,
      DEFAULT_CONCURRENCY,
      classifyActiveCompatibility,
      classifyCompatibility,
    };
  }
});
