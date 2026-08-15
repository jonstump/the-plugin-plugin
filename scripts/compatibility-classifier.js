/**
 * Compatibility classification: builds on top of issue #6's
 * `manifest-fetcher.js` fetch results (never re-fetches a manifest) to
 * compute the three v1 signals that are shared foundation for the checker
 * table (issue #8) and login notification (issue #9):
 *
 *  - `inferredLatest` — a stand-in "newer Foundry generation" target,
 *    inferred from peer manifests (ADR-0001).
 *  - `severity` — hard/soft classification per package, gated on
 *    `compatibility.maximum` rather than a bare `verified` lag (ADR-0002).
 *  - `possiblyUnmaintained` — a two-signal heuristic layered on top of
 *    severity, never a synonym for "dead"/"broken"/"abandoned".
 *
 * As with manifest-fetcher.js, the core logic here is plain, pure, and
 * dependency-injectable (fetch implementation, previously-seen versions,
 * and the Foundry `game` global are all parameters) so it's unit-testable
 * with Node's built-in test runner outside a running Foundry world. Only
 * the functions in the "Foundry glue" section at the bottom read `game` /
 * `game.settings`.
 */

import {
  DEFAULT_CONCURRENCY,
  runWithConcurrency,
  isNewerVersion,
  checkActivePackages,
} from "./manifest-fetcher.js";

const MODULE_ID = "the-plugin-plugin";

// ---------------------------------------------------------------------------
// Requirement: Inferred Latest Version
// ---------------------------------------------------------------------------

/**
 * `inferredLatest` = the highest `compatibility.verified` observed across
 * every fetched, successfully-checked package (including the active game
 * system, which arrives in `results` like any other package — see
 * `getActivePackagesFromGame`), counting only values strictly newer than
 * `gameRelease`. Pure and synchronous: no new network calls, computed
 * entirely from data `checkActivePackages`/`checkPackages` already fetched.
 *
 * Governing: ADR-0001 (infer a likely-newer Foundry version from installed
 * packages' own manifests, never contact foundryvtt.com), SPEC-0001 REQ
 * "Inferred Latest Version".
 *
 * @param {Array} results - package results from checkPackages/checkActivePackages
 * @param {string|null} gameRelease - the currently running Foundry version
 * @returns {{ value: string|null, hasPeerSignal: boolean }}
 *   `hasPeerSignal` is false when no package's `verified` exceeds
 *   `gameRelease` — callers MUST report "no evidence of a newer Foundry
 *   generation" in that case, never assert `gameRelease` is the latest one
 *   that exists (SPEC-0001 "No peer signal" scenario).
 */
export function computeInferredLatest(results, gameRelease) {
  let highestPeer = null;

  for (const result of results) {
    if (result.status !== "ok" || result.verified == null) continue;
    // Only a package verified *ahead* of the running version counts as peer
    // evidence that a newer generation exists — a package merely at parity
    // with game.release says nothing about anything newer.
    if (gameRelease != null && !isNewerVersion(result.verified, gameRelease)) {
      continue;
    }
    if (highestPeer == null || isNewerVersion(result.verified, highestPeer)) {
      highestPeer = result.verified;
    }
  }

  return { value: highestPeer, hasPeerSignal: highestPeer != null };
}

// ---------------------------------------------------------------------------
// Requirement: Compatibility Severity Classification
// ---------------------------------------------------------------------------

/** verified >= target -> true (verifies); verified < target -> false; either missing -> null (insufficient data). */
function targetIsVerified(verified, target) {
  if (verified == null || target == null) return null;
  return !isNewerVersion(target, verified);
}

/**
 * Classifies one package against one comparison target.
 * Governing: ADR-0002, SPEC-0001 REQ "Compatibility Severity Classification".
 */
function classifyAgainstTarget(maximum, verified, target) {
  const verifies = targetIsVerified(verified, target);
  if (verifies !== false) {
    // Either verified (true) or not enough data to say either way (null) —
    // neither case is evidence of a problem against this target.
    return { target: target ?? null, verifies, severity: null };
  }
  // verified is behind this target. Hard only when the developer declared an
  // explicit ceiling (`compatibility.maximum`) that is itself below the
  // target; otherwise it's a bare bookkeeping lag (soft).
  const hard = maximum != null && isNewerVersion(target, maximum);
  return { target, verifies: false, severity: hard ? "hard" : "soft" };
}

