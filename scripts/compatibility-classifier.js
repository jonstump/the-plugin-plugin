/**
 * Compatibility classification: builds on top of issue #6's
 * `manifest-fetcher.js` fetch results (never re-fetches a manifest) to
 * compute the three v1 signals that are shared foundation for the checker
 * table (issue #8) and login notification (issue #9):
 *
 *  - `comparisonTarget` — the Foundry version each package's
 *    `compatibility.verified` is measured against, beyond `game.release`.
 *    Authoritative (`game.data.coreUpdate`) when available; otherwise a
 *    peer-inferred fallback (`computeInferredLatest`), per ADR-0001 as
 *    amended 2026-08-15 — see "Requirement: Target Version Determination"
 *    below. `game.data.coreUpdate` is read, never fetched, by this module.
 *  - `severity` — hard/soft classification per package, gated on
 *    `compatibility.maximum` rather than a bare `verified` lag (ADR-0002).
 *  - `possiblyUnmaintained` — a two-signal heuristic layered on top of
 *    severity, never a synonym for "dead"/"broken"/"abandoned".
 *
 * As with manifest-fetcher.js, the core logic here is plain, pure, and
 * dependency-injectable (fetch implementation and the Foundry `game` global
 * are both parameters) so it's unit-testable with Node's built-in test
 * runner outside a running Foundry world. Only the functions in the
 * "Foundry glue" section at the bottom read `game` / `game.settings`.
 */

import {
  DEFAULT_CONCURRENCY,
  runWithConcurrency,
  isNewerVersion,
  checkActivePackages,
} from "./manifest-fetcher.js";

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
// Requirement: Target Version Determination
// ---------------------------------------------------------------------------

/**
 * Extracts the leading generation segment from a Foundry version string
 * (e.g. "14.366" -> "14"). `compatibility.verified` is conventionally
 * declared at generation granularity (developers write "verified: 14", not
 * "verified: 14.366"), which is also the granularity `computeInferredLatest`
 * already operates at (it's built from other packages' own `verified`
 * fields). `game.data.coreUpdate.version` is a full point version, so it's
 * normalized to the same granularity before being used as a comparison
 * target — otherwise a package correctly verified against an entire
 * generation would be wrongly flagged as behind a specific patch build
 * within that same generation, which is exactly the kind of noisy, unkind
 * false status CLAUDE.md project rule 1 exists to prevent.
 */
function toGeneration(versionString) {
  if (versionString == null) return null;
  const [generation] = String(versionString).split(/[.\-+]/);
  return generation || null;
}

/**
 * Determines the comparison target for compatibility checks — the Foundry
 * version each package's `compatibility.verified` is measured against,
 * beyond `game.release` itself. Authoritative (`game.data.coreUpdate`) when
 * available; falls back to the peer-inferred target (`computeInferredLatest`,
 * REQ "Inferred Latest Version") only when it isn't. Pure and synchronous —
 * `coreUpdate` is a plain object passed in by the caller, never read from a
 * `game` global here, so this stays testable outside a running world.
 *
 * Governing: ADR-0001 (amended 2026-08-15 — primary/fallback split),
 * SPEC-0001 REQ "Target Version Determination", SPEC-0001 REQ "Inferred
 * Latest Version".
 *
 * @param {Array} results - package results, forwarded to
 *   `computeInferredLatest` only on the fallback path — per SPEC-0001
 *   "Authoritative target available", an authoritative target must not
 *   trigger a peer-inference computation at all.
 * @param {string|null} gameRelease - `game.release.generation` as a string;
 *   the running Foundry generation, at the same granularity
 *   `compatibility.verified` is declared at.
 * @param {object} [options]
 * @param {object|null} [options.coreUpdate] - `game.data.coreUpdate`.
 *   Absent/undefined/null is treated identically to an explicit
 *   `couldReachWebsite: false` (SPEC-0001 "Foundry could not reach its
 *   update service") — both fall back to peer inference.
 * @param {string|null} [options.gameReleaseVersion] - `game.release.version`
 *   (the full point version, e.g. "13.351"). Used *only* to determine
 *   whether `coreUpdate.version` is newer than the running version — per
 *   ADR-0001's binding constraint, this MUST compare `coreUpdate.version`
 *   against `game.release.version` directly and MUST NOT gate on
 *   `coreUpdate.hasUpdate` (measured live to read `false` while a newer
 *   generation was in fact available — it's scoped to the running
 *   generation only).
 * @returns {{
 *   source: 'authoritative'|'inferred',
 *   value: string|null,
 *   rawVersion: string|null,
 *   isNewer: boolean,
 *   hasPeerSignal: boolean,
 * }}
 *   `value` is always at generation granularity, ready to feed straight into
 *   `classifyAgainstTarget` alongside `compatibility.verified`. `rawVersion`
 *   preserves the full authoritative version string (e.g. "14.366") for
 *   GM-facing display only — comparisons always use `value`. `hasPeerSignal`
 *   mirrors `computeInferredLatest`'s field and is only meaningful when
 *   `source === 'inferred'`; `isNewer` is true whenever there's positive
 *   evidence (authoritative or peer) of a newer Foundry generation.
 */
