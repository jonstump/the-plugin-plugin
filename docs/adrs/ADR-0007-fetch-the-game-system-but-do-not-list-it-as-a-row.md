---
status: accepted
date: 2026-08-15
decision-makers: Jon Stump
extends: [ADR-0001]
---

# ADR-0007: Fetch the active game system's manifest, but do not list it as a checker-table row

## Context and Problem Statement

SPEC-0001 REQ "Manifest Check" fetches the manifest for "every active
module and the active game system," and REQ "Checker Table" renders that
same set as table rows, each with its own status label. The active game
system (e.g. a world running `sfrpg`, displayed as "Starfinder First
Edition") therefore shows up as a full row — its own "Up to date &
verified" / "Update available" / etc. status, exactly like a module.

Investigating issue #58 live, this read as a stray or mistaken entry —
"why is Starfinder in the module list?" It isn't a mistake, but the
original intent was miscommunicated: including the system in the
fetched/checked set was never about telling a GM "your game system needs
updating," the way a module row does. It was about giving REQ "Inferred
Latest Version" (ADR-0001) one more data point: the system's own
`compatibility.verified` is one more piece of peer evidence toward "does a
newer Foundry generation exist," on the same terms as every module's. That
motivation is real and still holds on the peer-inference fallback path.

But displaying the system as its own row, with its own GM-facing status
label, was never load-bearing for that purpose — and reads as tracking the
system for update-availability the way a module is tracked, which isn't
what a GM would act on the same way.

## Decision Drivers

* Accuracy of intent — a UI element should mean what it visibly claims to
  mean; a system "row" with an "Up to date & verified" badge implies the
  module is tracking system updates as a first-class concern, which was
  never the design
* KISS (project rule 2) — the fetch-for-inference purpose needs the
  system's manifest data, not a rendered row; don't build UI the design
  never required
* ADR-0001's peer-inference signal still needs the system's
  `compatibility.verified` on the fallback path (when
  `game.data.coreUpdate` is unavailable) — this must not regress

## Considered Options

* Leave the system as a full row, unchanged
* Stop fetching the system's manifest entirely
* Keep fetching the system's manifest (feeding peer inference), stop
  rendering it as a checker-table row

## Decision Outcome

Chosen option: **keep fetching, stop rendering.**

`getActivePackagesFromGame` (`scripts/manifest-fetcher.js`) continues to
include the system in the fetched/classified set unchanged — its
`compatibility.verified` still participates in `computeInferredLatest`
(SPEC-0001 REQ "Inferred Latest Version") exactly as before. The checker
table's row-building step filters the system out before rendering, so it
never appears with its own status badge, link-out buttons, or pin control.

Dropping the fetch entirely (the second option) was rejected because it
would silently weaken peer inference on the fallback path — one fewer data
point toward "does a newer Foundry generation exist," for no benefit, in
exactly the scenario (no authoritative `coreUpdate`) where every data point
matters most.

### Consequences

* Good, because the checker table now shows exactly what a GM would expect
  to act on — modules — without a system row whose status was never
  meaningful to look at on its own.
* Good, because REQ "Inferred Latest Version" is completely unaffected —
  the system's `compatibility.verified` still feeds it.
* Neutral, because this is a display-layer change only; no manifest-fetch
  or classification logic changes.
* Bad, because a GM who wants to know their game system's own compatibility
  or update status (a legitimate question, just a different one than this
  ADR addresses) has no way to see it in this checker anymore. Not
  addressed here — Foundry's own setup-screen checklist already covers
  system updates; revisit if that gap proves to matter in practice.

### Confirmation

`scripts/checker-table.js`'s row-building step MUST filter out any package
result where `isSystem` is true before mapping to the rendered rows.
`compatibility-classifier.js` and `manifest-fetcher.js` MUST NOT change —
the system's data still flows through fetch and classification unchanged;
only the table's own row list is filtered.

## More Information

* [`ADR-0001`](ADR-0001-infer-newer-foundry-version-from-installed-packages.md)
  — the peer-inference use of the system's `compatibility.verified` this
  decision preserves.
* [`SPEC-0001`](../openspec/specs/compatibility-checker/spec.md) REQ
  "Checker Table" (revised: system excluded from rendered rows), REQ
  "Manifest Check" and REQ "Inferred Latest Version" (unchanged — the
  system is still fetched and still counted).
