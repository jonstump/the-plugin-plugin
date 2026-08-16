// Unit tests for the pure/dependency-injectable logic in
// scripts/compatibility-classifier.js. No Foundry `game` global required.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Target Version Determination", SPEC-0001 REQ
// "Inferred Latest Version", SPEC-0001 REQ "Compatibility Severity
// Classification", SPEC-0001 REQ "Possibly Unmaintained Heuristic"

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeInferredLatest,
  determineComparisonTarget,
  classifyPackages,
  parseGithubRepo,
  checkGithubArchived,
  isDormant,
  applyPossiblyUnmaintainedHeuristic,
  classifyCompatibility,
  classifyActiveCompatibility,
} from "../scripts/compatibility-classifier.js";

function okPkg(overrides = {}) {
  return {
    id: "pkg",
    title: "Pkg",
    isSystem: false,
    manifestUrl: "https://example.com/pkg.json",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    verified: null,
    compatibility: { verified: null, maximum: null, minimum: null, compatibleCoreVersion: null },
    links: { url: null, bugs: null, changelog: null },
    status: "ok",
    error: null,
    ...overrides,
  };
}

// --- computeInferredLatest -----------------------------------------------

test("computeInferredLatest: peer signal exists when a package verifies higher than game.release", () => {
  const results = [
    okPkg({ id: "a", verified: "13" }),
    okPkg({ id: "b", verified: "14" }),
    okPkg({ id: "c", isSystem: true, verified: "13" }),
  ];
  const { value, hasPeerSignal } = computeInferredLatest(results, "13");
  assert.equal(hasPeerSignal, true);
  assert.equal(value, "14");
});

test("computeInferredLatest: no peer signal when nothing exceeds game.release", () => {
  const results = [
    okPkg({ id: "a", verified: "13" }),
    okPkg({ id: "b", verified: "12" }),
  ];
  const { value, hasPeerSignal } = computeInferredLatest(results, "13");
  assert.equal(hasPeerSignal, false);
  assert.equal(value, null);
});

test("computeInferredLatest: ignores errored packages and packages with no verified value", () => {
  const results = [
    okPkg({ id: "a", verified: null }),
    { ...okPkg({ id: "b", verified: "20" }), status: "error" },
    okPkg({ id: "c", verified: "13" }),
  ];
  const { value, hasPeerSignal } = computeInferredLatest(results, "13");
  assert.equal(hasPeerSignal, false);
  assert.equal(value, null);
});

// --- Requirement: Inferred Latest Participation (SPEC-0002) ---------------
// Fallback-sourced `compatibility.verified` values (provenance: "fallback",
// per manifest-fetcher.js's buildOkResult / ADR-0003) MUST participate in
// computeInferredLatest/determineComparisonTarget on the same terms as
// declared-sourced values. computeInferredLatest itself never branches on
// `provenance` at all -- these tests exercise that behavior directly rather
// than assuming it.

test("computeInferredLatest: a fallback-sourced verified value counts toward the peer signal exactly like a declared-sourced one", () => {
  const declaredOnly = [
    okPkg({ id: "a", provenance: "declared", verified: "13" }),
    okPkg({ id: "b", provenance: "declared", verified: "14" }),
  ];
  const fallbackInstead = [
    okPkg({ id: "a", provenance: "declared", verified: "13" }),
    okPkg({ id: "b", provenance: "fallback", verified: "14" }),
  ];

  const fromDeclared = computeInferredLatest(declaredOnly, "13");
  const fromFallback = computeInferredLatest(fallbackInstead, "13");

  assert.equal(fromFallback.hasPeerSignal, true);
  assert.equal(fromFallback.value, "14");
  // Identical result regardless of which source produced the winning value.
  assert.deepEqual(fromFallback, fromDeclared);
});

test("computeInferredLatest: peer signal recovered entirely via fallback-sourced results (SPEC-0002 'Peer signal recovered via fallback' scenario)", () => {
  const results = [
    okPkg({ id: "lib-wrapper", provenance: "fallback", verified: "14" }),
    okPkg({ id: "smarttarget", provenance: "fallback", verified: "14" }),
    okPkg({ id: "the-plugin-plugin", provenance: "declared", verified: "13" }),
  ];
  const { value, hasPeerSignal } = computeInferredLatest(results, "13");
  assert.equal(hasPeerSignal, true);
  assert.equal(value, "14");
});