export function determineComparisonTarget(results, gameRelease, options = {}) {
  const { coreUpdate = null, gameReleaseVersion = null } = options;

  // Governing: ADR-0001 Amendment — "MUST use game.data.coreUpdate.version
  // ... when couldReachWebsite is true and version is present." Absence of
  // either condition falls straight through to peer inference below, which
  // is also how "couldReachWebsite: false" and "payload absent" are both
  // handled as "unknown" rather than "you're current" (SPEC-0001 "Foundry
  // could not reach its update service").
  if (coreUpdate && coreUpdate.couldReachWebsite === true && coreUpdate.version != null) {
    // Governing: ADR-0001 Amendment — compare directly against
    // game.release.version; never gate on coreUpdate.hasUpdate.
    const isNewer = isNewerVersion(coreUpdate.version, gameReleaseVersion ?? "");
    return {
      source: "authoritative",
      value: toGeneration(coreUpdate.version),
      rawVersion: coreUpdate.version,
      isNewer,
      hasPeerSignal: false,
    };
  }

  const inferred = computeInferredLatest(results, gameRelease);
  return {
    source: "inferred",
    value: inferred.value,
    rawVersion: inferred.value,
    isNewer: inferred.hasPeerSignal,
    hasPeerSignal: inferred.hasPeerSignal,
  };
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
 * the other, since `game.release` and the comparison target (authoritative
 * or peer-inferred — see `determineComparisonTarget`) are different
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
 * Classifies comparison-target/`game.release` severity for every package in
 * `results`. Pure and synchronous — no network calls (the comparison target
 * itself is either read from an already-supplied `coreUpdate` object or
 * inferred from `results`, per `determineComparisonTarget` above).
 *
 * Governing: ADR-0001, ADR-0002, SPEC-0001 REQ "Target Version
 * Determination", SPEC-0001 REQ "Inferred Latest Version", SPEC-0001 REQ
 * "Compatibility Severity Classification".
 *
 * @param {Array} results - package results from checkPackages/checkActivePackages
 * @param {string|null} gameRelease - the currently running Foundry generation
 * @param {object} [options] - forwarded to `determineComparisonTarget`
 *   (`coreUpdate`, `gameReleaseVersion`); omitting `coreUpdate` reproduces
 *   the pre-#36 peer-inference-only behavior exactly.
 * @returns {{ comparisonTarget: {source:'authoritative'|'inferred',value:string|null,rawVersion:string|null,isNewer:boolean,hasPeerSignal:boolean}, packages: Array }}
 *   Each package gains:
 *   - `gameReleaseComparison` / `targetComparison`:
 *     `{ target, verifies: boolean|null, severity: 'hard'|'soft'|null }`
 *   - `severity`: `'hard'|'soft'|null` — the stronger of the two targets'
 *     severities (see `combineSeverity` above).
 *   - `failsVerifiedCheck`: boolean — true when `verified` verifies
 *     neither `game.release` nor the comparison target (SPEC-0001 "Possibly
 *     Unmaintained Heuristic" precondition). This is distinct from
 *     `severity`: a soft-severity package still "fails" this check, it
 *     just isn't a developer-declared hard ceiling.
 */
export function classifyPackages(results, gameRelease, options = {}) {
  const comparisonTarget = determineComparisonTarget(results, gameRelease, options);

  const packages = results.map((result) => {
    const maximum = result.compatibility?.maximum ?? null;
    const verified = result.verified ?? null;

    const gameReleaseComparison = classifyAgainstTarget(
      maximum,
      verified,
      gameRelease ?? null
    );
    const targetComparison =
      comparisonTarget.value != null
        ? classifyAgainstTarget(maximum, verified, comparisonTarget.value)
        : { target: null, verifies: null, severity: null };

    const severity = combineSeverity(
      gameReleaseComparison.severity,
      targetComparison.severity
    );

    // Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" — "fails
    // neither game.release nor the comparison target" read literally:
    // game.release must resolve to a hard "no" (verifies === false), and
    // the target comparison must not resolve to a "yes" (covers both a
    // hard "no" and "no target exists", i.e. no authoritative or peer
    // signal).
    const failsVerifiedCheck =
      gameReleaseComparison.verifies === false &&
      targetComparison.verifies !== true;

    return {
      ...result,
      gameReleaseComparison,
      targetComparison,
      severity,
      failsVerifiedCheck,
    };
  });

  return { comparisonTarget, packages };
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
 * Queries the unauthenticated GitHub API for a repo's `archived` status and
 * activity age. Never throws — any failure (network error, non-200, rate
 * limit, abort) resolves to `{ archived: null, pushedAt: null }`, which
 * callers MUST treat as "unknown", never as evidence toward or against
 * "possibly unmaintained".
 *
 * Both signals are read from the same `GET /repos/{owner}/{repo}` response —
 * per ADR-0004 and design.md's "single request" architecture note, this MUST
 * NOT issue a second request to obtain activity age.
 *
 * Governing: ADR-0004, SPEC-0001 REQ "Possibly Unmaintained Heuristic" ("MUST
 * treat a GitHub API failure ... as unknown", "both signals are read from a
 * single ... request"), design.md decision ("GitHub archived lookup is
 * scoped to already-failing packages only" — enforced by the caller,
 * `applyPossiblyUnmaintainedHeuristic`, not by this function).
 */
export async function checkGithubArchived(ownerRepo, options = {}) {
  const { fetchImpl = fetch, signal } = options;
  if (!ownerRepo) return { archived: null, pushedAt: null, reason: "not-a-github-repo" };

  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}`,
      { signal, headers: { Accept: "application/vnd.github+json" } }
    );
  } catch (err) {
    return { archived: null, pushedAt: null, reason: err?.message ?? String(err) };
  }

  if (!response.ok) {
    return { archived: null, pushedAt: null, reason: `github-api-status-${response.status}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      archived: null,
      pushedAt: null,
      reason: `github-api-response-not-json: ${err?.message ?? err}`,
    };
  }

  return {
    archived: Boolean(data.archived),
    // Governing: ADR-0004 — `pushed_at` (moves on commits), never
    // `updated_at` (moves on metadata edits like stars/description and
    // therefore does not indicate maintenance).
    pushedAt: data.pushed_at ?? null,
    reason: null,
  };
}

