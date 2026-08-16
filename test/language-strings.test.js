// Guards CLAUDE.md project rule 1 (kindness to module developers) and
// SPEC-0001 REQ "Checker Table" (the exact five-item status taxonomy) at the
// localization-file level, since checker-table-logic.js itself only deals in
// label *keys*, not the English strings a GM actually sees.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Checker Table", CLAUDE.md project rule 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const strings = JSON.parse(readFileSync(path.join(here, "../languages/en.json"), "utf8"));

const FORBIDDEN_WORDS = ["dead", "broken", "abandoned"];

test("languages/en.json defines exactly the five permitted status labels, verbatim", () => {
  assert.equal(strings["THE-PLUGIN-PLUGIN.Status.UpToDate"], "Up to date & verified");
  assert.equal(strings["THE-PLUGIN-PLUGIN.Status.UpdateAvailable"], "Update available");
  assert.equal(
    strings["THE-PLUGIN-PLUGIN.Status.NotYetVerified"],
    "Not yet verified for current/target Foundry version"
  );
  assert.equal(strings["THE-PLUGIN-PLUGIN.Status.PossiblyUnmaintained"], "Possibly unmaintained");
  assert.equal(strings["THE-PLUGIN-PLUGIN.Status.CouldntCheck"], "Couldn't check");
});

test("languages/en.json never uses 'dead', 'broken', or 'abandoned' anywhere (CLAUDE.md project rule 1)", () => {
  for (const [key, value] of Object.entries(strings)) {
    if (typeof value !== "string") continue;
    const lower = value.toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      assert.ok(
        !lower.includes(word),
        `languages/en.json["${key}"] = "${value}" contains forbidden word "${word}"`
      );
    }
  }
});

test("languages/en.json includes a visible kindness reminder string", () => {
  const reminder = strings["THE-PLUGIN-PLUGIN.CheckerTable.KindnessReminder"];
  assert.ok(reminder && reminder.length > 0);
  assert.match(reminder.toLowerCase(), /volunteer/);
});

// ---------------------------------------------------------------------------
// Target version determination strings (issue #37, companion to issue #36).
// `scripts/checker-table.js`'s `#buildComparisonTargetContext` resolves
// every comparison-target note through exactly these four keys — see the
// mapping asserted (through the class's public rendering entry point) in
// test/checker-table.test.js. This section only covers what belongs at the
// localization-file level: that each key actually resolves to non-empty
// text, and that none of the four strings bypass the kindness rule by
// blaming a package for a target that couldn't be confirmed. The forbidden-
// word scan above already covers "dead"/"broken"/"abandoned" across the
// whole file, these four keys included — no need to repeat it here.
//
// Governing: ADR-0001 (amended 2026-08-15), SPEC-0001 REQ "Target Version
// Determination", SPEC-0001 REQ "Inferred Latest Version", CLAUDE.md
// project rule 1.

const TARGET_VERSION_KEYS = [
  "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedNewer",
  "THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedCurrent",
  "THE-PLUGIN-PLUGIN.CheckerTable.TargetInferred",
  "THE-PLUGIN-PLUGIN.CheckerTable.TargetNoEvidence",
];

test("languages/en.json resolves all four target-version keys to non-empty, distinct strings", () => {
  const values = TARGET_VERSION_KEYS.map((key) => strings[key]);
  for (const [index, value] of values.entries()) {
    assert.ok(
      typeof value === "string" && value.length > 0,
      `${TARGET_VERSION_KEYS[index]} must resolve to a non-empty string`
    );
  }
  // No two of the four states may share identical wording — the whole point
  // is that an inference reads differently from a confirmed fact, and
  // "newer available" reads differently from "already current" (SPEC-0001
  // REQ "Inferred Latest Version": "an inference is never presented as
  // fact").
  assert.equal(new Set(values).size, values.length);
});

test("the two 'confirmed' (authoritative) target strings both say Foundry itself confirms the version", () => {
  const newer = strings["THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedNewer"];
  const current = strings["THE-PLUGIN-PLUGIN.CheckerTable.TargetConfirmedCurrent"];
  assert.match(newer.toLowerCase(), /confirms?/);
  assert.match(current.toLowerCase(), /confirms?/);
});

test("the two 'inferred' target strings both flag the target as unconfirmed, never as fact", () => {
  const inferred = strings["THE-PLUGIN-PLUGIN.CheckerTable.TargetInferred"];
  const noEvidence = strings["THE-PLUGIN-PLUGIN.CheckerTable.TargetNoEvidence"];
  for (const value of [inferred, noEvidence]) {
    assert.match(
      value.toLowerCase(),
      /couldn't confirm|not confirmed|inferred/,
      `"${value}" should read as unconfirmed, not as a confirmed fact`
    );
  }
});

test("none of the four target-version strings imply a package is at fault for an unconfirmed target (CLAUDE.md project rule 1)", () => {
  // A target that couldn't be confirmed is Foundry's update service being
  // unreachable or silent — never a module/system developer's doing. None
  // of these four strings may frame it as a package's fault (e.g. blaming
  // "the module"/"the package"/"the developer", or fault-toned words like
  // "fail"/"failure"/"wrong"/"invalid").
  const blameWords = [
    "module's fault",
    "package's fault",
    "developer's fault",
    "failed to",
    "failure",
    "invalid",
    "wrong",
  ];
  for (const key of TARGET_VERSION_KEYS) {
    const value = strings[key];
    const lower = value.toLowerCase();
    for (const word of blameWords) {
      assert.ok(
        !lower.includes(word),
        `${key} = "${value}" reads as blaming a package ("${word}")`
      );
    }
  }
});
