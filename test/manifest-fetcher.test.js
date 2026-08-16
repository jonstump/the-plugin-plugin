// Unit tests for the pure/dependency-injectable logic in
// scripts/manifest-fetcher.js. No Foundry `game` global required.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Error Handling
// Standards", SPEC-0001 REQ "Fetch Concurrency and Caching", ADR-0003,
// SPEC-0002 REQ "Fallback Trigger and Ordering", REQ "Fallback URL
// Derivation", REQ "Fallback Scope and Limits", REQ "Error Handling
// Standards", REQ "Concurrency and Caching Interaction"

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runWithConcurrency,
  fetchPackageManifest,
  checkPackages,
  compareVersions,
  isNewerVersion,
  getActivePackagesFromGame,
  deriveFallbackUrl,
  consumeGithubApiBudget,
  DEFAULT_GITHUB_API_BUDGET,
} from "../scripts/manifest-fetcher.js";

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// --- runWithConcurrency -----------------------------------------------

test("runWithConcurrency never exceeds the configured limit", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let active = 0;
  let maxActive = 0;

  await runWithConcurrency(
    items,
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    },
    { concurrency: 4 }
  );

  assert.ok(maxActive <= 4, `maxActive was ${maxActive}, expected <= 4`);
  // With 20 items and a real delay, the pool should actually reach the cap.
  assert.strictEqual(maxActive, 4);
});

test("runWithConcurrency preserves result order", async () => {
  const items = [3, 1, 2];
  const results = await runWithConcurrency(
    items,
    async (x) => {
      await new Promise((resolve) => setTimeout(resolve, x));
      return x * 2;
    },
    { concurrency: 2 }
  );
  assert.deepEqual(results, [6, 2, 4]);
});

// --- fetchPackageManifest / error isolation ----------------------------

test("fetchPackageManifest attributes failure to the specific package", async () => {
  const pkg = {
    id: "dead-mod",
    title: "Dead Mod",
    manifestUrl: "https://example.com/dead-mod.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () => ({ ok: false, status: 404 });

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.equal(result.error.packageId, "dead-mod");
  assert.match(result.error.message, /404/);
});

test("fetchPackageManifest catches network errors without throwing", async () => {
  const pkg = {
    id: "cors-blocked",
    title: "CORS Blocked",
    manifestUrl: "https://example.com/cors-blocked.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.equal(result.error.packageId, "cors-blocked");
});

test("fetchPackageManifest catches malformed JSON without throwing", async () => {
  const pkg = {
    id: "bad-json",
    title: "Bad JSON",
    manifestUrl: "https://example.com/bad-json.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token in JSON");
    },
  });

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.match(result.error.message, /not valid JSON/);
});