/**
 * `pushedAt` at least 12 months before `now` -> true (dormant); known and
 * more recent -> false; missing/unparseable -> null (unknown, never evidence
 * either way).
 *
 * Governing: ADR-0004 (12-month threshold, `pushed_at` not `updated_at`),
 * SPEC-0001 REQ "Possibly Unmaintained Heuristic" (Scenario: Dormant
 * repository, Scenario: Recently active repository).
 */
export function isDormant(pushedAt, now = new Date()) {
  if (pushedAt == null) return null;
  const pushedDate = new Date(pushedAt);
  if (Number.isNaN(pushedDate.getTime())) return null;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  return pushedDate.getTime() <= cutoff.getTime();
}

/**
 * Layers the "possibly unmaintained" flag onto packages already classified
 * by `classifyPackages`. Only queries the GitHub API for packages that are
 * already failing the verified-compatibility check (`failsVerifiedCheck`),
 * per SPEC-0001 and the design.md decision to keep GitHub API volume
 * proportional to actual candidates, respecting the unauthenticated rate
 * limit.
 *
 * Governing: ADR-0004, SPEC-0001 REQ "Possibly Unmaintained Heuristic",
 * SPEC-0001 REQ "Fetch Concurrency and Caching" (reuses the same concurrency
 * pool as the manifest fetch pass).
 *
 * @param {Array} classifiedPackages - output of `classifyPackages(...).packages`
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.concurrency]
 * @param {AbortSignal} [options.signal]
 * @param {typeof checkGithubArchived} [options.githubCheck] - injectable for tests
 * @param {typeof Date} [options.now] - injectable "current time" for tests
 * @returns {Promise<Array>} same packages, each gaining `githubArchived`
 *   (boolean|null), `repoDormant` (boolean|null), and `possiblyUnmaintained`
 *   (boolean).
 */
