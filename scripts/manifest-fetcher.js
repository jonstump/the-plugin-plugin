/**
 * Manifest fetching, error isolation, concurrency limiting, and session
 * caching for the compatibility checker.
 *
 * Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Error Handling
 * Standards", SPEC-0001 REQ "Fetch Concurrency and Caching", ADR-0001 (this
 * module only ever fetches a package's own declared `manifest` URL — it
 * never contacts foundryvtt.com or any other third-party service for core
 * version data).
 *
 * The functions below are written to be pure / dependency-injectable
 * (fetch implementation, cache, AbortSignal are all parameters) so the core
 * logic — the concurrency pool, per-package error isolation, and the
 * session cache — can be unit-tested with Node's built-in test runner
 * outside a running Foundry world. `getActivePackagesFromGame` and
 * `checkActivePackages` are the only pieces that read the Foundry `game`
 * global, and they're thin wrappers around the pure logic above them.
 */

// Governing: SPEC-0001 REQ "Fetch Concurrency and Caching"
// No existing dependency in this project limits concurrency, and adding one
// for a single hand-rollable use isn't justified (CLAUDE.md rule 2: no
// dependencies without justification) — this pool is ~15 lines.
export const DEFAULT_CONCURRENCY = 6;

// Governing: SPEC-0001 REQ "Fetch Concurrency and Caching"
// Module-level singleton so re-opening the checker window within the same
// session reuses results instead of re-fetching. Keyed by package id.
// Callers that want an isolated cache (tests, or a forced full reset) can
// pass their own Map via the `cache` option instead.
const sessionCache = new Map();

/** Clears cached results. Defaults to the module's session cache. */
export function clearManifestCache(cache = sessionCache) {
  cache.clear();
}

/**
 * A small hand-rolled concurrency pool: runs `worker` over `items` with at
 * most `concurrency` calls in flight at once, preserving input order in the
 * returned array. Not a general-purpose queue — just enough to satisfy the
 * "cap in-flight fetches" requirement without a dependency.
 *
 * Governing: SPEC-0001 REQ "Fetch Concurrency and Caching"
 */
export async function runWithConcurrency(items, worker, options = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, signal } = options;
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runSlot() {
    for (;;) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index, signal);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: poolSize }, () => runSlot()));
  return results;
}

/**
 * Minimal version comparator so core logic doesn't depend on the Foundry
 * global (`foundry.utils.isNewerVersion`) and stays testable outside a
 * running world. Compares dot/dash/plus-separated segments numerically
 * where both sides parse as numbers, otherwise falls back to string
 * comparison for that segment (handles suffixes like "-beta").
 *
 * Returns -1, 0, or 1.
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  const partsA = String(a).split(/[.\-+]/);
  const partsB = String(b).split(/[.\-+]/);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const segA = partsA[i];
    const segB = partsB[i];
    if (segA === undefined) return -1;
    if (segB === undefined) return 1;
    if (segA === segB) continue;

    const numA = Number(segA);
    const numB = Number(segB);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) return numA < numB ? -1 : 1;
    } else if (segA !== segB) {
      return segA < segB ? -1 : 1;
    }
  }
  return 0;
}

/** True when `candidate` is a newer version string than `base`. */
export function isNewerVersion(candidate, base) {
  return compareVersions(candidate, base) > 0;
}

function errorResult(pkg, message) {
  return {
    id: pkg.id,
    title: pkg.title ?? pkg.id,
    isSystem: Boolean(pkg.isSystem),
    manifestUrl: pkg.manifestUrl ?? null,
    installedVersion: pkg.installedVersion ?? null,
    latestVersion: null,
    updateAvailable: null,
    verified: null,
    compatibility: null,
    // Governing: SPEC-0001 REQ "Checker Table", SPEC-0001 REQ "Possibly
    // Unmaintained Heuristic" — link-out fields, null when the manifest
    // couldn't be fetched at all.
    links: null,
    status: "error",
    // Governing: SPEC-0001 REQ "Error Handling Standards" — every failure is
    // attributable to the specific package it occurred for.
    error: { packageId: pkg.id, message },
  };
}

