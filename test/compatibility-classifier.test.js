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
  applyPossiblyUnmaintainedHeuristic,
  classifyCompatibility,
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

test("checkGithubArchived treats API failure as unknown (archived: null), not evidence either way", async () => {
  const rateLimited = async () => ({ ok: false, status: 403 });
  const networkError = async () => {
    throw new Error("network down");
  };

  const a = await checkGithubArchived({ owner: "foo", repo: "bar" }, { fetchImpl: rateLimited });
  const b = await checkGithubArchived({ owner: "foo", repo: "bar" }, { fetchImpl: networkError });

  assert.equal(a.archived, null);
  assert.equal(b.archived, null);
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

test("possibly-unmaintained: both signals present (frozen version + archived) -> flagged", async () => {
  const pkg = failingPkg("frozen-and-archived", {
    latestVersion: "1.0.0",
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: true, reason: null });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], {
    previousVersions: { "frozen-and-archived": "1.0.0" },
    githubCheck,
  });

  assert.equal(result.versionFrozen, true);
  assert.equal(result.githubArchived, true);
  assert.equal(result.possiblyUnmaintained, true);
});

test("possibly-unmaintained: only one signal present -> not flagged", async () => {
  const pkg = failingPkg("version-changed-not-archived", {
    latestVersion: "1.1.0",
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: false, reason: null });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], {
    previousVersions: { "version-changed-not-archived": "1.0.0" }, // version changed since last check
    githubCheck,
  });

  assert.equal(result.versionFrozen, false);
  assert.equal(result.githubArchived, false);
  assert.equal(result.possiblyUnmaintained, false);
});

test("possibly-unmaintained: GitHub API failure treated as unknown, never flags on its own", async () => {
  const pkg = failingPkg("api-failure", {
    latestVersion: "1.0.0",
    links: { url: "https://github.com/foo/bar", bugs: null, changelog: null },
  });
  const githubCheck = async () => ({ archived: null, reason: "rate-limited" });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], {
    previousVersions: {}, // no baseline -> versionFrozen unknown (null) too
    githubCheck,
  });

  assert.equal(result.versionFrozen, null);
  assert.equal(result.githubArchived, null);
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
    return { archived: false, reason: null };
  };

  await applyPossiblyUnmaintainedHeuristic([failing, passing], { githubCheck });

  assert.deepEqual(calledWith, ["failing-repo"]);
});

test("possibly-unmaintained: no GitHub link and no version history -> not flagged (unknown, not evidence)", async () => {
  const pkg = failingPkg("no-signal", { links: { url: null, bugs: null, changelog: null } });

  const [result] = await applyPossiblyUnmaintainedHeuristic([pkg], { previousVersions: {} });

  assert.equal(result.versionFrozen, null);
  assert.equal(result.githubArchived, null);
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
  const githubCheck = async () => ({ archived: true, reason: null });

  const { comparisonTarget, packages } = await classifyCompatibility(results, "13", {
    previousVersions: { straggler: "1.0.0" },
    githubCheck,
  });

  assert.equal(comparisonTarget.value, "14");

  const straggler = packages.find((p) => p.id === "straggler");
  assert.equal(straggler.severity, "hard"); // maximum (12) below game.release (13)
  assert.equal(straggler.possiblyUnmaintained, true); // frozen version + archived

  const leader = packages.find((p) => p.id === "leader");
  assert.equal(leader.severity, null);
  assert.equal(leader.possiblyUnmaintained, false);
});
