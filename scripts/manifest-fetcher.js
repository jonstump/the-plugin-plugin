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
 * Governing: ADR-0003, ADR-0008, SPEC-0002 (extends SPEC-0001) — when a
 * package's declared manifest URL fails, `fetchPackageManifest` makes
 * exactly one additional attempt against a CORS-open default-branch mirror
 * derived from the declared URL: `raw.githubusercontent.com` for
 * `github.com`-hosted declared URLs, `cdn.statically.io` for
 * `gitlab.com`-hosted ones (ADR-0008 Amendment, 2026-08-16 — GitLab's own
 * raw-file endpoint isn't CORS-open). Every other host stays unsupported.
 * That second attempt happens inside the same per-package flow, so it
 * shares the existing concurrency pool, cancellation signal, and session
 * cache without any changes to `runWithConcurrency` or `checkPackages`
 * themselves.
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
    // Governing: SPEC-0002 REQ "Result Provenance" — no manifest was ever
    // resolved for an error result, so there is no source to attribute.
    // Present on every result shape (ok or error) so downstream consumers
    // (issue #32) don't need an `in` check to read it.
    provenance: null,
    // Governing: SPEC-0001 REQ "Error Handling Standards", SPEC-0002 REQ
    // "Error Handling Standards" — every failure is attributable to the
    // specific package it occurred for, and when both the declared and
    // fallback attempts were made, `message` says so explicitly (built by
    // the caller) rather than leaving that implicit.
    error: { packageId: pkg.id, message },
  };
}

function buildOkResult(pkg, manifest, provenance = "declared") {
  const rawVerified = manifest?.compatibility?.verified ?? null;
  const compatibleCoreVersion = manifest?.compatibleCoreVersion ?? null;
  // Governing: SPEC-0001 REQ "Manifest Check" — fall back to the legacy
  // compatibleCoreVersion field when `compatibility` is absent.
  const verified = rawVerified ?? compatibleCoreVersion ?? null;

  // Governing: ADR-0003 (amended 2026-08-16), SPEC-0002 REQ "Fallback Field
  // Trust" (issue #48) — a fallback-sourced `version` is read from a
  // repository's default branch, which is frequently stamped by release
  // tooling and can sit arbitrarily far from what was actually released, in
  // EITHER direction (observed real case: installed 0.9.8, fallback-sourced
  // `version` 0.5.1, actual latest release 4.0.0 — a stale placeholder that
  // happened to read *older*, producing a false "up to date"). It MUST be
  // treated as unknown for a fallback-sourced result: never surfaced as the
  // latest version, and never used to derive an update-available verdict —
  // not even behind a plausibility check like "only if newer than
  // installed", since a stale-but-numerically-higher placeholder would still
  // pass that check and still misreport. `compatibility.verified` (folded
  // into `verified` above) does not share this defect and continues to be
  // used unconditionally, regardless of provenance. A declared-sourced
  // `version` is the actual released version and is used exactly as before.
  const latestVersion = provenance === "fallback" ? null : manifest?.version ?? null;

  const updateAvailable =
    provenance === "fallback"
      ? null
      : latestVersion != null && pkg.installedVersion != null
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
    // Governing: SPEC-0002 REQ "Result Provenance" — distinguishes a
    // manifest read from the package's own declared URL from one recovered
    // via the raw.githubusercontent.com fallback (ADR-0003), so downstream
    // consumers (issue #32) never present default-branch data as a
    // published release.
    provenance,
  };
}

/**
 * Attempts a single manifest fetch against `url`, never throwing — every
 * failure mode (network error, non-200, malformed JSON, abort) resolves to
 * `{ ok: false, message, aborted? }` instead. Shared by both the declared-URL
 * attempt and the fallback attempt in `fetchPackageManifest` so the two
 * share identical error handling per SPEC-0001/SPEC-0002 REQ "Error Handling
 * Standards".
 */
async function attemptManifestFetch(url, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, aborted: true, message: "Manifest fetch was cancelled" };
    }
    return { ok: false, message: err?.message ?? String(err) };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `Manifest request failed with status ${response.status}`,
    };
  }

  try {
    const manifest = await response.json();
    return { ok: true, manifest };
  } catch (err) {
    return {
      ok: false,
      message: `Manifest response was not valid JSON: ${err?.message ?? err}`,
    };
  }
}

/**
 * Derives a CORS-open `raw.githubusercontent.com` fallback URL from a
 * package's *declared* manifest URL — never from a fetched manifest body,
 * which is unavailable by construction on the failure path this exists to
 * serve (`links` is `null` on error results). Returns `null` when the
 * declared URL isn't a `github.com` URL, or doesn't parse into an
 * `<owner>/<repo>/.../<filename>` shape.
 *
 * Governing: ADR-0003, SPEC-0002 REQ "Fallback URL Derivation", SPEC-0002
 * REQ "Fallback Scope and Limits".
 */
