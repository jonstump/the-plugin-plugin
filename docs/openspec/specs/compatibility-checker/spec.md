---
status: approved
date: 2026-08-15
implements: [ADR-0001, ADR-0002]
---

# SPEC-0001: Compatibility Checker

## Overview

The Plugin Plugin's core v1 capability: an in-world, GM-only checker that
reports update availability and Foundry-version compatibility for every
active module and the game system, using only data already published in
each package's own manifest — no server component, no crowdsourced data,
no credentials. See ADR-0001 (how a likely-newer Foundry version is
inferred without contacting foundryvtt.com) and ADR-0002 (how that
inference is turned into severity without over-alarming on ordinary
manifest staleness).

## Requirements

### Requirement: Manifest Check

The system SHALL fetch the remote `manifest` for every active module and
the active game system, and compare the fetched manifest's fields against
the package's locally installed data.

- The system MUST compare the installed `version` against the fetched
  manifest's `version` to determine update availability.
- The system MUST compare the fetched manifest's `compatibility.verified`
  against the currently running Foundry version (`game.release`).
- The system MUST fall back to the legacy `compatibleCoreVersion` field
  when `compatibility` is absent from the fetched manifest.
- The system MUST NOT treat a fetch failure for one package as blocking
  the check for any other package.

#### Scenario: Update is available

- **WHEN** a package's fetched manifest `version` is newer than the
  installed `version`
- **THEN** the system records that package as having an update available

#### Scenario: Manifest fetch fails for one package

- **WHEN** a manifest fetch fails for a given package (CORS-blocked host,
  dead URL, network error, non-200 response, or malformed JSON)
- **THEN** the system records that package's status as "Couldn't check"
  and continues checking every other active package without throwing an
  error or halting the scan

#### Scenario: Legacy compatibility field

- **WHEN** a fetched manifest has no `compatibility` object but has a
  `compatibleCoreVersion` string
- **THEN** the system uses `compatibleCoreVersion` in place of
  `compatibility.verified` for every comparison in this spec

### Requirement: Inferred Latest Version

The system SHALL compute `inferredLatest`, a stand-in for "a newer Foundry
generation likely exists," as the highest `compatibility.verified` value
observed across the fetched manifests of every active package and the
active game system (per ADR-0001). The system MUST NOT contact
foundryvtt.com, or any third-party service, to determine the latest
Foundry version.

- The system MUST compare each package's own `compatibility.verified`
  against both `game.release` and `inferredLatest`.
- The system MUST treat `inferredLatest` as advisory, not authoritative:
  when no installed package's manifest declares a `compatibility.verified`
  higher than `game.release`, the system MUST report no evidence of a
  newer Foundry generation rather than asserting the running version is
  the latest one that exists.

#### Scenario: Peer signal exists

- **WHEN** at least one active package's fetched manifest declares
  `compatibility.verified` higher than `game.release`
- **THEN** `inferredLatest` is set to the highest such value, and every
  other package's `compatibility.verified` is compared against it in
  addition to `game.release`

#### Scenario: No peer signal

- **WHEN** no active package's fetched manifest declares
  `compatibility.verified` higher than `game.release`
- **THEN** the system reports no evidence of a newer Foundry generation
  and does not display an inferred-target-version comparison for any
  package

### Requirement: Compatibility Severity Classification

The system SHALL classify each package's compatibility status into a hard
or soft severity tier based on `compatibility.maximum`, per ADR-0002. The
system MUST NOT treat a bare `compatibility.verified` lag, on its own, as
equivalent evidence to a declared `compatibility.maximum` ceiling.

- **Hard severity**: the system MUST classify a package as hard-severity
  when its fetched manifest declares `compatibility.maximum` and that
  value is below the comparison target (`game.release` or
  `inferredLatest`).
- **Soft severity**: the system MUST classify a package as soft-severity
  when its `compatibility.verified` trails the comparison target but
  `compatibility.maximum` is absent or still at or above the comparison
  target.
- Only hard-severity packages and packages flagged by the "possibly
  unmaintained" heuristic MUST count toward the login notification's
  "problem" summary and MAY trigger the pinned-module warning toast (see
  Requirement: Login Notification). Soft-severity packages MUST NOT.

#### Scenario: Declared hard ceiling below target

- **WHEN** a package's fetched manifest declares `compatibility.maximum`
  and that value is below the comparison target
- **THEN** the system classifies the package as hard-severity

