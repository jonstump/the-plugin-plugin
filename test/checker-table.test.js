// Tests for the GM-only visibility gate in scripts/checker-table.js's
// `openCheckerTable` entry point (SPEC-0001 "Non-GM user" scenario: "the
// system does not render the window for that user"). Everything else in
// this file (status/pin/link/copy-report logic) is already covered by
// test/checker-table-logic.test.js from issue #8's own PR — this file adds
// only the one thing that wasn't yet tested: the GM gate itself.
//
// scripts/checker-table.js destructures `foundry.applications.api` at
// module scope (so `CheckerTableApp` can `extends
// HandlebarsApplicationMixin(ApplicationV2)`), which would throw at import
// time under Node without a `foundry` global. A minimal stand-in is
// installed on `globalThis.foundry` below, before a dynamic `import()` (a
// static top-of-file import would run before this test file's own code
// does, too late to install the stub). `openCheckerTable` gates on
// `game.user.isGM` before ever constructing `CheckerTableApp`, so the stub
// only needs to be import-safe, not functionally complete — none of these
// tests exercise a constructed instance.
//
// Run with: npm test  (== node --test test/)
//
// Governing: SPEC-0001 REQ "Checker Table"

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

const { openCheckerTable } = await import("../scripts/checker-table.js");

test("openCheckerTable: resolves to null for a non-GM user", async () => {
  globalThis.game = { user: { isGM: false } };
  try {
    const result = await openCheckerTable();
    assert.equal(result, null);
  } finally {
    delete globalThis.game;
  }
});

test("openCheckerTable: resolves to null and does not throw when game.user is missing", async () => {
  globalThis.game = {};
  try {
    await assert.doesNotReject(() => openCheckerTable());
    assert.equal(await openCheckerTable(), null);
  } finally {
    delete globalThis.game;
  }
});

test("openCheckerTable: resolves to null and does not throw when game itself is missing", async () => {
  delete globalThis.game;
  await assert.doesNotReject(() => openCheckerTable());
  assert.equal(await openCheckerTable(), null);
});