export function deriveFallbackUrl(declaredUrl) {
  if (!declaredUrl) return null;

  let parsed;
  try {
    parsed = new URL(declaredUrl);
  } catch {
    return null;
  }

  // Governing: SPEC-0002 REQ "Fallback Scope and Limits" (ADR-0008
  // Amendment, 2026-08-16) — the fallback is restricted to hosts with a
  // known CORS-open path, own or third-party mirror. Every other host
  // stays "Couldn't check" with no fallback attempt.
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "gitlab.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  // Need at least <owner>/<repo>/<...>/<filename> — anything shorter can't
  // carry a filename through.
  if (segments.length < 3) return null;

  const [owner, repo] = segments;
  // Governing: SPEC-0002 REQ "Fallback URL Derivation" — carry the actual
  // filename through rather than hardcoding module.json, so game systems
  // (system.json) resolve correctly too.
  const filename = segments[segments.length - 1];
  if (!owner || !repo || !filename) return null;

  // Governing: SPEC-0002 REQ "Fallback URL Derivation" (ADR-0008
  // Amendment) — GitLab's own raw-file endpoint sends no
  // Access-Control-Allow-Origin header (measured, ADR-0008), so the
  // fallback goes through a CORS-open third-party mirror instead. `@HEAD`
  // resolves the actual default branch with no prior lookup, mirroring
  // raw.githubusercontent.com's own `HEAD` alias.
  if (hostname === "gitlab.com") {
    return `https://cdn.statically.io/gl/${owner}/${repo}@HEAD/${filename}`;
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filename}`;
}

/**
 * Parses a github.com-hosted declared manifest URL into
 * `{ owner, repo, filename }`. Returns null for anything else (unparseable
 * URL, non-github.com host, fewer than `<owner>/<repo>/<filename>`
 * segments) — the same shape `deriveFallbackUrl` recognizes, kept as a
 * separate small function rather than changing `deriveFallbackUrl` itself
 * (which has its own direct tests and is used elsewhere unchanged). Used
 * only by the release-tag-resolution path below.
 *
 * Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag Resolution".
 */
function parseGithubManifestUrl(declaredUrl) {
  if (!declaredUrl) return null;

  let parsed;
  try {
    parsed = new URL(declaredUrl);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;

  const [owner, repo] = segments;
  const filename = segments[segments.length - 1];
  if (!owner || !repo || !filename) return null;

  return { owner, repo, filename };
}

/**
 * Resolves a GitHub repo's latest published release tag via the
 * unauthenticated GitHub API, never throwing — every failure mode (network
 * error, non-200, malformed JSON, missing `tag_name`) resolves to
 * `{ ok: false, reason }`. Mirrors the error-handling style of
 * `checkGithubArchived` in compatibility-classifier.js (try/catch around the
 * fetch, check `response.ok`, try/catch around `.json()`).
 *
 * Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag Resolution".
 */
async function resolveGithubReleaseTag({ owner, repo }, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { signal, headers: { Accept: "application/vnd.github+json" } }
    );
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }

  if (!response.ok) {
    return { ok: false, reason: `github-api-status-${response.status}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      ok: false,
      reason: `github-api-response-not-json: ${err?.message ?? err}`,
    };
  }

  if (!data?.tag_name) {
    return { ok: false, reason: "no-tag-name-in-response" };
  }

  return { ok: true, tagName: data.tag_name };
}

// Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Fallback Scope and
// Limits" (revised) — the GitHub API budget is shared, local, and
// best-effort: one counter created per `classifyActiveCompatibility` call
// and spent by both release-tag resolution (here) and the possibly-
// unmaintained heuristic's archived-repo check
// (`compatibility-classifier.js`). Neither consumer may spend it
// independently of the other.
export const DEFAULT_GITHUB_API_BUDGET = 50;

/**
 * Returns true and decrements `budget.remaining` if a GitHub API call may
 * proceed; returns false (budget left unchanged) once exhausted. Callers are
 * responsible for checking whether a budget object exists at all before
 * calling this — a null/undefined budget means "no shared tracking
 * requested," handled by the caller's own `if` check, not by this function.
 *
 * Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag Resolution".
 */