#### Scenario: Verified lag with no declared ceiling

- **WHEN** a package's `compatibility.verified` trails the comparison
  target but its fetched manifest has no `compatibility.maximum`, or
  `compatibility.maximum` is at or above the comparison target
- **THEN** the system classifies the package as soft-severity and does not
  count it toward the login notification's problem summary

### Requirement: Checker Table

The system SHALL provide a GM-only ApplicationV2 window listing every
active package with its title, installed version, latest published
version, verified core version, and status.

- The system MUST use the following status labels, and MUST NOT use
  language implying a package is "dead", "broken", or "abandoned":
  - Up to date & verified
  - Update available
  - Not yet verified for current/target Foundry version
  - Possibly unmaintained
  - Couldn't check
- Each row MUST provide link-out buttons for: project page (manifest
  `url`), report issue (manifest `bugs`, falling back to `<url>/issues`
  when `url` is a GitHub repository URL), and changelog (manifest
  `changelog`), each shown only when the corresponding manifest field is
  present.
- The window MUST be visible only to users with the GM role.
- The window MUST display a visible reminder that package developers are
  volunteers and that a lagging or unverified status does not mean a
  package will never be updated.

#### Scenario: Non-GM user

- **WHEN** a non-GM user attempts to open the checker window
- **THEN** the system does not render the window for that user

#### Scenario: Missing link-out field

- **WHEN** a package's fetched manifest has no `bugs` field and its `url`
  is not a GitHub repository URL
- **THEN** the system omits the "report issue" link-out button for that
  row rather than rendering a broken link

### Requirement: Possibly Unmaintained Heuristic

The system SHALL flag a package as "possibly unmaintained" only when BOTH
of the following hold, and MUST NOT use this label, or any harsher one,
based on either condition alone:

- The package is already failing the verified-compatibility check (its
  `compatibility.verified` verifies neither `game.release` nor
  `inferredLatest`), AND
- Across checks, the package's fetched manifest `version` has not changed,
  OR the package's GitHub repository is archived (queried via the
  unauthenticated GitHub API `archived` field, subject to rate limits).

The system MUST treat a GitHub API failure for this check as "unknown"
rather than as evidence toward or against the heuristic, and MUST only
query the GitHub API for packages already failing the verified check.

#### Scenario: Both signals present

- **WHEN** a package fails the verified-compatibility check and its
  GitHub repository is archived
- **THEN** the system classifies the package as "possibly unmaintained"

#### Scenario: Only one signal present

- **WHEN** a package fails the verified-compatibility check but its
  version has changed across checks and its repository is not archived
  (or is not hosted on GitHub)
- **THEN** the system does not classify the package as "possibly
  unmaintained"

#### Scenario: GitHub API failure

- **WHEN** the GitHub API request for a package's `archived` field fails
  or is rate-limited
- **THEN** the system treats that signal as "unknown" and does not
  classify the package as "possibly unmaintained" on that basis alone

### Requirement: Pinned Critical Modules

The system SHALL let a GM toggle a pin/star on any row, persisted as a set
of module IDs in a world-scoped setting.

- Pinned modules MUST escalate notification severity relative to
  unpinned modules with the same underlying status (see Requirement:
  Login Notification).
- The system MUST NOT expand transitive `relationships.requires`
  dependencies for pinned or any other modules in this spec's scope.

#### Scenario: Pin a module

- **WHEN** a GM toggles the pin control for a module
- **THEN** the system adds that module's ID to the world-scoped pinned-set
  setting, and the pin persists across sessions

### Requirement: Login Notification

The system SHALL notify GMs on `ready` with a summary of checker results.

- The system MUST post a whispered chat message to GMs summarizing
  results, with buttons or links to open the checker window. The message
  MUST persist in the chat log.
- The system MUST additionally show a `ui.notifications.warn` toast only
  when a pinned module has a hard-severity status (per Requirement:
  Compatibility Severity Classification) or is flagged "possibly
  unmaintained." The system MUST NOT show the toast for a pinned module
  whose only issue is soft-severity.
- The system MUST provide a frequency setting with values "every login,"
  "daily," and "only when results changed," defaulting to "only when
  results changed." The system MUST determine "changed" by comparing a
  hash of the current results against a hash stored in a world setting.

#### Scenario: Pinned module with hard-severity status

- **WHEN** a pinned module has a hard-severity compatibility status
- **THEN** the system shows both the whispered chat summary and the
  `ui.notifications.warn` toast