test("determineComparisonTarget: falls back to peer inference built entirely from fallback-sourced verified values when no authoritative target is available", () => {
  const results = [
    okPkg({ id: "a", provenance: "fallback", verified: "14" }),
    okPkg({ id: "b", provenance: "declared", verified: "13" }),
  ];
  const target = determineComparisonTarget(results, "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: false, version: null },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "inferred");
  assert.equal(target.value, "14");
  assert.equal(target.hasPeerSignal, true);
});

test("classifyPackages: a package's severity against a fallback-derived inferredLatest is computed the same as against a declared-derived one", () => {
  // Only fallback-sourced results establish inferredLatest = 14 here; a
  // third package with a hard ceiling below 14 must still classify as hard
  // against it, proving the fallback-derived target is actually used
  // downstream, not just computed and discarded.
  const results = [
    okPkg({ id: "leader", provenance: "fallback", verified: "14", compatibility: { verified: "14", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    okPkg({ id: "lagging", provenance: "declared", verified: "13", compatibility: { verified: "13", maximum: "13", minimum: null, compatibleCoreVersion: null } }),
  ];
  const { comparisonTarget, packages } = classifyPackages(results, "13");
  assert.equal(comparisonTarget.source, "inferred");
  assert.equal(comparisonTarget.value, "14");

  const lagging = packages.find((p) => p.id === "lagging");
  assert.equal(lagging.targetComparison.severity, "hard");
});

// --- determineComparisonTarget --------------------------------------------
// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
// Determination", SPEC-0001 REQ "Inferred Latest Version".

test("determineComparisonTarget: authoritative target used when couldReachWebsite is true and version is present", () => {
  const results = [okPkg({ id: "a", verified: "13" })]; // would give no peer signal if it mattered
  const target = determineComparisonTarget(results, "13", {
    coreUpdate: { hasUpdate: true, couldReachWebsite: true, version: "14.366" },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "authoritative");
  assert.equal(target.value, "14"); // generation-normalized, for comparison against compatibility.verified
  assert.equal(target.rawVersion, "14.366"); // full version preserved for display
  assert.equal(target.isNewer, true);
});

test("determineComparisonTarget: hasUpdate false with a newer version still targets it (the hasUpdate trap)", () => {
  // Governing: ADR-0001 Amendment — measured live: hasUpdate read false while
  // version read "14.366" on a world running 13.351. Gating on hasUpdate
  // would silently suppress exactly this cross-generation signal.
  const target = determineComparisonTarget([], "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: true, version: "14.366" },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "authoritative");
  assert.equal(target.value, "14");
  assert.equal(target.isNewer, true);
});

test("determineComparisonTarget: authoritative target present but not newer (already current) is still authoritative", () => {
  const target = determineComparisonTarget([], "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: true, version: "13.351" },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "authoritative");
  assert.equal(target.value, "13");
  assert.equal(target.isNewer, false);
});

test("determineComparisonTarget: couldReachWebsite false falls back to peer inference, never reports current as confirmed", () => {
  const results = [
    okPkg({ id: "a", verified: "14" }),
    okPkg({ id: "b", verified: "13" }),
  ];
  const target = determineComparisonTarget(results, "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: false, version: null },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "inferred");
  assert.equal(target.value, "14");
  assert.equal(target.hasPeerSignal, true);
});

test("determineComparisonTarget: absent coreUpdate payload falls back to peer inference", () => {
  const results = [okPkg({ id: "a", verified: "14" })];
  const target = determineComparisonTarget(results, "13", {
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "inferred");
  assert.equal(target.value, "14");
});

test("determineComparisonTarget: fallback with no peer signal reports no evidence, not confirmation of currency", () => {
  const results = [okPkg({ id: "a", verified: "13" })];
  const target = determineComparisonTarget(results, "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: false, version: null },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "inferred");
  assert.equal(target.value, null);
  assert.equal(target.hasPeerSignal, false);
});

test("determineComparisonTarget: coreUpdate.version present but couldReachWebsite missing falls back", () => {
  // couldReachWebsite must be exactly `true`, not just "version happens to
  // be present" -- an absent/false couldReachWebsite is unknown, not
  // authoritative, even if a stale version string is still sitting there.
  const results = [okPkg({ id: "a", verified: "14" })];
  const target = determineComparisonTarget(results, "13", {
    coreUpdate: { version: "14.366" },
    gameReleaseVersion: "13.351",
  });
  assert.equal(target.source, "inferred");
});

// --- classifyPackages: severity ------------------------------------------

test("severity: hard when compatibility.maximum is declared and below game.release", () => {
  const results = [
    okPkg({
      id: "old-mod",
      verified: "12",
      compatibility: { verified: "12", maximum: "12", minimum: "10", compatibleCoreVersion: null },
    }),
  ];
  const { packages } = classifyPackages(results, "13");
  const pkg = packages[0];
  assert.equal(pkg.gameReleaseComparison.severity, "hard");
  assert.equal(pkg.severity, "hard");
  assert.equal(pkg.failsVerifiedCheck, true);
});

test("severity: soft when verified trails game.release but maximum is absent", () => {
  const results = [
    okPkg({
      id: "lagging-mod",
      verified: "12",
      compatibility: { verified: "12", maximum: null, minimum: null, compatibleCoreVersion: null },
    }),
  ];
  const { packages } = classifyPackages(results, "13");
  const pkg = packages[0];
  assert.equal(pkg.gameReleaseComparison.severity, "soft");
  assert.equal(pkg.severity, "soft");
  assert.equal(pkg.failsVerifiedCheck, true);
});

test("severity: soft when verified trails game.release but maximum is still at/above target", () => {
  const results = [
    okPkg({
      id: "lagging-mod-2",
      verified: "12",
      compatibility: { verified: "12", maximum: "14", minimum: null, compatibleCoreVersion: null },
    }),
  ];
  const { packages } = classifyPackages(results, "13");
  assert.equal(packages[0].severity, "soft");
});

test("severity: null (no issue) when verified is at or above game.release", () => {
  const results = [
    okPkg({
      id: "current-mod",
      verified: "13",
      compatibility: { verified: "13", maximum: null, minimum: null, compatibleCoreVersion: null },
    }),
  ];
  const { packages } = classifyPackages(results, "13");
  const pkg = packages[0];
  assert.equal(pkg.severity, null);
  assert.equal(pkg.failsVerifiedCheck, false);
});

test("severity: hard against inferredLatest even when soft (or clean) against game.release wins overall", () => {
  // b is verified for game.release (13) but a's manifest (verified 14)
  // establishes inferredLatest = 14. b has no maximum set, so it's soft
  // against inferredLatest, not hard.
  const results = [
    okPkg({ id: "a", verified: "14", compatibility: { verified: "14", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    okPkg({ id: "b", verified: "13", compatibility: { verified: "13", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    // c declares a hard ceiling below the inferred target (14) but not below
    // game.release (13) itself -- overall severity should still be "hard"
    // because inferredLatest is one of the two comparison targets.
    okPkg({ id: "c", verified: "13", compatibility: { verified: "13", maximum: "13", minimum: null, compatibleCoreVersion: null } }),
  ];
  const { comparisonTarget, packages } = classifyPackages(results, "13");
  assert.equal(comparisonTarget.value, "14");

  const b = packages.find((p) => p.id === "b");
  assert.equal(b.gameReleaseComparison.severity, null); // verifies game.release
  assert.equal(b.targetComparison.severity, "soft");
  assert.equal(b.severity, "soft");

  const c = packages.find((p) => p.id === "c");
  assert.equal(c.gameReleaseComparison.severity, null); // maximum (13) is at game.release, not below it
  assert.equal(c.targetComparison.severity, "hard"); // maximum (13) is below the comparison target (14)
  // Judgment call: hard against either target wins overall.
  assert.equal(c.severity, "hard");
});

test("failsVerifiedCheck is false once a package verifies inferredLatest, even if it trails game.release is impossible in practice but insufficient-data cases don't flag", () => {
  // No compatibility data at all (e.g. legacy manifest with nothing usable).
  const results = [okPkg({ id: "unknown", verified: null })];
  const { packages } = classifyPackages(results, "13");
  assert.equal(packages[0].failsVerifiedCheck, false);
  assert.equal(packages[0].severity, null);
});

// --- classifyPackages: authoritative target wiring -------------------------
// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
// Determination".

test("classifyPackages: authoritative coreUpdate target takes priority over peer inference", () => {
  const results = [
    // If peer inference ran, this package alone would set inferredLatest to
    // "15" -- but an authoritative target is supplied, so it must not.
    okPkg({ id: "leader", verified: "15", compatibility: { verified: "15", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    okPkg({
      id: "lagging",
      verified: "13",
      compatibility: { verified: "13", maximum: "13", minimum: null, compatibleCoreVersion: null },
    }),
  ];
  const { comparisonTarget, packages } = classifyPackages(results, "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: true, version: "14.366" },
    gameReleaseVersion: "13.351",
  });

  assert.equal(comparisonTarget.source, "authoritative");
  assert.equal(comparisonTarget.value, "14");
  // Governing: SPEC-0001 "Authoritative target available" scenario — "does
  // not compute a peer-inferred target." hasPeerSignal is hardcoded false
  // on the authoritative branch precisely so callers can't mistake this for
  // a peer-derived value even though a peer signal (15) existed.
  assert.equal(comparisonTarget.hasPeerSignal, false);

  const lagging = packages.find((p) => p.id === "lagging");
  // maximum (13) is below the authoritative target's generation (14) --
  // hard severity, not against the peer-only "15" that inference would
  // have produced.
  assert.equal(lagging.targetComparison.target, "14");
  assert.equal(lagging.targetComparison.severity, "hard");
});

test("classifyPackages: with no coreUpdate option, behaves exactly as the pre-#36 peer-inference-only path", () => {
  const results = [
    okPkg({ id: "a", verified: "14", compatibility: { verified: "14", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    okPkg({ id: "b", verified: "13", compatibility: { verified: "13", maximum: null, minimum: null, compatibleCoreVersion: null } }),
  ];
  const { comparisonTarget, packages } = classifyPackages(results, "13");
  assert.equal(comparisonTarget.source, "inferred");
  assert.equal(comparisonTarget.value, "14");
  assert.equal(packages.find((p) => p.id === "b").targetComparison.severity, "soft");
});

test("classifyPackages: couldReachWebsite false still exercises the peer-inference fallback, no-peer-signal case included", () => {
  const results = [okPkg({ id: "a", verified: "13", compatibility: { verified: "13", maximum: null, minimum: null, compatibleCoreVersion: null } })];
  const { comparisonTarget, packages } = classifyPackages(results, "13", {
    coreUpdate: { hasUpdate: false, couldReachWebsite: false, version: null },
    gameReleaseVersion: "13.351",
  });
  assert.equal(comparisonTarget.source, "inferred");
  assert.equal(comparisonTarget.value, null);
  assert.equal(comparisonTarget.hasPeerSignal, false);
  assert.equal(packages[0].targetComparison.severity, null);
  assert.equal(packages[0].failsVerifiedCheck, false); // no target at all -- not a failure
});

// --- parseGithubRepo -------------------------------------------------------

test("parseGithubRepo extracts owner/repo from a github.com URL", () => {
  assert.deepEqual(parseGithubRepo("https://github.com/foo/bar"), { owner: "foo", repo: "bar" });
  assert.deepEqual(parseGithubRepo("https://github.com/foo/bar/issues"), { owner: "foo", repo: "bar" });
  assert.deepEqual(parseGithubRepo("https://github.com/foo/bar.git"), { owner: "foo", repo: "bar" });
});

test("parseGithubRepo returns null for non-GitHub or malformed URLs", () => {
  assert.equal(parseGithubRepo("https://gitlab.com/foo/bar"), null);
  assert.equal(parseGithubRepo(null), null);
  assert.equal(parseGithubRepo("not a url"), null);
  assert.equal(parseGithubRepo("https://github.com/onlyowner"), null);
});

// --- checkGithubArchived ---------------------------------------------------

test("checkGithubArchived returns archived: true/false on success", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ archived: true }) });
  const result = await checkGithubArchived({ owner: "foo", repo: "bar" }, { fetchImpl });
  assert.equal(result.archived, true);
});

test("checkGithubArchived extracts pushed_at from the same response, no second request", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return { ok: true, json: async () => ({ archived: false, pushed_at: "2024-01-01T00:00:00Z" }) };
  };
  const result = await checkGithubArchived({ owner: "foo", repo: "bar" }, { fetchImpl });

  assert.equal(result.archived, false);
  assert.equal(result.pushedAt, "2024-01-01T00:00:00Z");
  assert.equal(callCount, 1);
});

test("checkGithubArchived treats API failure as unknown (archived: null, pushedAt: null), not evidence either way", async () => {
  const rateLimited = async () => ({ ok: false, status: 403 });
  const networkError = async () => {
    throw new Error("network down");
  };

  const a = await checkGithubArchived({ owner: "foo", repo: "bar" }, { fetchImpl: rateLimited });
  const b = await checkGithubArchived({ owner: "foo", repo: "bar" }, { fetchImpl: networkError });

  assert.equal(a.archived, null);
  assert.equal(a.pushedAt, null);
  assert.equal(b.archived, null);
  assert.equal(b.pushedAt, null);
});

// --- isDormant ---------------------------------------------------------

test("isDormant: pushed_at at least 12 months before now -> true", () => {
  assert.equal(isDormant("2024-01-01T00:00:00Z", new Date("2026-08-15T00:00:00Z")), true);
});

test("isDormant: pushed_at within the last 12 months -> false", () => {
  assert.equal(isDormant("2026-05-01T00:00:00Z", new Date("2026-08-15T00:00:00Z")), false);
});

test("isDormant: missing or unparseable pushed_at -> null (unknown)", () => {
  assert.equal(isDormant(null), null);
  assert.equal(isDormant(undefined), null);
  assert.equal(isDormant("not-a-date"), null);
});

// --- applyPossiblyUnmaintainedHeuristic ------------------------------------

function failingPkg(id, overrides = {}) {
  return {
    ...okPkg({ id, verified: "12", compatibility: { verified: "12", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    gameReleaseComparison: { target: "13", verifies: false, severity: "soft" },
    targetComparison: { target: null, verifies: null, severity: null },
    severity: "soft",
    failsVerifiedCheck: true,
    ...overrides,
  };
}

function passingPkg(id) {
  return {
    ...okPkg({ id, verified: "13", compatibility: { verified: "13", maximum: null, minimum: null, compatibleCoreVersion: null } }),
    gameReleaseComparison: { target: "13", verifies: true, severity: null },
    targetComparison: { target: null, verifies: null, severity: null },
    severity: null,
    failsVerifiedCheck: false,
  };
}

const NOW = new Date("2026-08-15T00:00:00Z");

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" Scenario:
// Archived repository.
test("possibly-unmaintained: archived repository -> flagged", async () => {
  const pkg = failingPkg("archived-repo", {
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: true, pushedAt: "2026-08-01T00:00:00Z", reason: null });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], { githubCheck, now: NOW });

  assert.equal(result.githubArchived, true);
  assert.equal(result.repoDormant, false); // recently pushed, but archived alone is enough
  assert.equal(result.possiblyUnmaintained, true);
});

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" Scenario:
// Dormant repository.
test("possibly-unmaintained: dormant repository (pushed_at >= 12 months old) -> flagged", async () => {
  const pkg = failingPkg("dormant-repo", {
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: false, pushedAt: "2024-06-22T00:00:00Z", reason: null });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], { githubCheck, now: NOW });

  assert.equal(result.githubArchived, false);
  assert.equal(result.repoDormant, true);
  assert.equal(result.possiblyUnmaintained, true);
});

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" Scenario:
// Recently active repository.
test("possibly-unmaintained: recently active, non-archived repository -> NOT flagged, however many times checked", async () => {
  const pkg = failingPkg("recently-active", {
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: false, pushedAt: "2026-07-01T00:00:00Z", reason: null });

  const firstCheck = await applyPossiblyUnmaintainedHeuristic([pkg], { githubCheck, now: NOW });
  const secondCheck = await applyPossiblyUnmaintainedHeuristic([pkg], { githubCheck, now: NOW });
  const thirdCheck = await applyPossiblyUnmaintainedHeuristic([pkg], { githubCheck, now: NOW });

  for (const [result] of [firstCheck, secondCheck, thirdCheck]) {
    assert.equal(result.githubArchived, false);
    assert.equal(result.repoDormant, false);
    assert.equal(result.possiblyUnmaintained, false);
  }
});

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" Scenario:
// Repeated checks in quick succession. This is the exact regression from
// issue #22 / ADR-0004: multilevel-tokens (actively maintained, not
// archived) was flagged "possibly unmaintained" purely because two checks
// landed a few minutes apart and observed the same manifest version. Activity
// age must not vary with elapsed real time between checks.
test("REGRESSION issue #22: two checks seconds apart against a recently-active, non-archived, failing package both agree and neither flags 'possibly unmaintained'", async () => {
  const pkg = failingPkg("multilevel-tokens", {
    links: { url: "https://github.com/multilevel-tokens/multilevel-tokens", bugs: null, changelog: null },
  });
  // Same GitHub API response both times, as it would be in real life within
  // a single sitting — pushed a month ago, never archived.
  const githubCheck = async () => ({ archived: false, pushedAt: "2026-07-15T00:00:00Z", reason: null });

  const checkOneTime = new Date("2026-08-15T10:00:00Z");
  const checkTwoTime = new Date("2026-08-15T10:00:04Z"); // 4 seconds later

  const [resultOne] = await applyPossiblyUnmaintainedHeuristic([pkg], {
    githubCheck,
    now: checkOneTime,
  });
  const [resultTwo] = await applyPossiblyUnmaintainedHeuristic([pkg], {
    githubCheck,
    now: checkTwoTime,
  });

  assert.equal(resultOne.possiblyUnmaintained, false);
  assert.equal(resultTwo.possiblyUnmaintained, false);
  assert.deepEqual(
    { archived: resultOne.githubArchived, dormant: resultOne.repoDormant, flagged: resultOne.possiblyUnmaintained },
    { archived: resultTwo.githubArchived, dormant: resultTwo.repoDormant, flagged: resultTwo.possiblyUnmaintained }
  );
});

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" Scenario:
// GitHub API failure.
test("possibly-unmaintained: GitHub API failure treated as unknown, never flags on its own", async () => {
  const pkg = failingPkg("api-failure", {
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: null, pushedAt: null, reason: "rate-limited" });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], { githubCheck, now: NOW });

  assert.equal(result.githubArchived, null);
  assert.equal(result.repoDormant, null);
  assert.equal(result.possiblyUnmaintained, false);
});

test("possibly-unmaintained: GitHub API is only queried for packages already failing the verified check", async () => {
  const failing = failingPkg("failing", {
    links: { url: "https://github.com/foo/failing-repo", bugs: null, changelog: null },
  });
  const passing = passingPkg("passing");
  // Give the passing package a GitHub URL too, to prove it's skipped
  // specifically because it passes, not because it lacks a GitHub link.
  passing.links = { url: "https://github.com/foo/passing-repo", bugs: null, changelog: null };

  let calledWith = [];
  const githubCheck = async (repo) => {
    calledWith.push(repo.repo);
    return { archived: false, pushedAt: "2026-07-01T00:00:00Z", reason: null };
  };

  await applyPossiblyUnmaintainedHeuristic([failing, passing], { githubCheck, now: NOW });

  assert.deepEqual(calledWith, ["failing-repo"]);
});

// Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Fallback Scope and
// Limits" (revised) — this heuristic's GitHub API calls now share a
// scan-scoped rate-limit budget with release-tag resolution
// (manifest-fetcher.js). When the shared budget runs out partway through
// multiple candidates, later candidates degrade to "unknown" instead of
// making a real call.
test("possibly-unmaintained: a shared githubApiBudget that runs out partway through leaves later candidates unknown, not queried", async () => {
  const candidates = ["a", "b", "c", "d"].map((id) =>
    failingPkg(id, {
      links: { url: `https://github.com/foo/${id}-repo`, bugs: null, changelog: null },
    })
  );

  const calledWith = [];
  const githubCheck = async (repo) => {
    calledWith.push(repo.repo);
    return { archived: false, pushedAt: "2026-07-01T00:00:00Z", reason: null };
  };
  const budget = { remaining: 2 };

  const results = await applyPossiblyUnmaintainedHeuristic(candidates, {
    githubCheck,
    now: NOW,
    githubApiBudget: budget,
    concurrency: 1, // deterministic ordering for this assertion
  });

  assert.equal(calledWith.length, 2, "only 2 of 4 candidates should have actually been queried");
  assert.equal(budget.remaining, 0);

  const queried = results.filter((r) => calledWith.includes(`${r.id}-repo`));
  const skipped = results.filter((r) => !calledWith.includes(`${r.id}-repo`));
  assert.equal(queried.length, 2);
  assert.equal(skipped.length, 2);
  for (const pkg of skipped) {
    assert.equal(pkg.githubArchived, null, `${pkg.id} should be unknown, not queried`);
    assert.equal(pkg.repoDormant, null);
    // Governing: CLAUDE.md rule 1 — budget exhaustion degrades to "unknown",
    // never treated as evidence toward "possibly unmaintained".
    assert.equal(pkg.possiblyUnmaintained, false);
  }
});

test("possibly-unmaintained: without a githubApiBudget option, every eligible candidate is still queried unconditionally (default behavior unchanged)", async () => {
  const candidates = ["a", "b", "c"].map((id) =>
    failingPkg(id, {
      links: { url: `https://github.com/foo/${id}-repo`, bugs: null, changelog: null },
    })
  );
  let calls = 0;
  const githubCheck = async () => {
    calls++;
    return { archived: false, pushedAt: "2026-07-01T00:00:00Z", reason: null };
  };

  await applyPossiblyUnmaintainedHeuristic(candidates, { githubCheck, now: NOW });

  assert.equal(calls, 3);
});

// Governing: SPEC-0001 REQ "Possibly Unmaintained Heuristic" Scenario:
// Package not hosted on GitHub.
test("possibly-unmaintained: no GitHub link -> not flagged (unknown, not evidence)", async () => {
  const pkg = failingPkg("no-signal", { links: { url: null, bugs: null, changelog: null } });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], { now: NOW });

  assert.equal(result.githubArchived, null);
  assert.equal(result.repoDormant, null);
  assert.equal(result.possiblyUnmaintained, false);
});

// --- classifyCompatibility (end-to-end pipeline) ---------------------------

test("classifyCompatibility ties inferredLatest, severity, and possiblyUnmaintained together", async () => {
  const results = [
    okPkg({
      id: "leader",
      verified: "14",
      latestVersion: "2.0.0",
      compatibility: { verified: "14", maximum: null, minimum: null, compatibleCoreVersion: null },
    }),
    okPkg({
      id: "straggler",
      verified: "12",
      latestVersion: "1.0.0",
      compatibility: { verified: "12", maximum: "12", minimum: null, compatibleCoreVersion: null },
      links: { url: "https://github.com/foo/straggler", bugs: null, changelog: null },
    }),
  ];
  const githubCheck = async () => ({ archived: true, pushedAt: "2026-07-01T00:00:00Z", reason: null });

  const { comparisonTarget, packages } = await classifyCompatibility(results, "13", {
    githubCheck,
    now: NOW,
  });

  assert.equal(comparisonTarget.value, "14");

  const straggler = packages.find((p) => p.id === "straggler");
  assert.equal(straggler.severity, "hard"); // maximum (12) below game.release (13)
  assert.equal(straggler.possiblyUnmaintained, true); // archived

  const leader = packages.find((p) => p.id === "leader");
  assert.equal(leader.severity, null);
  assert.equal(leader.possiblyUnmaintained, false);
});

// --- classifyActiveCompatibility: shared GitHub API rate-limit budget -----
//
// Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag Resolution",
// SPEC-0002 REQ "Fallback Scope and Limits" (revised) — proves the
// cross-file sharing actually works: release-tag resolution
// (manifest-fetcher.js, run during the fetch pass) and the possibly-
// unmaintained heuristic's archived-repo check (this file, run during
// classification) must draw from the SAME counter within one
// `classifyActiveCompatibility` call, not each get an independent budget of
// their own.
test("classifyActiveCompatibility: release-tag resolution and the possibly-unmaintained heuristic draw from one shared rate-limit budget", async () => {
  const budgetTotal = 3;

  // 5 packages, each: declared URL always fails; fallback is github.com
  // hosted (eligible for tag resolution); the raw/HEAD fallback manifest's
  // compatibility.verified ("10") is old enough to also fail the verified
  // check against game.release ("13"), making every package a candidate for
  // BOTH consumers. Without real sharing, 5 tag-resolution attempts (each
  // capped by its own budget) plus 5 archived-repo checks (each capped by
  // its own budget) could draw up to 2x the nominal budget; with a truly
  // shared counter, total api.github.com calls across both concerns can
  // never exceed budgetTotal.
  const packages = Array.from({ length: 5 }, (_, i) => ({
    id: `pkg-${i}`,
    title: `Pkg ${i}`,
    active: true,
    version: "1.0.0",
    manifest: `https://github.com/owner/pkg-${i}/releases/latest/download/module.json`,
  }));

  const githubApiUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com/repos/owner/pkg-")) {
      githubApiUrls.push(url);
      // Every api.github.com call fails (no releases published / archived
      // lookup fails) — this isolates the test to counting *attempts*, not
      // depending on success/failure outcomes.
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (url.includes("raw.githubusercontent.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "0.1.0", compatibility: { verified: "10" } }),
      };
    }
    // Declared manifest URL — always fails, forcing the fallback path.
    throw new TypeError("Failed to fetch");
  };

  const game = {
    modules: packages,
    system: null,
    release: { generation: "13", version: "13.351" },
    data: { coreUpdate: null },
  };

  const { packages: classified } = await classifyActiveCompatibility({
    game,
    fetchImpl,
    githubApiBudget: { remaining: budgetTotal },
    concurrency: 6,
    cache: new Map(), // isolate from the module-level session cache
  });

  assert.equal(classified.length, 5);
  assert.ok(
    githubApiUrls.length <= budgetTotal,
    `expected at most ${budgetTotal} total api.github.com calls across both consumers, got ${githubApiUrls.length}`
  );
  // The budget was genuinely exercised down to zero, not merely unused —
  // proves the counter is actually shared rather than each consumer having
  // silently skipped its own calls for unrelated reasons.
  assert.equal(githubApiUrls.length, budgetTotal);
});

test("classifyActiveCompatibility: a fresh default budget is created automatically when none is supplied (production call path)", async () => {
  const packages = [
    {
      id: "pkg-0",
      title: "Pkg 0",
      active: true,
      version: "1.0.0",
      manifest: "https://github.com/owner/pkg-0/releases/latest/download/module.json",
    },
  ];

  const githubApiUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) {
      githubApiUrls.push(url);
      return okResponse({ tag_name: "2.0.0" });
    }
    if (url === "https://raw.githubusercontent.com/owner/pkg-0/2.0.0/module.json") {
      return okResponse({ version: "2.0.0", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const game = {
    modules: packages,
    system: null,
    release: { generation: "13", version: "13.351" },
    data: { coreUpdate: null },
  };

  const { packages: classified } = await classifyActiveCompatibility({
    game,
    fetchImpl,
    cache: new Map(), // isolate from the module-level session cache
  });

  // No githubApiBudget was passed in, yet release-tag resolution still ran
  // (a default budget must have been created internally) and succeeded.
  assert.ok(githubApiUrls.length >= 1);
  assert.equal(classified[0].provenance, "release");
});

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}