/**
 * Judgment call (not fully disambiguated by SPEC-0001): a package can be
 * hard-severity against one comparison target and soft (or clean) against
 * the other, since `game.release` and `inferredLatest` are different
 * targets. When they disagree, this classifier reports the *stronger*
 * claim — hard wins over soft wins over null — on the reasoning that a
 * genuine developer-declared ceiling (hard, against either target) is real
 * information that shouldn't be diluted just because the *other* target
 * happens to look softer.
 */
function combineSeverity(a, b) {
  if (a === "hard" || b === "hard") return "hard";
  if (a === "soft" || b === "soft") return "soft";
  return null;
}

/**
 * Classifies `inferredLatest`/`game.release` severity for every package in
 * `results`. Pure and synchronous — no network calls.
 *
 * Governing: ADR-0001, ADR-0002, SPEC-0001 REQ "Inferred Latest Version",
 * SPEC-0001 REQ "Compatibility Severity Classification".
 *
 * @param {Array} results - package results from checkPackages/checkActivePackages
 * @param {string|null} gameRelease - the currently running Foundry version
 * @returns {{ inferredLatest: {value:string|null,hasPeerSignal:boolean}, packages: Array }}
 *   Each package gains:
 *   - `gameReleaseComparison` / `inferredLatestComparison`:
 *     `{ target, verifies: boolean|null, severity: 'hard'|'soft'|null }`
 *   - `severity`: `'hard'|'soft'|null` — the stronger of the two targets'
 *     severities (see `combineSeverity` above).
 *   - `failsVerifiedCheck`: boolean — true when `verified` verifies
 *     neither `game.release` nor `inferredLatest` (SPEC-0001 "Possibly
 *     Unmaintained Heuristic" precondition). This is distinct from
 *     `severity`: a soft-severity package still "fails" this check, it
 *     just isn't a developer-declared hard ceiling.
 */
export function classifyPackages(results, gameRelease) {
  const inferredLatest = computeInferredLatest(results, gameRelease);

  const packages = results.map((result) => {
    const maximum = result.compatibility?.maximum ?? null;
    const verified = result.verified ?? null;

    const gameReleaseComparison = classifyAgainstTarget(
      maximum,
      verified,
      gameRelease ?? null
    );
    const inferredLatestComparison =
      inferredLatest.value != null
        ? classifyAgainstTarget(maximum, verified, inferredLatest.value)
        : { target: null, verifies: null, severity: null };

    const severity = combineSeverity(
      gameReleaseComparison.severity,
      inferredLatestComparison.severity
    );

    // Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" — "fails
    // neither game.release nor inferredLatest" read literally: game.release
    // must resolve to a hard "no" (verifies === false), and inferredLatest
    // must not resolve to a "yes" (covers both a hard "no" and "no target
    // exists", i.e. no peer signal).
    const failsVerifiedCheck =
      gameReleaseComparison.verifies === false &&
      inferredLatestComparison.verifies !== true;

    return {
      ...result,
      gameReleaseComparison,
      inferredLatestComparison,
      severity,
      failsVerifiedCheck,
    };
  });

  return { inferredLatest, packages };
}

// ---------------------------------------------------------------------------
// Requirement: Possibly Unmaintained Heuristic
// ---------------------------------------------------------------------------

/**
 * Parses an `owner/repo` pair out of a github.com URL. Returns null for
 * anything else (including malformed URLs), so callers can treat "not a
 * GitHub repo" identically to "couldn't parse".
 */
export function parseGithubRepo(urlString) {
  if (!urlString || typeof urlString !== "string") return null;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, repoRaw] = segments;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Queries the unauthenticated GitHub API for a repo's `archived` field.
 * Never throws — any failure (network error, non-200, rate limit, abort)
 * resolves to `{ archived: null }`, which callers MUST treat as "unknown",
 * never as evidence toward or against "possibly unmaintained".
 *
 * Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" ("MUST treat a
 * GitHub API failure ... as unknown"), design.md decision ("GitHub archived
 * lookup is scoped to already-failing packages only" — enforced by the
 * caller, `applyPossiblyUnmaintainedHeuristic`, not by this function).
 */