export async function applyPossiblyUnmaintainedHeuristic(
  classifiedPackages,
  options = {}
) {
  const {
    fetchImpl = fetch,
    concurrency = DEFAULT_CONCURRENCY,
    signal,
    githubCheck = checkGithubArchived,
    now = new Date(),
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
        githubResultsById.set(pkg.id, { archived: null, pushedAt: null, reason: "not-a-github-repo" });
        return;
      }
      githubResultsById.set(pkg.id, await githubCheck(repo, { fetchImpl, signal }));
    },
    { concurrency, signal }
  );

  return classifiedPackages.map((pkg) => {
    if (!pkg.failsVerifiedCheck) {
      return { ...pkg, githubArchived: null, repoDormant: null, possiblyUnmaintained: false };
    }
    const githubResult = githubResultsById.get(pkg.id);
    const githubArchived = githubResult?.archived ?? null;
    const repoDormant = isDormant(githubResult?.pushedAt ?? null, now);
    // Both signals are boolean|null ("unknown"); Boolean(null) is false, so
    // an unknown signal never counts as evidence toward the flag (and,
    // since we only ever OR, never against it either).
    const possiblyUnmaintained = Boolean(githubArchived) || Boolean(repoDormant);
    return { ...pkg, githubArchived, repoDormant, possiblyUnmaintained };
  });
}

/**
 * Full pure classification pipeline: comparison target + severity (sync) +
 * possibly-unmaintained (async, network for GitHub-hosted already-failing
 * packages only). Does not read the Foundry `game` global — see
 * `classifyActiveCompatibility` below for the thin wrapper that does.
 * `options.coreUpdate`/`options.gameReleaseVersion` are forwarded straight
 * through to `classifyPackages`/`determineComparisonTarget`.
 *
 * Governing: SPEC-0001 REQ "Target Version Determination", SPEC-0001 REQ
 * "Inferred Latest Version", SPEC-0001 REQ "Compatibility Severity
 * Classification", SPEC-0001 REQ "Possibly Unmaintained Heuristic".
 */
export async function classifyCompatibility(results, gameRelease, options = {}) {
  const { comparisonTarget, packages } = classifyPackages(results, gameRelease, options);
  const finalPackages = await applyPossiblyUnmaintainedHeuristic(packages, options);
  return { comparisonTarget, packages: finalPackages };
}

// ---------------------------------------------------------------------------
// Foundry glue: the only functions below read `game` / `game.settings`. Kept
// thin so the logic above stays testable without a running world.
// ---------------------------------------------------------------------------

/**
 * Thin wrapper: fetches (or reuses already-fetched) active-package results,
 * and runs the full classification pipeline against `game.release` and the
 * comparison target (`game.data.coreUpdate` when available, else peer
 * inference — REQ "Target Version Determination"). The "possibly
 * unmaintained" signal (ADR-0004) is read fresh from the GitHub API on every
 * check, so there is no baseline to load or persist across logins.
 *
 * Governing: ADR-0001 (amended 2026-08-15), ADR-0002, ADR-0004, SPEC-0001
 * REQ "Target Version Determination", SPEC-0001 REQ "Inferred Latest
 * Version", SPEC-0001 REQ "Compatibility Severity Classification",
 * SPEC-0001 REQ "Possibly Unmaintained Heuristic".
 *
 * @param {object} [options]
 * @param {object} [options.game] - defaults to globalThis.game
 * @param {string} [options.gameRelease] - defaults to `game.release.generation`
 * @param {string} [options.gameReleaseVersion] - defaults to
 *   `game.release.version` (the full point version); used only for the
 *   coreUpdate-vs-running "is newer" determination (ADR-0001 Amendment).
 * @param {object|null} [options.coreUpdate] - defaults to
 *   `game.data.coreUpdate`; reading it here issues no network request of
 *   this module's own — Foundry's server populates it in-world.
 * @param {Array} [options.results] - pre-fetched results; when omitted, calls
 *   `checkActivePackages` (cached/concurrency-limited per issue #6)
 */
export async function classifyActiveCompatibility(options = {}) {
  const gameInstance = options.game ?? globalThis.game;
  const gameRelease =
    options.gameRelease ?? String(gameInstance?.release?.generation ?? "");
  // Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
  // Determination" — full point version, used only to decide whether
  // coreUpdate.version is newer than what's running; every other
  // comparison in this file stays at `gameRelease` (generation) granularity.
  const gameReleaseVersion =
    options.gameReleaseVersion ?? String(gameInstance?.release?.version ?? "");
  // Governing: ADR-0001 (amended 2026-08-15) — reading game.data.coreUpdate
  // is not a network request; Foundry's own server already populated it.
  const coreUpdate =
    options.coreUpdate !== undefined ? options.coreUpdate : (gameInstance?.data?.coreUpdate ?? null);
  const results =
    options.results ?? (await checkActivePackages({ game: gameInstance, ...options }));

  return classifyCompatibility(results, gameRelease, {
    ...options,
    gameReleaseVersion,
    coreUpdate,
  });
}