test("fetchPackageManifest errors when no manifest URL is declared", async () => {
  const pkg = {
    id: "no-manifest",
    title: "No Manifest",
    manifestUrl: null,
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () => {
    throw new Error("fetchImpl should not be called");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.equal(result.error.packageId, "no-manifest");
});

test("fetchPackageManifest detects update availability from version comparison", async () => {
  const pkg = {
    id: "some-mod",
    title: "Some Mod",
    manifestUrl: "https://example.com/some-mod.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () =>
    okResponse({ version: "1.1.0", compatibility: { verified: "13" } });

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "ok");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, "1.1.0");
  assert.equal(result.verified, "13");
});

test("fetchPackageManifest falls back to compatibleCoreVersion when compatibility is absent", async () => {
  const pkg = {
    id: "legacy-mod",
    title: "Legacy Mod",
    manifestUrl: "https://example.com/legacy-mod.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () =>
    okResponse({ version: "1.0.0", compatibleCoreVersion: "12" });

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "ok");
  // Folded convenience field uses the legacy fallback per SPEC-0001.
  assert.equal(result.verified, "12");
  // Raw fields are preserved separately for downstream (issue #7) severity
  // classification, which needs to know the fallback happened.
  assert.equal(result.compatibility.verified, null);
  assert.equal(result.compatibility.compatibleCoreVersion, "12");
});

// --- deriveFallbackUrl ---------------------------------------------------

test("deriveFallbackUrl parses owner/repo and carries the filename through for a module manifest", () => {
  const fallback = deriveFallbackUrl(
    "https://github.com/ruipin/fvtt-lib-wrapper/releases/latest/download/module.json"
  );
  assert.equal(
    fallback,
    "https://raw.githubusercontent.com/ruipin/fvtt-lib-wrapper/HEAD/module.json"
  );
});

test("deriveFallbackUrl carries system.json through rather than hardcoding module.json", () => {
  const fallback = deriveFallbackUrl(
    "https://github.com/foundryvtt/starfinder/releases/latest/download/system.json"
  );
  assert.equal(
    fallback,
    "https://raw.githubusercontent.com/foundryvtt/starfinder/HEAD/system.json"
  );
});

test("deriveFallbackUrl returns null for a host with no known CORS-open path (ADR-0008)", () => {
  // codeberg.org — a major public Gitea/Forgejo instance, verified (ADR-0008
  // Amendment 3) to have no CORS header on its own raw endpoint, and no
  // generic third-party mirror exists for self-hostable forges by
  // construction (unlike github.com/gitlab.com/bitbucket.org, which are
  // fixed, well-known domains a CDN can build support for by name).
  assert.equal(
    deriveFallbackUrl("https://codeberg.org/owner/repo/raw/branch/main/module.json"),
    null
  );
  assert.equal(deriveFallbackUrl("https://example.com/module.json"), null);
});

// --- deriveFallbackUrl: gitlab.com (ADR-0008 Amendment, 2026-08-16) --------
// GitLab's own raw-file endpoint and API send no Access-Control-Allow-Origin
// header (measured, ADR-0008) — the fallback goes through cdn.statically.io,
// a CORS-open third-party mirror, instead. Same owner/repo/filename
// derivation as the GitHub case, just a different host template.

test("deriveFallbackUrl derives a cdn.statically.io URL for a gitlab.com-hosted declared URL", () => {
  const fallback = deriveFallbackUrl(
    "https://gitlab.com/foundry-azzurite/pings/-/jobs/artifacts/master/raw/dist/pings/module.json?job=build"
  );
  assert.equal(fallback, "https://cdn.statically.io/gl/foundry-azzurite/pings@HEAD/module.json");
});

test("deriveFallbackUrl carries system.json through for a gitlab.com-hosted game system", () => {
  const fallback = deriveFallbackUrl("https://gitlab.com/owner/some-system/-/raw/main/system.json");
  assert.equal(fallback, "https://cdn.statically.io/gl/owner/some-system@HEAD/system.json");
});

// --- deriveFallbackUrl: bitbucket.org (ADR-0008 Amendment 3, 2026-08-16) ---
// Bitbucket's own raw-file endpoint also sends no Access-Control-Allow-Origin
// header (measured, ADR-0008 Amendment 3) — same cdn.statically.io mirror
// pattern as GitLab, `/bb/` instead of `/gl/`.

test("deriveFallbackUrl derives a cdn.statically.io URL for a bitbucket.org-hosted declared URL", () => {
  const fallback = deriveFallbackUrl(
    "https://bitbucket.org/rpgframework-cloud/shadowrun6-eden/raw/master/system.json"
  );
  assert.equal(
    fallback,
    "https://cdn.statically.io/bb/rpgframework-cloud/shadowrun6-eden@HEAD/system.json"
  );
});

test("deriveFallbackUrl carries module.json through for a bitbucket.org-hosted module", () => {
  const fallback = deriveFallbackUrl("https://bitbucket.org/owner/some-module/raw/main/module.json");
  assert.equal(fallback, "https://cdn.statically.io/bb/owner/some-module@HEAD/module.json");
});

test("deriveFallbackUrl returns null when it can't parse owner/repo/filename", () => {
  assert.equal(deriveFallbackUrl("https://github.com/owner-only"), null);
  assert.equal(deriveFallbackUrl(null), null);
  assert.equal(deriveFallbackUrl("not a url"), null);
});

// --- fetchPackageManifest: fallback trigger, ordering, scope ------------

test("fetchPackageManifest uses the declared manifest and issues no fallback request when it succeeds", async () => {
  const pkg = {
    id: "good-mod",
    title: "Good Mod",
    manifestUrl: "https://github.com/owner/good-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return okResponse({ version: "1.1.0", compatibility: { verified: "13" } });
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "declared");
});

test("fetchPackageManifest falls back exactly once when the declared github.com URL fails", async () => {
  const pkg = {
    id: "flaky-mod",
    title: "Flaky Mod",
    manifestUrl: "https://github.com/owner/flaky-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "2.0.0", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.deepEqual(requestedUrls, [
    "https://github.com/owner/flaky-mod/releases/latest/download/module.json",
    "https://raw.githubusercontent.com/owner/flaky-mod/HEAD/module.json",
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  // Governing: ADR-0003 (amended 2026-08-16), SPEC-0002 REQ "Fallback Field
  // Trust" (issue #48) — a fallback-sourced `version` is unknown, full stop,
  // even though "2.0.0" is numerically newer than the installed "1.0.0" and
  // would pass a naive "only trust it if it looks like an update" check.
  // `compatibility.verified` is still trusted from the same fallback
  // manifest.
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
  assert.equal(result.verified, "14");
});

// --- Fallback Field Trust: `version` is unknown regardless of skew direction
// (issue #48, ADR-0003 amended 2026-08-16, SPEC-0002 REQ "Fallback Field
// Trust") -------------------------------------------------------------------

test("fetchPackageManifest: a fallback-sourced version OLDER than installed is unknown, not 'up to date' (the reported false-negative)", async () => {
  // Governing: ADR-0003's 2026-08-16 amendment "Smart-Target" case —
  // installed 0.9.8, fallback-sourced `version` reads 0.5.1 (a stale
  // placeholder from the repo's default branch), actual latest release was
  // 4.0.0. Before this fix, `isNewerVersion("0.5.1", "0.9.8")` is false, so
  // `updateAvailable` came back `false` and the GM was told they were
  // current while three major versions behind.
  const pkg = {
    id: "smarttarget",
    title: "Smart Target",
    manifestUrl:
      "https://github.com/theripper93/Smart-Target/releases/latest/download/module.json",
    installedVersion: "0.9.8",
  };
  const fetchImpl = async (url) => {
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "0.5.1", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
  // compatibility.verified is unaffected by this fix — still trusted.
  assert.equal(result.verified, "14");
});

test("fetchPackageManifest: a fallback-sourced version NEWER than installed is still unknown — not evidence of a real update (plausibility check explicitly rejected)", async () => {
  // Governing: SPEC-0002 REQ "Fallback Field Trust" — "MUST NOT gate ... on
  // a plausibility check such as 'only when newer than the installed
  // version' — a stale placeholder that happens to be higher passes such a
  // check and still reports wrongly." This covers the direction the
  // plausibility-check shortcut would otherwise let through unnoticed.
  const pkg = {
    id: "some-other-mod",
    title: "Some Other Mod",
    manifestUrl: "https://github.com/owner/some-other-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async (url) => {
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "9.9.9", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
});

test("fetchPackageManifest: a declared-sourced result is unaffected by Fallback Field Trust (regression guard, issue #48)", async () => {
  // The declared manifest URL succeeds on the first attempt here, so no
  // fallback is ever reached — `version`/`updateAvailable` must be derived
  // exactly as before this fix.
  const pkg = {
    id: "well-behaved-mod",
    title: "Well Behaved Mod",
    manifestUrl: "https://example.com/well-behaved-mod.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async () =>
    okResponse({ version: "1.5.0", compatibility: { verified: "13" } });

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "declared");
  assert.equal(result.latestVersion, "1.5.0");
  assert.equal(result.updateAvailable, true);
});

test("fetchPackageManifest reports Couldn't check with a both-attempts diagnostic when declared and fallback both fail", async () => {
  const pkg = {
    id: "dead-both",
    title: "Dead Both",
    manifestUrl: "https://github.com/owner/dead-both/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes("raw.githubusercontent.com")) {
      return { ok: false, status: 404 };
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(calls, 2);
  assert.equal(result.status, "error");
  assert.equal(result.provenance, null);
  assert.equal(result.error.packageId, "dead-both");
  // Governing: SPEC-0002 REQ "Error Handling Standards" — the diagnostic
  // makes clear both a declared and a fallback attempt were made, so this
  // isn't mistaken for an untried package.
  assert.match(result.error.message, /Declared manifest URL failed/);
  assert.match(result.error.message, /Fallback .* also failed/);
});

test("fetchPackageManifest carries system.json through the fallback for a game system", async () => {
  const pkg = {
    id: "sfrpg",
    title: "Starfinder",
    manifestUrl: "https://github.com/foundryvtt/starfinder/releases/latest/download/system.json",
    installedVersion: "0.30.1",
    isSystem: true,
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "0.31.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(
    requestedUrls[1],
    "https://raw.githubusercontent.com/foundryvtt/starfinder/HEAD/system.json"
  );
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
});

test("fetchPackageManifest does not attempt a fallback for a host with no known CORS-open path", async () => {
  const pkg = {
    id: "codeberg-mod",
    title: "Codeberg Mod",
    manifestUrl: "https://codeberg.org/owner/codeberg-mod/raw/branch/main/module.json",
    installedVersion: "1.0.0",
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(calls, 1, "no fallback request should be issued for an unsupported host");
  assert.equal(result.status, "error");
  assert.equal(result.provenance, null);
});

// --- fetchPackageManifest: gitlab.com fallback (ADR-0008 Amendment) --------

test("fetchPackageManifest falls back to cdn.statically.io when a gitlab.com declared URL fails", async () => {
  const pkg = {
    id: "pings",
    title: "Pings",
    manifestUrl:
      "https://gitlab.com/foundry-azzurite/pings/-/jobs/artifacts/master/raw/dist/pings/module.json?job=build",
    installedVersion: "1.4.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url === "https://cdn.statically.io/gl/foundry-azzurite/pings@HEAD/module.json") {
      return okResponse({ version: "1.3.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.deepEqual(requestedUrls, [
    "https://gitlab.com/foundry-azzurite/pings/-/jobs/artifacts/master/raw/dist/pings/module.json?job=build",
    "https://cdn.statically.io/gl/foundry-azzurite/pings@HEAD/module.json",
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  // Fallback Field Trust applies identically regardless of which host the
  // fallback came from — a default-branch read is a default-branch read.
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
  assert.equal(result.verified, "13");
});

test("fetchPackageManifest: gitlab.com fallback also fails -> Couldn't check, same outcome as if the fallback didn't exist (ADR-0008 Amendment)", async () => {
  // Matches the real-world pings/settings-extender case: manifest is a CI
  // build artifact, never committed to the repo, so the mirror 404s too.
  const pkg = {
    id: "pings",
    title: "Pings",
    manifestUrl:
      "https://gitlab.com/foundry-azzurite/pings/-/jobs/artifacts/master/raw/dist/pings/module.json?job=build",
    installedVersion: "1.4.0",
  };
  const fetchImpl = async (url) => {
    if (url.includes("cdn.statically.io")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.equal(result.provenance, null);
  assert.ok(result.error.message.includes("cdn.statically.io"));
});

// Governing: ADR-0008 Amendment — real-world positive proof, not just a
// synthetic fixture. `ManeaRoliste/manea-maps` is a genuinely published
// GitLab-hosted Foundry module whose manifest IS committed to the repo
// root (unlike pings/settings-extender's CI-artifact case). Verified live
// in an actual CORS-enforcing browser (not Node's fetch, which never
// enforces CORS at all and would pass this trivially for the wrong
// reason): the declared gitlab.com/-/raw/ URL genuinely CORS-blocks (no
// Access-Control-Allow-Origin, confirmed via curl), the cdn.statically.io
// fallback genuinely resolves it, and the response is this module's real,
// current manifest content, reproduced verbatim below. This module also
// predates Foundry's `compatibility` object schema (Foundry v9-era), so
// it incidentally exercises SPEC-0001 REQ "Manifest Check"'s legacy
// `compatibleCoreVersion` fallback through the GitLab mirror path too.
test("fetchPackageManifest: real-world GitLab module (manea-maps) with a manifest committed to the repo root resolves via the fallback", async () => {
  const pkg = {
    id: "manea-maps",
    title: "Manea's Maps",
    manifestUrl: "https://gitlab.com/ManeaRoliste/manea-maps/-/raw/main/module.json",
    installedVersion: "0.9.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url === "https://cdn.statically.io/gl/ManeaRoliste/manea-maps@HEAD/module.json") {
      // Verbatim (trimmed) real response, fetched live 2026-08-16.
      return okResponse({
        name: "manea-maps",
        title: "Manea's Maps",
        author: "ManeaRoliste",
        version: "1.0.0",
        minimumCoreVersion: "0.8.6",
        compatibleCoreVersion: "9",
      });
    }
    // The declared gitlab.com/-/raw/ URL: genuinely CORS-blocked in a real
    // browser (confirmed live, no Access-Control-Allow-Origin header).
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.deepEqual(requestedUrls, [
    "https://gitlab.com/ManeaRoliste/manea-maps/-/raw/main/module.json",
    "https://cdn.statically.io/gl/ManeaRoliste/manea-maps@HEAD/module.json",
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  // Legacy compatibleCoreVersion, folded into `verified` per REQ "Manifest
  // Check"'s legacy-field fallback — works identically through the GitLab
  // mirror as it already does for a declared or GitHub-fallback result.
  assert.equal(result.verified, "9");
  // Fallback Field Trust withholds version/updateAvailable regardless of
  // host — the real committed version (1.0.0) is genuinely newer than the
  // installed 0.9.0 here, and the system still correctly reports unknown
  // rather than surfacing that as a trusted "update available" verdict.
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
});

// --- fetchPackageManifest: bitbucket.org fallback (ADR-0008 Amendment 3) --
//
// Bitbucket's CORS posture turned out more nuanced than GitLab's, discovered
// live (not assumed) while looking for a real-world positive-proof package:
//
// - Bitbucket's `/raw/<branch>/<file>` endpoint (source browsing) DOES send
//   `Access-Control-Allow-Origin`, but only when the request carries an
//   `Origin` header — it reflects the origin rather than sending a static
//   `*`. `curl` sends no `Origin` header by default, which produced a false
//   "no CORS" reading during initial investigation; `curl -H "Origin: ..."`
//   (or a real browser, which always sends one) shows the true picture.
//   Practically: a package declaring a plain `bitbucket.org/.../raw/...`
//   manifest URL needs NO fallback at all — the declared attempt already
//   succeeds, the same way `multilevel-tokens` already declares a
//   `raw.githubusercontent.com` URL directly (ADR-0003).
// - Bitbucket's "Downloads" feature (uploaded release artifacts, Bitbucket's
//   rough equivalent of a GitHub release asset) is where the real CORS gap
//   lives: it 302-redirects to a presigned S3 URL that sends no CORS header
//   at all, even with Origin present — the exact shape of GitHub's
//   `releases/latest/download/...` problem (ADR-0003's original trigger).
//
// The below therefore mirrors the GitLab fallback tests with synthetic
// (mocked) fixtures — a real "downloads"-hosted, git-committed Bitbucket
// Foundry manifest was not found; the one real candidate located
// (`rpgframework-cloud/shadowrun6-eden`) uses "Downloads" for a file that
// isn't in the git tree either, so it's a real *negative* case, the same
// shape as GitLab's pings/settings-extender — covered further down. The
// real *positive* Bitbucket proof, further below, is the `raw/` case:
// declared-URL success, needing no fallback at all.

test("fetchPackageManifest falls back to cdn.statically.io when a bitbucket.org Downloads URL fails (synthetic — mirrors the real 302-to-uncors'd-S3 shape)", async () => {
  const pkg = {
    id: "bb-mod",
    title: "Bitbucket Mod",
    manifestUrl: "https://bitbucket.org/owner/bb-mod/downloads/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url === "https://cdn.statically.io/bb/owner/bb-mod@HEAD/module.json") {
      return okResponse({ version: "0.9.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.deepEqual(requestedUrls, [
    "https://bitbucket.org/owner/bb-mod/downloads/module.json",
    "https://cdn.statically.io/bb/owner/bb-mod@HEAD/module.json",
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
  assert.equal(result.verified, "13");
});

test("fetchPackageManifest: bitbucket.org fallback also fails -> Couldn't check, same outcome as if the fallback didn't exist", async () => {
  const pkg = {
    id: "bb-mod",
    title: "Bitbucket Mod",
    manifestUrl: "https://bitbucket.org/owner/bb-mod/downloads/module.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async (url) => {
    if (url.includes("cdn.statically.io")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.equal(result.provenance, null);
  assert.ok(result.error.message.includes("cdn.statically.io"));
});

// Governing: ADR-0008 Amendment 3 — real-world positive proof, but of a
// different fact than the manea-maps GitLab test above: Bitbucket's `raw/`
// convention needs no fallback at all. `rpgframework-cloud/shadowrun6-eden`
// is a genuinely published Bitbucket-hosted Foundry game system (Shadowrun
// 6); its `raw/master/system.json` file IS committed to the repo root.
// Verified live in an actual CORS-enforcing browser: the declared
// bitbucket.org/raw/ URL succeeds directly (Bitbucket reflects
// Access-Control-Allow-Origin when a real Origin header is sent — see the
// note above the Downloads-fallback tests), so `fetchPackageManifest` never
// even reaches the fallback branch. Response content below is this system's
// real, current manifest (trimmed to the fields this module reads).
test("fetchPackageManifest: real-world Bitbucket system (shadowrun6-eden) resolves directly via its declared raw/ URL — no fallback needed", async () => {
  const pkg = {
    id: "shadowrun6-eden",
    title: "Shadowrun 6",
    isSystem: true,
    manifestUrl: "https://bitbucket.org/rpgframework-cloud/shadowrun6-eden/raw/master/system.json",
    installedVersion: "0.0.1",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    // Verbatim (trimmed) real response, fetched live 2026-08-16 — the
    // declared URL itself, not a fallback.
    return okResponse({
      id: "shadowrun6-eden",
      title: "Shadowrun 6",
      version: "0.0.1",
      compatibility: { minimum: 10, verified: "11", maximum: 11 },
      compatibleCoreVersion: null,
    });
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.deepEqual(requestedUrls, [
    "https://bitbucket.org/rpgframework-cloud/shadowrun6-eden/raw/master/system.json",
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "declared");
  assert.equal(result.verified, "11");
  // Declared-sourced data is fully trusted, unlike a fallback result.
  assert.equal(result.latestVersion, "0.0.1");
  assert.equal(result.updateAvailable, false);
});

// Governing: ADR-0008 Amendment 3 — real-world *negative* case, the
// Bitbucket equivalent of GitLab's pings/settings-extender: a real package
// (this same repo) whose Downloads-hosted manifest variant is not committed
// to git source at all, so neither the declared URL nor the
// cdn.statically.io fallback can find it. Confirmed live: both the origin's
// own raw path and the statically.io mirror 404 for this exact file.
test("fetchPackageManifest: real-world Bitbucket Downloads file not committed to git source -> Couldn't check on both attempts (shadowrun6-eden's staging manifest)", async () => {
  const pkg = {
    id: "shadowrun6-eden-staging",
    title: "Shadowrun 6 (staging)",
    isSystem: true,
    manifestUrl:
      "https://bitbucket.org/rpgframework-cloud/shadowrun6-eden/downloads/system-staging.json",
    installedVersion: "0.0.1",
  };
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(result.status, "error");
  assert.equal(result.provenance, null);
});

test("fetchPackageManifest treats a fallback 404 as terminal (manifest not at repo root)", async () => {
  const pkg = {
    id: "built-manifest",
    title: "Built Manifest System",
    manifestUrl: "https://github.com/owner/built-manifest/releases/latest/download/system.json",
    installedVersion: "1.0.0",
  };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes("raw.githubusercontent.com")) {
      return { ok: false, status: 404 };
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.equal(calls, 2, "exactly one fallback attempt, no retries after the 404");
  assert.equal(result.status, "error");
});

test("fetchPackageManifest never calls the GitHub API as part of the fallback when no rate-limit budget is provided (opt-in feature, ADR-0003 Amendment 2)", async () => {
  // Governing: ADR-0003 Amendment 2, SPEC-0002 REQ "Release Tag Resolution"
  // — release-tag resolution against api.github.com is opt-in via
  // `options.githubApiBudget`. This call doesn't pass that option, so the
  // original claim ("fallback never calls the GitHub API") still holds
  // exactly as before this feature; see the "release tag resolution" tests
  // below for the budget-supplied behavior.
  const pkg = {
    id: "no-api-mod",
    title: "No API Mod",
    manifestUrl: "https://github.com/owner/no-api-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "1.0.0" });
    }
    throw new TypeError("Failed to fetch");
  };

  await fetchPackageManifest(pkg, { fetchImpl });

  assert.ok(
    requestedUrls.every((url) => !url.includes("api.github.com")),
    "fallback must not spend GitHub API rate-limit budget"
  );
});

// --- Release Tag Resolution (ADR-0003 Amendment 2, SPEC-0002 REQ "Release
// Tag Resolution", issue #58/#59) -------------------------------------------
//
// A third resolution path, tried before the raw/HEAD fallback, when a shared
// `githubApiBudget` is supplied: resolve the repo's actual latest release
// tag via `GET /repos/{owner}/{repo}/releases/latest`, then fetch the
// manifest AT that tag. Unlike the raw/HEAD fallback, this data is genuinely
// trustworthy — both `version` and `compatibility.verified` are used exactly
// as a `declared` result would be, under a distinct `"release"` provenance.

test("fetchPackageManifest: a resolved release tag yields a fully-trustworthy 'release'-provenance result (real smarttarget-style skew)", async () => {
  // Governing: ADR-0003 Amendment 2 — mirrors the real-world case (issue
  // #58) where the fallback-sourced `version` was a stale placeholder but
  // the repo's actual latest GitHub release was genuinely much newer.
  const pkg = {
    id: "smarttarget",
    title: "Smart Target",
    manifestUrl:
      "https://github.com/theripper93/Smart-Target/releases/latest/download/module.json",
    installedVersion: "0.9.8",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url === "https://api.github.com/repos/theripper93/Smart-Target/releases/latest") {
      return okResponse({ tag_name: "4.0.0" });
    }
    if (url === "https://raw.githubusercontent.com/theripper93/Smart-Target/4.0.0/module.json") {
      return okResponse({ version: "4.0.0", compatibility: { verified: "14" } });
    }
    // Declared URL, and the raw/HEAD fallback (must never be reached).
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, {
    fetchImpl,
    githubApiBudget: { remaining: 5 },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "release");
  // Unlike a "fallback" result, both version and updateAvailable are real.
  assert.equal(result.latestVersion, "4.0.0");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.verified, "14");
  assert.ok(
    !requestedUrls.includes(
      "https://raw.githubusercontent.com/theripper93/Smart-Target/HEAD/module.json"
    ),
    "raw/HEAD fallback must not be attempted once tag resolution succeeds"
  );
});

test("fetchPackageManifest: no releases published (404) falls through to raw/HEAD fallback unchanged", async () => {
  // This is the the-plugin-plugin-in-dev case: a repo with no tagged
  // releases yet. Tag resolution must fail silently, with the existing
  // raw/HEAD fallback (and its 'version unknown' Fallback Field Trust
  // behavior) picking up exactly as it does today.
  const pkg = {
    id: "in-dev-mod",
    title: "In Dev Mod",
    manifestUrl: "https://github.com/owner/in-dev-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("api.github.com/repos/owner/in-dev-mod/releases/latest")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "0.1.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, {
    fetchImpl,
    githubApiBudget: { remaining: 5 },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  assert.equal(result.latestVersion, null);
  assert.equal(result.updateAvailable, null);
  assert.equal(result.verified, "13");
  assert.deepEqual(requestedUrls, [
    "https://github.com/owner/in-dev-mod/releases/latest/download/module.json",
    "https://api.github.com/repos/owner/in-dev-mod/releases/latest",
    "https://raw.githubusercontent.com/owner/in-dev-mod/HEAD/module.json",
  ]);
});

test("fetchPackageManifest: tag resolves but the tag-resolved manifest fetch itself 404s -> falls through to raw/HEAD, no separate error", async () => {
  const pkg = {
    id: "tag-manifest-missing",
    title: "Tag Manifest Missing",
    manifestUrl:
      "https://github.com/owner/tag-manifest-missing/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com") && url.includes("/releases/latest")) {
      return okResponse({ tag_name: "v2.0.0" });
    }
    if (url === "https://raw.githubusercontent.com/owner/tag-manifest-missing/v2.0.0/module.json") {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (url === "https://raw.githubusercontent.com/owner/tag-manifest-missing/HEAD/module.json") {
      return okResponse({ version: "1.5.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, {
    fetchImpl,
    githubApiBudget: { remaining: 5 },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
  assert.equal(result.latestVersion, null);
  assert.equal(result.error, null);
});

test("fetchPackageManifest: the GitHub API call itself rejects (network failure) -> falls through to raw/HEAD fallback", async () => {
  const pkg = {
    id: "api-network-fail",
    title: "API Network Fail",
    manifestUrl:
      "https://github.com/owner/api-network-fail/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) {
      throw new TypeError("Failed to fetch");
    }
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "1.2.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const result = await fetchPackageManifest(pkg, {
    fetchImpl,
    githubApiBudget: { remaining: 5 },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provenance, "fallback");
});

test("fetchPackageManifest: no githubApiBudget option at all -> tag resolution never attempted, provenance is fallback as before this feature", async () => {
  const pkg = {
    id: "no-budget-mod",
    title: "No Budget Mod",
    manifestUrl: "https://github.com/owner/no-budget-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "9.9.9", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };

  // No `githubApiBudget` in options at all — the release-tag-resolution
  // block should never execute.
  const result = await fetchPackageManifest(pkg, { fetchImpl });

  assert.ok(requestedUrls.every((url) => !url.includes("api.github.com")));
  assert.equal(result.provenance, "fallback");
  assert.equal(result.latestVersion, null);
});

test("fetchPackageManifest: budget already exhausted ({remaining: 0}) -> tag resolution skipped, no api.github.com call made at all", async () => {
  const pkg = {
    id: "exhausted-budget-mod",
    title: "Exhausted Budget Mod",
    manifestUrl:
      "https://github.com/owner/exhausted-budget-mod/releases/latest/download/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "9.9.9", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };
  const budget = { remaining: 0 };

  const result = await fetchPackageManifest(pkg, { fetchImpl, githubApiBudget: budget });

  assert.ok(requestedUrls.every((url) => !url.includes("api.github.com")));
  assert.equal(result.provenance, "fallback");
  assert.equal(budget.remaining, 0, "an already-exhausted budget must not go negative");
});

test("fetchPackageManifest: a gitlab.com-hosted package never spends the shared GitHub API budget (ADR-0008 Amendment regression guard)", async () => {
  // Before the GitLab fallback existed, reaching this point in the function
  // implied the package was necessarily github.com-hosted (deriveFallbackUrl
  // only ever returned non-null for github.com). ADR-0008 Amendment broke
  // that assumption — a gitlab.com package now also has a non-null
  // fallbackUrl, so the tag-resolution budget check MUST parse the host
  // first and only consume budget for an actual github.com match, or a
  // GitLab-hosted package would silently burn shared rate-limit budget for
  // an API call it could never have made.
  const pkg = {
    id: "pings",
    title: "Pings",
    manifestUrl:
      "https://gitlab.com/foundry-azzurite/pings/-/jobs/artifacts/master/raw/dist/pings/module.json?job=build",
    installedVersion: "1.4.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("cdn.statically.io")) {
      return okResponse({ version: "1.3.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };
  const budget = { remaining: 5 };

  const result = await fetchPackageManifest(pkg, { fetchImpl, githubApiBudget: budget });

  assert.ok(requestedUrls.every((url) => !url.includes("api.github.com")));
  assert.equal(budget.remaining, 5, "budget must be untouched by a gitlab.com-hosted package");
  assert.equal(result.provenance, "fallback");
});

test("fetchPackageManifest: a bitbucket.org-hosted package also never spends the shared GitHub API budget (ADR-0008 Amendment 3 regression guard)", async () => {
  const pkg = {
    id: "bb-mod",
    title: "Bitbucket Mod",
    manifestUrl: "https://bitbucket.org/owner/bb-mod/raw/master/module.json",
    installedVersion: "1.0.0",
  };
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("cdn.statically.io")) {
      return okResponse({ version: "0.9.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };
  const budget = { remaining: 5 };

  const result = await fetchPackageManifest(pkg, { fetchImpl, githubApiBudget: budget });

  assert.ok(requestedUrls.every((url) => !url.includes("api.github.com")));
  assert.equal(budget.remaining, 5, "budget must be untouched by a bitbucket.org-hosted package");
  assert.equal(result.provenance, "fallback");
});

// --- consumeGithubApiBudget / DEFAULT_GITHUB_API_BUDGET ---------------------

test("consumeGithubApiBudget decrements remaining and returns true while capacity is left", () => {
  const budget = { remaining: 2 };

  assert.equal(consumeGithubApiBudget(budget), true);
  assert.equal(budget.remaining, 1);
  assert.equal(consumeGithubApiBudget(budget), true);
  assert.equal(budget.remaining, 0);
});

test("consumeGithubApiBudget returns false without decrementing further once at zero", () => {
  const budget = { remaining: 0 };

  assert.equal(consumeGithubApiBudget(budget), false);
  assert.equal(budget.remaining, 0);

  budget.remaining = -1; // pathological input; must never go more negative
  assert.equal(consumeGithubApiBudget(budget), false);
  assert.equal(budget.remaining, -1);
});

test("DEFAULT_GITHUB_API_BUDGET is a sane positive default", () => {
  assert.equal(typeof DEFAULT_GITHUB_API_BUDGET, "number");
  assert.ok(DEFAULT_GITHUB_API_BUDGET > 0);
});

// --- checkPackages: concurrency + isolation + caching -------------------

test("a single package's fetch failure does not affect any other package", async () => {
  const packages = [
    {
      id: "a",
      title: "A",
      manifestUrl: "https://example.com/a.json",
      installedVersion: "1.0.0",
    },
    {
      id: "b",
      title: "B",
      manifestUrl: "https://example.com/b.json",
      installedVersion: "1.0.0",
    },
    {
      id: "c",
      title: "C",
      manifestUrl: "https://example.com/c.json",
      installedVersion: "1.0.0",
    },
  ];
  const fetchImpl = async (url) => {
    if (url.includes("/b")) throw new TypeError("Failed to fetch");
    return okResponse({ version: "1.1.0", compatibility: { verified: "13" } });
  };

  const results = await checkPackages(packages, { fetchImpl, cache: new Map() });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  assert.equal(byId.a.status, "ok");
  assert.equal(byId.c.status, "ok");
  assert.equal(byId.b.status, "error");
  assert.equal(byId.b.error.packageId, "b");
});

test("cache prevents re-fetching a package within the same session", async () => {
  const packages = [
    {
      id: "cached-mod",
      title: "Cached Mod",
      manifestUrl: "https://example.com/cached-mod.json",
      installedVersion: "1.0.0",
    },
  ];
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return okResponse({ version: "1.1.0", compatibility: { verified: "13" } });
  };
  const cache = new Map();

  await checkPackages(packages, { fetchImpl, cache });
  assert.equal(callCount, 1);

  // Re-opening the checker within the same session: no re-fetch.
  const secondResults = await checkPackages(packages, { fetchImpl, cache });
  assert.equal(callCount, 1);
  assert.equal(secondResults[0].id, "cached-mod");

  // An explicit re-check bypasses the cache.
  await checkPackages(packages, { fetchImpl, cache, forceRefresh: true });
  assert.equal(callCount, 2);
});

test("checkPackages caps in-flight requests at the configured concurrency", async () => {
  const packages = Array.from({ length: 12 }, (_, i) => ({
    id: `pkg-${i}`,
    title: `Pkg ${i}`,
    manifestUrl: `https://example.com/pkg-${i}.json`,
    installedVersion: "1.0.0",
  }));
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return okResponse({ version: "1.0.0", compatibility: { verified: "13" } });
  };

  const results = await checkPackages(packages, {
    fetchImpl,
    cache: new Map(),
    concurrency: 3,
  });

  assert.equal(results.length, 12);
  assert.ok(maxActive <= 3, `maxActive was ${maxActive}, expected <= 3`);
});

test("cancellation stops consuming concurrency slots", async () => {
  const packages = Array.from({ length: 10 }, (_, i) => ({
    id: `pkg-${i}`,
    title: `Pkg ${i}`,
    manifestUrl: `https://example.com/pkg-${i}.json`,
    installedVersion: "1.0.0",
  }));
  const controller = new AbortController();
  let fetchCalls = 0;

  const fetchImpl = async (url, { signal } = {}) => {
    fetchCalls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(okResponse({ version: "1.0.0", compatibility: { verified: "13" } })),
        30
      );
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  const resultsPromise = checkPackages(packages, {
    fetchImpl,
    cache: new Map(),
    concurrency: 3,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 5);
  const results = await resultsPromise;

  assert.ok(
    fetchCalls < packages.length,
    `expected fewer than ${packages.length} fetches to start, got ${fetchCalls}`
  );
  assert.ok(
    results.length < packages.length,
    `expected fewer than ${packages.length} results, got ${results.length}`
  );
});

test("checkPackages holds the concurrency cap when every package falls back", async () => {
  // Governing: SPEC-0002 REQ "Concurrency and Caching Interaction" — a
  // package that falls back consumes its slot twice in sequence, never
  // twice concurrently, so the cap holds even under full-fallback load.
  const packages = Array.from({ length: 9 }, (_, i) => ({
    id: `pkg-${i}`,
    title: `Pkg ${i}`,
    manifestUrl: `https://github.com/owner/pkg-${i}/releases/latest/download/module.json`,
    installedVersion: "1.0.0",
  }));
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (url.includes("raw.githubusercontent.com")) {
      return okResponse({ version: "1.0.0", compatibility: { verified: "13" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const results = await checkPackages(packages, {
    fetchImpl,
    cache: new Map(),
    concurrency: 3,
  });

  assert.equal(results.length, 9);
  assert.ok(
    results.every((r) => r.status === "ok" && r.provenance === "fallback")
  );
  assert.ok(maxActive <= 3, `maxActive was ${maxActive}, expected <= 3`);
});

test("checkPackages forwards options.githubApiBudget through to fetchPackageManifest (release tag resolution works via checkPackages, not just directly)", async () => {
  // Governing: ADR-0003 Amendment 2 — checkPackages destructures a
  // hand-picked subset of `options` for the call into fetchPackageManifest
  // rather than spreading the whole object, so githubApiBudget must be
  // explicitly threaded through. This guards against that wiring regressing
  // silently.
  const packages = [
    {
      id: "budget-through-checkpackages",
      title: "Budget Through checkPackages",
      manifestUrl:
        "https://github.com/owner/budget-through-checkpackages/releases/latest/download/module.json",
      installedVersion: "1.0.0",
    },
  ];
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.includes("api.github.com") && url.includes("/releases/latest")) {
      return okResponse({ tag_name: "3.0.0" });
    }
    if (url === "https://raw.githubusercontent.com/owner/budget-through-checkpackages/3.0.0/module.json") {
      return okResponse({ version: "3.0.0", compatibility: { verified: "14" } });
    }
    throw new TypeError("Failed to fetch");
  };

  const results = await checkPackages(packages, {
    fetchImpl,
    cache: new Map(),
    githubApiBudget: { remaining: 5 },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].provenance, "release");
  assert.equal(results[0].latestVersion, "3.0.0");
  assert.ok(requestedUrls.some((url) => url.includes("api.github.com")));
});

test("cancellation stops a fallback attempt mid-flight without throwing or reporting a partial result", async () => {
  const packages = [
    {
      id: "gh-mod",
      title: "GH Mod",
      manifestUrl: "https://github.com/owner/gh-mod/releases/latest/download/module.json",
      installedVersion: "1.0.0",
    },
  ];
  const controller = new AbortController();
  let fallbackCalls = 0;

  const fetchImpl = async (url, { signal } = {}) => {
    if (url.includes("raw.githubusercontent.com")) {
      fallbackCalls++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(okResponse({ version: "1.0.0" })),
          30
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    // Declared attempt fails immediately, triggering the fallback.
    throw new TypeError("Failed to fetch");
  };

  const resultsPromise = checkPackages(packages, {
    fetchImpl,
    cache: new Map(),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 5);
  const results = await resultsPromise;

  assert.equal(fallbackCalls, 1, "the fallback attempt should have started");
  assert.equal(
    results.length,
    0,
    "an in-flight fallback aborted before resolving reports no partial result"
  );
});

// --- version comparison --------------------------------------------------

test("compareVersions / isNewerVersion basic cases", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(isNewerVersion("1.2.0", "1.1.9"));
  assert.ok(!isNewerVersion("1.1.0", "1.2.0"));
  assert.ok(isNewerVersion("13", "12"));
  assert.ok(isNewerVersion("13.331", "13.330"));
  assert.ok(!isNewerVersion("13.330", "13.330"));
});

// --- Foundry glue: getActivePackagesFromGame ------------------------------

test("getActivePackagesFromGame filters to active modules and includes the system", () => {
  const fakeGame = {
    modules: new Map([
      [
        "mod-a",
        {
          id: "mod-a",
          title: "Mod A",
          active: true,
          version: "1.0.0",
          manifest: "https://example.com/mod-a.json",
        },
      ],
      [
        "mod-b",
        {
          id: "mod-b",
          title: "Mod B",
          active: false,
          version: "1.0.0",
          manifest: "https://example.com/mod-b.json",
        },
      ],
    ]),
    system: {
      id: "dnd5e",
      title: "D&D 5E",
      version: "3.0.0",
      manifest: "https://example.com/dnd5e.json",
    },
  };

  const packages = getActivePackagesFromGame(fakeGame);

  assert.equal(packages.length, 2);
  assert.ok(packages.some((p) => p.id === "mod-a"));
  assert.ok(!packages.some((p) => p.id === "mod-b"));
  const system = packages.find((p) => p.id === "dnd5e");
  assert.ok(system);
  assert.equal(system.isSystem, true);
});

// Regression test for a bug found only by running in a real Foundry v13
// world: `game.modules` is a Foundry `Collection`, which extends Map but
// overrides Symbol.iterator to yield *values* instead of [key, value]
// entries. The plain `Map` used by the test above iterates entries, so a
// pair-destructuring implementation passed against the Map double while
// throwing "object is not iterable" against a real world. This double
// imitates Collection's actual iteration order-of-yield so that mismatch
// can't come back unnoticed.
class FakeCollection extends Map {
  *[Symbol.iterator]() {
    yield* this.values();
  }
}

test("getActivePackagesFromGame handles a Foundry Collection (yields values, not entries)", () => {
  const fakeGame = {
    modules: new FakeCollection([
      [
        "mod-a",
        {
          id: "mod-a",
          title: "Mod A",
          active: true,
          version: "1.0.0",
          manifest: "https://example.com/mod-a.json",
        },
      ],
      [
        "mod-b",
        {
          id: "mod-b",
          title: "Mod B",
          active: false,
          version: "1.0.0",
          manifest: "https://example.com/mod-b.json",
        },
      ],
    ]),
    system: {
      id: "sfrpg",
      title: "Starfinder",
      version: "0.30.1",
      manifest: "https://example.com/sfrpg.json",
    },
  };

  const packages = getActivePackagesFromGame(fakeGame);

  assert.equal(packages.length, 2);
  const modA = packages.find((p) => p.id === "mod-a");
  assert.ok(modA, "active module should be picked up from a Collection");
  assert.equal(modA.installedVersion, "1.0.0");
  assert.equal(modA.manifestUrl, "https://example.com/mod-a.json");
  assert.ok(!packages.some((p) => p.id === "mod-b"), "inactive module excluded");
  assert.equal(packages.find((p) => p.id === "sfrpg")?.isSystem, true);
});