#### Scenario: Pinned module with only soft-severity status

- **WHEN** a pinned module's only issue is a soft-severity compatibility
  status
- **THEN** the system shows the whispered chat summary but does not show
  the `ui.notifications.warn` toast

#### Scenario: Results unchanged since last login

- **WHEN** the frequency setting is "only when results changed" and the
  current results hash matches the stored hash from the last check
- **THEN** the system does not post a new chat summary or toast

### Requirement: Copy Report Button

The system SHALL provide a per-row button that copies a pre-formatted
plain-text bug-report snippet to the clipboard, containing: the package's
ID and installed version, the running Foundry version and build number,
the active game system and its version, and the browser user agent.

#### Scenario: Copy report

- **WHEN** a GM clicks the copy-report button for a package row
- **THEN** the system writes the formatted snippet to the clipboard and
  the snippet includes all five required fields

### Requirement: Error Handling Standards

All manifest-fetching and external-API operations (package manifest
fetches, GitHub API queries for the unmaintained heuristic) MUST follow
structured error handling:

- Errors MUST be caught per-package and MUST NOT propagate uncaught out of
  the overall scan.
- Each caught error MUST be attributed to the specific package it occurred
  for, so the "Couldn't check" status and any logged diagnostic both
  identify which package failed and why.
- Errors MUST NOT be silently discarded without at least a per-package
  status update — a failed fetch always results in a visible "Couldn't
  check" status, never a row that silently never resolves.

#### Scenario: Fetch error is attributable

- **WHEN** a manifest fetch throws or rejects for a given package
- **THEN** the resulting "Couldn't check" status is attributable to that
  specific package, and no other package's status is affected

### Requirement: Fetch Concurrency and Caching

Manifest and GitHub API fetches MUST be concurrency-limited and cached for
the session.

- The system MUST cap the number of in-flight manifest/API requests at any
  time rather than issuing one unbounded fetch per package simultaneously.
- The system MUST cache fetch results for the duration of the session and
  MUST NOT re-fetch a package's manifest or GitHub `archived` status
  more than once per session unless the GM explicitly triggers a re-check.
- The system MUST support cancellation of in-flight fetches (e.g., on
  window close) so an abandoned check does not continue consuming
  concurrency slots needed by a subsequent check.

#### Scenario: Concurrency cap respected

- **WHEN** the checker begins a scan of more active packages than the
  configured concurrency limit
- **THEN** the system never has more in-flight fetch requests than the
  configured limit at any point during the scan

#### Scenario: Re-check within the same session

- **WHEN** a GM reopens the checker window within the same session without
  explicitly requesting a re-check
- **THEN** the system displays cached results without re-fetching any
  manifest or GitHub API data

## Accessibility Requirements

This spec involves user-facing UI (the ApplicationV2 checker window). The
following accessibility requirements are MANDATORY per WCAG 2.1 AA.

### WCAG 2.1 AA Compliance

The checker window and all its interactive elements MUST meet WCAG 2.1
Level AA conformance as the minimum accessibility target.

### ARIA Landmarks

The checker window's structure MUST include ARIA landmark roles:
- `role="main"` on the results table region
- `role="navigation"` on any filter/sort control bar, if present

### Icon-Only Controls

The pin/star toggle, the copy-report button, and every link-out icon
(project page, report issue, changelog) are icon-only controls and MUST
each include an `aria-label` describing their specific action (e.g.,
"Pin lib-wrapper as a critical module," not a generic "Pin").

### Dynamic Content Regions

The status column and any in-progress scan indicator MUST use `aria-live`
regions:
- `aria-live="polite"` for status updates as individual package checks
  resolve
- `aria-live="assertive"` is not required for this window, since no status
  in this spec constitutes a critical, immediate-attention alert on its
  own — hard-severity and "possibly unmaintained" flags are surfaced via
  the login notification's toast (see Requirement: Login Notification),
  which uses Foundry's own `ui.notifications.warn` and inherits its
  accessibility behavior.

### Keyboard Navigation

All interactive elements in the checker window (pin toggles, copy-report
buttons, link-out buttons, frequency setting control) MUST be operable via
keyboard, with a logical tab order following the table's visual row order.

### Focus Management

The checker window, as an ApplicationV2 dialog, MUST return focus to the
element that opened it (chat message link, or module management button)
when closed.
