---
status: accepted
date: 2026-08-15
decision-makers: Jon Stump
extends: [ADR-0003]
---

# ADR-0006: Add a sixth checker-table status for "verified, update unknown"

## Context and Problem Statement

Issue #48 (SPEC-0002 REQ "Fallback Field Trust") fixed a real bug: a
fallback-sourced package's committed `version` field is frequently a stale
release-tooling placeholder, so deriving "up to date" from it produced a
false negative — a GM told they were current while three major versions
behind. The fix correctly makes `updateAvailable` unknown (`null`) for
every fallback-sourced result.

Constrained by an unreviewed assumption that the fix must reuse one of
CLAUDE.md's five existing status labels, that PR mapped
`updateAvailable === null` (with no severity issue and not possibly
unmaintained) to **"Couldn't check"**.

In practice this collapses far more of the checker table than intended.
Per ADR-0003's own real-world measurement, fallback resolution is the
*common* case, not the exception: of 7 packages tested, only 1 resolved via
its declared manifest URL, 3 more resolved only via the fallback, and 3
failed entirely. Before this ADR, those 3 fallback-resolved packages showed
their real, fully-trusted compatibility status. After #48, they collapse
into "Couldn't check" too — indistinguishable from the 3 that returned no
data at all — even though `compatibility.verified`, severity, and links are
all still known and correct for them. A checker table that reads mostly
"Couldn't check" misrepresents how much the module actually knows, which is
its own kind of inaccuracy project rule 1 exists to prevent.

## Decision Drivers

* Kindness / accuracy (project rule 1) — the checker's entire value is
  telling a GM what it actually knows; conflating "no data at all" with
  "compatibility is fine, only the update number is unknown" hides real,
  correct information behind a falsely alarming label
* SPEC-0002 REQ "Fallback Field Trust" only requires that unknown update
  availability not be presented as "up to date" — it does not require
  reusing an existing label; that constraint was an unreviewed assumption
  in issue #48, not a spec requirement
* KISS — prefer a plain sixth label over a new per-row UI affordance
  (tooltip, conditional styling) to express a state text already covers
  directly

## Considered Options

* Keep mapping to "Couldn't check" (status quo from #48) — accurate in the
  narrowest sense but conflates total fetch failure with partial
  fallback success, which is the bug this ADR exists to fix
* Revert to "Up to date & verified" (pre-#48 behavior) — rejected, this is
  exactly the false-negative issue #48 was filed to close
* Add a sixth status label naming the actual state directly
* Keep five labels, add a per-row caveat/tooltip conditioned on provenance
  without changing the status text itself

## Decision Outcome

Chosen option: **add a sixth status, "Verified, update unknown."** Applies
precisely when `compatibility.verified` passes (no hard/soft severity) and
the package is not possibly unmaintained, but `updateAvailable` is `null`.
Precedence is otherwise unchanged — possibly-unmaintained and severity
still take priority over this, matching every other status in the
taxonomy.

The tooltip-only option was rejected as more UI surface for less clarity
than a plain-language label already used elsewhere in the same taxonomy;
the provenance badge (issue #32/#48) already explains *why* data is
uncertain (fallback-sourced), and stays unchanged — this status explains
*what that means for the row's confidence*, a distinct piece of
information.

This revises CLAUDE.md's "Core v1 scope" status list from five items to
six, and SPEC-0001 REQ "Checker Table" accordingly. SPEC-0002 REQ
"Fallback Field Trust" itself needs no change — it already only forbids
presenting unknown availability as "up to date," which the new label
satisfies exactly as well as "Couldn't check" did, without the collapse.

### Consequences

* Good, because it distinguishes real fetch failure from partial fallback
  success, restoring the information #48's fix accidentally discarded.
* Good, because it's a small, additive change: one label, one i18n string,
  one precedence branch, no new UI affordance.
* Bad, because CLAUDE.md's "exactly five statuses" framing is no longer
  accurate — revised here deliberately, not silently, so future readers
  don't wonder whether the taxonomy drifted from spec.

### Confirmation

`deriveStatusLabelKey`'s precedence order and its unit tests should show
exactly six terminal states, with "Verified, update unknown" reachable only
when severity is null, `possiblyUnmaintained` is false, and
`updateAvailable === null`.

## More Information

* [`ADR-0003`](ADR-0003-raw-github-fallback-for-cors-blocked-manifests.md) —
  the fallback mechanism whose real-world resolution-rate data motivates
  this decision.
* [`CLAUDE.md`](../../CLAUDE.md) § "Core v1 scope" — status taxonomy,
  revised from five to six labels by this ADR.
* Issue #48 — the fix this ADR corrects the follow-on effect of, not the
  fix itself, which remains correct.
