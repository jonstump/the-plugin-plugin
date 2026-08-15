// Unit tests for the pure/dependency-injectable logic in
// scripts/manifest-fetcher.js. No Foundry `game` global required.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Manifest Check", SPEC-0001 REQ "Error Handling
// Standards", SPEC-0001 REQ "Fetch Concurrency and Caching"

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runWithConcurrency,
  fetchPackageManifest,
  checkPackages,
  compareVersions,
  isNewerVersion,
  getActivePackagesFromGame,
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
