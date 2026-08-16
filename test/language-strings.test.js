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

// --- Requirement: Result Provenance (SPEC-0002) -----------------------------

test("languages/en.json defines the fallback-provenance note string, non-empty", () => {
  const note = strings["THE-PLUGIN-PLUGIN.CheckerTable.ProvenanceFallbackNote"];
  assert.ok(note && note.length > 0);
});

test("the fallback-provenance note never claims fallback data is the latest published/released version (SPEC-0002 REQ \"Result Provenance\")", () => {
  const note = strings["THE-PLUGIN-PLUGIN.CheckerTable.ProvenanceFallbackNote"].toLowerCase();
  assert.ok(!note.includes("latest published"));
  assert.ok(!note.includes("latest release"));
  assert.ok(!/\breleased\b/.test(note));
});

test("the fallback-provenance note carries no blame language (behind/neglected/at fault) — CLAUDE.md project rule 1", () => {
  const note = strings["THE-PLUGIN-PLUGIN.CheckerTable.ProvenanceFallbackNote"].toLowerCase();
  // Word-boundary match, not a bare substring check — "default" (as in
  // "default branch", the correct/expected term here) legitimately contains
  // the substring "fault", so a plain .includes("fault") would false-positive.
  for (const word of ["behind", "neglect", "fault", "outdated", "stale"]) {
    const re = new RegExp(`\\b${word}`);
    assert.ok(!re.test(note), `provenance note contains blame-adjacent word "${word}"`);
  }
});