export function consumeGithubApiBudget(budget) {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

/**
 * Fetches and parses a single package's manifest, never throwing — every
 * failure mode (missing URL, network error, non-200, malformed JSON, abort)
 * resolves to an error result attributed to this package.
 *
 * Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Error Handling
 * Standards", ADR-0001 (only ever fetches the package's own manifest URL).
 *
 * Governing: ADR-0003, ADR-0008, SPEC-0002 REQ "Fallback Trigger and
 * Ordering" — the declared URL is always attempted first; a default-branch
 * mirror fallback (`raw.githubusercontent.com` or, for `gitlab.com`-hosted
 * URLs, `cdn.statically.io`) is attempted at most once, only when the
 * declared attempt fails, and only for hosts with a known CORS-open path
 * (SPEC-0002 REQ "Fallback Scope and Limits"). Both attempts run inside
 * this single function call, so they share whichever concurrency slot /
 * cancellation signal the caller (`checkPackages`) is already managing —
 * no pool changes needed.
 *
 * Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag Resolution" —
 * before the raw/HEAD fallback, and only when the caller supplied a shared
 * `options.githubApiBudget` with remaining capacity, attempt to resolve the
 * repo's actual latest release tag and fetch the manifest AT that tag
 * (genuinely trustworthy data, provenance `"release"`). Any failure at any
 * step of that attempt — API call fails, no releases published, the
 * tag-resolved fetch itself fails — falls through silently to the existing
 * raw/HEAD fallback below; no separate error is ever surfaced for it. This
 * is opt-in: when no `githubApiBudget` is supplied at all, this whole block
 * is skipped and behavior is identical to before this feature (every
 * existing caller/test that doesn't pass the option is unaffected).
 */
export async function fetchPackageManifest(pkg, options = {}) {
  const { fetchImpl = fetch, signal, githubApiBudget } = options;

  if (!pkg.manifestUrl) {
    return errorResult(pkg, "No manifest URL declared for this package");
  }

  const declaredAttempt = await attemptManifestFetch(
    pkg.manifestUrl,
    fetchImpl,
    signal
  );
  if (declaredAttempt.ok) {
    return buildOkResult(pkg, declaredAttempt.manifest, "declared");
  }

  // Governing: SPEC-0002 REQ "Concurrency and Caching Interaction" — a
  // cancelled scan must not spend a second request chasing a fallback; the
  // whole check is being abandoned, so honor the same signal here.
  if (declaredAttempt.aborted) {
    return errorResult(pkg, declaredAttempt.message);
  }

  const fallbackUrl = deriveFallbackUrl(pkg.manifestUrl);

  // Governing: SPEC-0002 REQ "Fallback Scope and Limits" (ADR-0008
  // Amendment) — no fallback URL could be derived (a host with no known
  // CORS-open path, own or third-party mirror, or an unparseable declared
  // URL): report an honest "Couldn't check" with no further attempt, and
  // no GitHub API call either way.
  if (!fallbackUrl) {
    return errorResult(
      pkg,
      `Declared manifest URL failed: ${declaredAttempt.message}`
    );
  }

  // Governing: ADR-0008 Amendment — parse (free) BEFORE consuming any
  // shared budget, so a gitlab.com-hosted package (whose fallback is now
  // also non-null, per ADR-0008) never spends GitHub API rate-limit budget
  // on a lookup it could never have used — `parseGithubManifestUrl` returns
  // null for anything not github.com, and the budget must stay unconsumed
  // in that case for other packages/consumers to use.
  const parsedGithub = parseGithubManifestUrl(pkg.manifestUrl);
  if (parsedGithub && githubApiBudget && consumeGithubApiBudget(githubApiBudget)) {
    const tagResolution = await resolveGithubReleaseTag(
      parsedGithub,
      fetchImpl,
      signal
    );
    if (tagResolution.ok) {
      const releaseUrl =
        `https://raw.githubusercontent.com/${parsedGithub.owner}/` +
        `${parsedGithub.repo}/${tagResolution.tagName}/${parsedGithub.filename}`;
      const releaseAttempt = await attemptManifestFetch(
        releaseUrl,
        fetchImpl,
        signal
      );
      if (releaseAttempt.ok) {
        return buildOkResult(pkg, releaseAttempt.manifest, "release");
      }
    }
  }

  const fallbackAttempt = await attemptManifestFetch(
    fallbackUrl,
    fetchImpl,
    signal
  );
  if (fallbackAttempt.ok) {
    return buildOkResult(pkg, fallbackAttempt.manifest, "fallback");
  }

  // Governing: SPEC-0002 REQ "Error Handling Standards" — when both attempts
  // fail, the diagnostic says so explicitly, rather than reading like an
  // untried package. Named after the actual fallback URL used (varies by
  // host, ADR-0008 Amendment) rather than hardcoding GitHub's.
  return errorResult(
    pkg,
    `Declared manifest URL failed: ${declaredAttempt.message}. Fallback ` +
      `(${fallbackUrl}) also failed: ${fallbackAttempt.message}`
  );
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
    // Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag
    // Resolution" — must be explicitly threaded through to
    // `fetchPackageManifest` below, since that call only forwards a
    // hand-picked subset of `options` rather than spreading the whole
    // object. Left undefined (opt-in) when the caller doesn't supply one.
    githubApiBudget,
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
      const result = await fetchPackageManifest(pkg, {
        fetchImpl,
        signal,
        githubApiBudget,
      });
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
 *
 * `game.modules` is a Foundry `Collection`. It extends `Map` (so
 * `instanceof Map` is true), but it overrides `Symbol.iterator` to yield
 * *values* rather than `[key, value]` entries — so `Array.from(game.modules)`
 * returns bare `Module` objects, not pairs. Going through `.values()`
 * normalizes that: it yields the packages themselves for a Collection, a
 * plain Map, or an array alike, so this works against a real world and
 * against a test double without either having to imitate the other.
 */
export function getActivePackagesFromGame(gameInstance = globalThis.game) {
  const source = gameInstance?.modules;
  const modules = Array.from(source?.values?.() ?? source ?? [])
    .filter((mod) => mod?.active)
    .map((mod) => toPackageInfo(mod));

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
