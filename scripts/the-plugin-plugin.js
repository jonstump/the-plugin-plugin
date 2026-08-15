import {
  checkActivePackages,
  clearManifestCache,
  DEFAULT_CONCURRENCY,
} from "./manifest-fetcher.js";

const MODULE_ID = "the-plugin-plugin";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | initializing`);
});

// Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Fetch
// Concurrency and Caching" — expose the manifest-fetch pass on the module's
// API namespace so the checker UI and login notification (separate,
// later issues) can consume it without re-implementing fetch/cache logic.
Hooks.once("setup", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = { checkActivePackages, clearManifestCache, DEFAULT_CONCURRENCY };
  }
});