function buildOkResult(pkg, manifest) {
  const rawVerified = manifest?.compatibility?.verified ?? null;
  const compatibleCoreVersion = manifest?.compatibleCoreVersion ?? null;
  // Governing: SPEC-0001 REQ "Manifest Check" — fall back to the legacy
  // compatibleCoreVersion field when `compatibility` is absent.
  const verified = rawVerified ?? compatibleCoreVersion ?? null;
  const latestVersion = manifest?.version ?? null;

  const updateAvailable =
    latestVersion != null && pkg.installedVersion != null
      ? isNewerVersion(latestVersion, pkg.installedVersion)
      : null; // unknown — not enough data to compare

  return {
    id: pkg.id,
    title: pkg.title ?? pkg.id,
    isSystem: Boolean(pkg.isSystem),
    manifestUrl: pkg.manifestUrl ?? null,
    installedVersion: pkg.installedVersion ?? null,
    latestVersion,
    updateAvailable,
    // Convenience field already folded through the legacy fallback, so this
    // module's own "verified vs. game.release" comparison (issue scope)
    // doesn't need to know about compatibleCoreVersion.
    verified,
    // Raw fields preserved for downstream consumers (issue #7's severity
    // classification per ADR-0002) which needs compatibility.maximum and the
    // unfolded compatibleCoreVersion, not just a pre-computed verdict.
    compatibility: {
      verified: rawVerified,
      maximum: manifest?.compatibility?.maximum ?? null,
      minimum: manifest?.compatibility?.minimum ?? null,
      compatibleCoreVersion,
    },
    // Governing: SPEC-0001 REQ "Checker Table" (link-out buttons, issue #8),
    // SPEC-0001 REQ "Possibly Unmaintained Heuristic" (issue #7 needs `url`/
    // `bugs` to detect a GitHub-hosted repo for the archived-repo check).
    // Sourced from the *fetched* manifest, same object already parsed above
    // — no new network call.
    links: {
      url: manifest?.url ?? null,
      bugs: manifest?.bugs ?? null,
      changelog: manifest?.changelog ?? null,
    },
    status: "ok",
    error: null,
  };
}

/**
 * Fetches and parses a single package's manifest, never throwing — every
 * failure mode (missing URL, network error, non-200, malformed JSON, abort)
 * resolves to an error result attributed to this package.
 *
 * Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Error Handling
 * Standards", ADR-0001 (only ever fetches the package's own manifest URL).
 */
export async function fetchPackageManifest(pkg, options = {}) {
  const { fetchImpl = fetch, signal } = options;

  if (!pkg.manifestUrl) {
    return errorResult(pkg, "No manifest URL declared for this package");
  }

  let response;
  try {
    response = await fetchImpl(pkg.manifestUrl, { signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      return errorResult(pkg, "Manifest fetch was cancelled");
    }
    return errorResult(pkg, err?.message ?? String(err));
  }

  if (!response.ok) {
    return errorResult(
      pkg,
      `Manifest request failed with status ${response.status}`
    );
  }

  let manifest;
  try {
    manifest = await response.json();
  } catch (err) {
    return errorResult(
      pkg,
      `Manifest response was not valid JSON: ${err?.message ?? err}`
    );
  }

  return buildOkResult(pkg, manifest);
}

/**
 * Checks a list of packages: concurrency-limited, session-cached, and
 * cancellable. Each package's failure is isolated — see
 * `fetchPackageManifest`. Returns results in the same order as `packages`,
 * except entries that were still in flight when `signal` aborted are
 * omitted (a cancelled scan does not report placeholder results).
 *
 * Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Fetch
 * Concurrency and Caching"
 */
export async function checkPackages(packages, options = {}) {
  const {
    fetchImpl = fetch,
    concurrency = DEFAULT_CONCURRENCY,
    cache = sessionCache,
    signal,
    forceRefresh = false,
  } = options;

  const results = new Array(packages.length);
  const pending = [];

  packages.forEach((pkg, index) => {
    if (!forceRefresh && cache.has(pkg.id)) {
      results[index] = cache.get(pkg.id);
    } else {
      pending.push({ pkg, index });
    }
  });

  await runWithConcurrency(
    pending,
    async ({ pkg, index }) => {
      const result = await fetchPackageManifest(pkg, { fetchImpl, signal });
      if (signal?.aborted) return; // don't cache a cancelled/partial result
      cache.set(pkg.id, result);
      results[index] = result;
    },
    { concurrency, signal }
  );

  return results.filter((result) => result !== undefined);
}

// ---------------------------------------------------------------------------
// Foundry-glue: the only functions below read the `game` global. Kept thin
// so the logic above stays testable without a running world.
// ---------------------------------------------------------------------------

function toPackageInfo(pkg, isSystem = false) {
  return {
    id: pkg.id,
    title: pkg.title ?? pkg.id,
    manifestUrl: pkg.manifest ?? null,
    installedVersion: pkg.version ?? null,
    isSystem,
  };
}

/**
 * Governing: SPEC-0001 REQ "Manifest Check" — active modules plus the
 * active game system are the full package set in scope for this check.
 */
export function getActivePackagesFromGame(gameInstance = globalThis.game) {
  const modules = Array.from(gameInstance?.modules ?? [])
    .filter(([, mod]) => mod.active)
    .map(([, mod]) => toPackageInfo(mod));

  const system = gameInstance?.system;
  return system ? [...modules, toPackageInfo(system, true)] : modules;
}

/**
 * Thin wrapper: pulls the active package list from `game.modules` /
 * `game.system` and hands it to the pure `checkPackages` logic.
 *
 * Governing: SPEC-0001 REQ "Manifest Check", ADR-0001
 */
export async function checkActivePackages(options = {}) {
  const gameInstance = options.game ?? globalThis.game;
  const packages = getActivePackagesFromGame(gameInstance);
  return checkPackages(packages, options);
}