export async function checkGithubArchived(ownerRepo, options = {}) {
  const { fetchImpl = fetch, signal } = options;
  if (!ownerRepo) return { archived: null, reason: "not-a-github-repo" };

  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}`,
      { signal, headers: { Accept: "application/vnd.github+json" } }
    );
  } catch (err) {
    return { archived: null, reason: err?.message ?? String(err) };
  }

  if (!response.ok) {
    return { archived: null, reason: `github-api-status-${response.status}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      archived: null,
      reason: `github-api-response-not-json: ${err?.message ?? err}`,
    };
  }

  return { archived: Boolean(data.archived), reason: null };
}

/** previous === current -> true (frozen); known and different -> false; no baseline yet -> null (unknown). */
function isVersionFrozen(pkg, previousVersions) {
  const previous = previousVersions?.[pkg.id];
  if (previous == null || pkg.latestVersion == null) return null;
  return previous === pkg.latestVersion;
}

/**
 * Layers the "possibly unmaintained" flag onto packages already classified
 * by `classifyPackages`. Only queries the GitHub API for packages that are
 * already failing the verified-compatibility check (`failsVerifiedCheck`),
 * per SPEC-0001 and the design.md decision to keep GitHub API volume
 * proportional to actual candidates, respecting the unauthenticated rate
 * limit.
 *
 * Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic", SPEC-0001 REQ
 * "Fetch Concurrency and Caching" (reuses the same concurrency pool as the
 * manifest fetch pass).
 *
 * @param {Array} classifiedPackages - output of `classifyPackages(...).packages`
 * @param {object} [options]
 * @param {Object.<string,string>} [options.previousVersions] - packageId ->
 *   `latestVersion` observed on a prior check. See the "Foundry glue"
 *   section below for how this is persisted across logins in-world.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.concurrency]
 * @param {AbortSignal} [options.signal]
 * @param {typeof checkGithubArchived} [options.githubCheck] - injectable for tests
 * @returns {Promise<Array>} same packages, each gaining `versionFrozen`
 *   (boolean|null), `githubArchived` (boolean|null), and
 *   `possiblyUnmaintained` (boolean).
 */
export async function applyPossiblyUnmaintainedHeuristic(
  classifiedPackages,
  options = {}
) {
  const {
    previousVersions = {},
    fetchImpl = fetch,
    concurrency = DEFAULT_CONCURRENCY,
    signal,
    githubCheck = checkGithubArchived,
  } = options;

  // Only packages already failing the verified check are eligible at all —
  // never spend a GitHub API call on a package that already passes.
  const candidates = classifiedPackages.filter((pkg) => pkg.failsVerifiedCheck);
  const githubResultsById = new Map();

  await runWithConcurrency(
    candidates,
    async (pkg) => {
      const repo =
        parseGithubRepo(pkg.links?.url) ?? parseGithubRepo(pkg.links?.bugs);
      if (!repo) {
        githubResultsById.set(pkg.id, { archived: null, reason: "not-a-github-repo" });
        return;
      }
      githubResultsById.set(pkg.id, await githubCheck(repo, { fetchImpl, signal }));
    },
    { concurrency, signal }
  );

  return classifiedPackages.map((pkg) => {
    if (!pkg.failsVerifiedCheck) {
      return { ...pkg, versionFrozen: null, githubArchived: null, possiblyUnmaintained: false };
    }
    const versionFrozen = isVersionFrozen(pkg, previousVersions);
    const githubArchived = githubResultsById.get(pkg.id)?.archived ?? null;
    // Both signals are boolean|null ("unknown"); Boolean(null) is false, so
    // an unknown signal never counts as evidence toward the flag (and,
    // since we only ever OR, never against it either).
    const possiblyUnmaintained = Boolean(versionFrozen) || Boolean(githubArchived);
    return { ...pkg, versionFrozen, githubArchived, possiblyUnmaintained };
  });
}

/**
 * Full pure classification pipeline: severity (sync) + possibly-unmaintained
 * (async, network for GitHub-hosted already-failing packages only). Does
 * not read the Foundry `game` global — see `classifyActiveCompatibility`
 * below for the thin wrapper that does.
 *
 * Governing: SPEC-0001 REQ "Inferred Latest Version", SPEC-0001 REQ
 * "Compatibility Severity Classification", SPEC-0001 REQ "Possibly
 * Unmaintained Heuristic".
 */
export async function classifyCompatibility(results, gameRelease, options = {}) {
  const { inferredLatest, packages } = classifyPackages(results, gameRelease);
  const finalPackages = await applyPossiblyUnmaintainedHeuristic(packages, options);
  return { inferredLatest, packages: finalPackages };
}

// ---------------------------------------------------------------------------
// Foundry glue: the only functions below read `game` / `game.settings`. Kept
// thin so the logic above stays testable without a running world.
// ---------------------------------------------------------------------------

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" — "across
// checks" (the frozen-version signal) has to mean across separate logins,
// not just within one page load, since the login notification's frequency
// setting ("every login"/"daily"/"only when changed") implies checks
// recur across sessions. issue #6's session cache (a plain in-memory Map)
// resets on every page load, so it can't serve this. A world-scoped setting
// is the lightweight persistence option that actually matches "across
// checks" — no new dependency, and world settings are the standard Foundry
// mechanism for this kind of small persisted bookkeeping. It's marked
// `config: false` since it's internal state, not a GM-facing option.
export const PREVIOUS_VERSIONS_SETTING_KEY = "previousPackageVersions";

/** Best-effort read of the previous-versions world setting; `{}` if unset/unavailable (e.g. setting not yet registered, or no world loaded). */
export function loadPreviousVersions(gameInstance = globalThis.game) {
  try {
    return gameInstance?.settings?.get(MODULE_ID, PREVIOUS_VERSIONS_SETTING_KEY) ?? {};
  } catch {
    return {};
  }
}

/** Best-effort write of the previous-versions world setting; failure here must never block classification results from being returned. */
async function savePreviousVersions(versions, gameInstance = globalThis.game) {
  try {
    await gameInstance?.settings?.set(MODULE_ID, PREVIOUS_VERSIONS_SETTING_KEY, versions);
  } catch {
    // Best-effort persistence only — a failed save just means next check's
    // "version frozen" signal falls back to "unknown" for these packages.
  }
}

/**
 * Thin wrapper: fetches (or reuses already-fetched) active-package results,
 * runs the full classification pipeline against `game.release`, and
 * persists each package's `latestVersion` to the world-scoped setting so
 * the *next* check can compare "has this manifest version changed since
 * last time" (SPEC-0001 REQ "Possibly Unmaintained Heuristic").
 *
 * Governing: ADR-0001, ADR-0002, SPEC-0001 REQ "Inferred Latest Version",
 * SPEC-0001 REQ "Compatibility Severity Classification", SPEC-0001 REQ
 * "Possibly Unmaintained Heuristic".
 *
 * @param {object} [options]
 * @param {object} [options.game] - defaults to globalThis.game
 * @param {string} [options.gameRelease] - defaults to `game.release.generation`
 * @param {Array} [options.results] - pre-fetched results; when omitted, calls
 *   `checkActivePackages` (cached/concurrency-limited per issue #6)
 * @param {boolean} [options.persist] - set false to skip writing the
 *   previous-versions setting (e.g. a read-only preview)
 */
export async function classifyActiveCompatibility(options = {}) {
  const gameInstance = options.game ?? globalThis.game;
  const gameRelease =
    options.gameRelease ?? String(gameInstance?.release?.generation ?? "");
  const results =
    options.results ?? (await checkActivePackages({ game: gameInstance, ...options }));
  const previousVersions = options.previousVersions ?? loadPreviousVersions(gameInstance);

  const classification = await classifyCompatibility(results, gameRelease, {
    ...options,
    previousVersions,
  });

  if (options.persist !== false) {
    const nextVersions = { ...previousVersions };
    for (const pkg of classification.packages) {
      if (pkg.latestVersion != null) nextVersions[pkg.id] = pkg.latestVersion;
    }
    await savePreviousVersions(nextVersions, gameInstance);
  }

  return classification;
}
