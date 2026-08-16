---
status: approved
date: 2026-08-15
implements: [ADR-0001, ADR-0002, ADR-0004]
---

# SPEC-0001: Compatibility Checker

## Overview

The Plugin Plugin's core v1 capability: an in-world, GM-only checker that
reports update availability and Foundry-version compatibility for every
active module and the game system — no server component, no crowdsourced
data, no credentials.

The comparison target comes from `game.data.coreUpdate`, which Foundry's
own server populates in-world, with peer inference across installed
manifests as the fallback (ADR-0001, amended 2026-08-15). Everything else
is read from each package's own published manifest. See ADR-0002 (how a
version gap becomes severity without over-alarming on ordinary manifest
staleness) and ADR-0004 (how "possibly unmaintained" is evidenced by
repository activity rather than by repeated observation).

**Terminology.** "Comparison target" denotes whichever value is actually
in force for a given check — authoritative (from `game.data.coreUpdate`)
or peer-inferred — and is what REQ "Target Version Determination"
produces. `inferredLatest` denotes specifically the peer-inferred value
computed by REQ "Inferred Latest Version"; it is the comparison target
only on the fallback path, when no authoritative target is available. The
two are not interchangeable: a requirement that names `inferredLatest`
means the peer-inference computation specifically, not "the comparison
target" generally.

"Pinned" and "starred" denote the same thing, deliberately. This spec,
its `design.md`, and every internal identifier say **pinned** — the
`pinnedCriticalModules` world setting, `PINNED_MODULES_SETTING_KEY`,
`readPinnedModuleIds`, the `the-plugin-plugin-pinned-list` CSS class.
All GM-facing text says **starred**, because the control the GM actually
sees is a star icon; naming it "pin" described a control that was not on
screen, which mattered most for the screen-reader label. The identifiers
were left alone because the setting key names persisted world data, and
migrating a GM's stored set for a cosmetic gain is the kind of churn
CLAUDE.md project rule 2 exists to refuse. A requirement that says
"pinned module" therefore governs the feature the UI calls "starred" —
this is a naming split, not two concepts.

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

### Requirement: Target Version Determination

The system SHALL determine the comparison target — the Foundry version a
package's `compatibility.verified` is measured against, beyond the running
`game.release` — from `game.data.coreUpdate`, which the Foundry server
populates in-world (per ADR-0001 as amended 2026-08-15). The system MUST
fall back to the peer inference in REQ "Inferred Latest Version" only when
that source is unavailable.

- The system MUST use `game.data.coreUpdate.version` as the target version
  when `game.data.coreUpdate.couldReachWebsite` is `true` and `version` is
  present.
- The system MUST determine whether that target is newer by comparing
  `coreUpdate.version` against `game.release.version` directly. The system
  MUST NOT gate this on `coreUpdate.hasUpdate`, which is scoped to the
  running generation and reports `false` even when a newer generation
  exists.
- The system MUST treat `couldReachWebsite: false`, or an absent
  `coreUpdate` payload, as "unknown" — not as evidence that the running
  version is current — and MUST fall back to REQ "Inferred Latest Version".
- Reading `game.data.coreUpdate` MUST NOT involve any network request by
  this module.

#### Scenario: Authoritative target available

- **WHEN** `game.data.coreUpdate.couldReachWebsite` is `true` and
  `coreUpdate.version` is newer than `game.release.version`
- **THEN** the system uses `coreUpdate.version` as the comparison target
  and does not compute a peer-inferred target

#### Scenario: Newer generation while `hasUpdate` is false

- **WHEN** `coreUpdate.version` is newer than `game.release.version` but
  `coreUpdate.hasUpdate` is `false`
- **THEN** the system still treats `coreUpdate.version` as the target,
  because `hasUpdate` describes only the running generation

#### Scenario: Foundry could not reach its update service

- **WHEN** `game.data.coreUpdate.couldReachWebsite` is `false`, or the
  `coreUpdate` payload is absent
- **THEN** the system falls back to REQ "Inferred Latest Version" and MUST
  NOT report that the running version is current

### Requirement: Inferred Latest Version

When no authoritative target is available (see REQ "Target Version
Determination"), the system SHALL compute `inferredLatest`, a stand-in for
"a newer Foundry generation likely exists," as the highest
`compatibility.verified` value observed across the fetched manifests of
every active package and the active game system (per ADR-0001). The system
MUST NOT contact foundryvtt.com, or any third-party service, to determine
the latest Foundry version.

- The system MUST compare each package's own `compatibility.verified`
  against both `game.release` and the active comparison target.
- The system MUST treat `inferredLatest` as advisory, not authoritative:
  when no installed package's manifest declares a `compatibility.verified`
  higher than `game.release`, the system MUST report no evidence of a
  newer Foundry generation rather than asserting the running version is
  the latest one that exists.
- The system MUST distinguish an authoritative target from an inferred one
  wherever the target version is surfaced to the GM, so an inference is
  never presented as fact.

#### Scenario: Inferred target is labelled as inference

- **WHEN** the comparison target came from peer inference rather than
  `game.data.coreUpdate`
- **THEN** the GM-facing presentation identifies it as inferred rather than
  as the confirmed latest Foundry version

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
  value is below the comparison target — `game.release`, or the active
  comparison target from REQ "Target Version Determination" (authoritative
  when available, `inferredLatest` on the fallback path).
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
active **module** with its title, installed version, latest published
version, verified core version, and status.

- The active game system MUST NOT be rendered as a row in this window,
  per ADR-0007. Its manifest is still fetched (REQ "Manifest Check") and
  its `compatibility.verified` still participates in peer inference (REQ
  "Inferred Latest Version") — only the checker table's rendered row list
  excludes it. Including it as a full row with its own GM-facing status
  label implied the module was tracking system updates as a first-class
  concern, which was never the design; the system's data was only ever
  needed as one more peer-inference signal.
- The system MUST use the following status labels, and MUST NOT use
  language implying a package is "dead", "broken", or "abandoned":
  - Up to date & verified
  - Update available
  - Not yet verified for current/target Foundry version
  - Possibly unmaintained
  - Verified, update unknown
  - Couldn't check
- The system MUST classify a package as "Verified, update unknown" (per
  ADR-0006) when its compatibility passes with no hard or soft severity and
  it is not flagged "possibly unmaintained," but update availability itself
  is unknown (`updateAvailable` is neither `true` nor `false`) — most
  commonly a fallback-sourced result, per SPEC-0002 REQ "Fallback Field
  Trust". The system MUST NOT use "Couldn't check" for this case: that
  label is reserved for a package with no reliable data at all, and using
  it here would misrepresent a package with valid, fully-trusted
  compatibility data as one this module failed to check at all.
- Each row MUST provide link-out buttons for: project page (manifest
  `url`), report issue (manifest `bugs`, falling back to `<url>/issues`
  when `url` is a GitHub repository URL), and changelog (manifest
  `changelog`), each shown only when the corresponding manifest field is
  present.
- Each link-out field is resolved by preferring the *remote* manifest (the
  package's own declared `manifest` URL, freshly fetched) and falling back,
  per field, to the same field on the package's *locally-installed*
  manifest (parsed by Foundry from `module.json`/`system.json` at world-load
  time — no network call). This applies whether the remote fetch failed
  outright (status "Couldn't check") or merely omitted that one field. A
  package is not required to have a reachable remote manifest to get
  link-out buttons; it only needs the field to be declared *somewhere* the
  system already has it.
- The window MUST be visible only to users with the GM role.
- The window MUST display a visible reminder that package developers are
  volunteers and that a lagging or unverified status does not mean a
  package will never be updated.

#### Scenario: Non-GM user

- **WHEN** a non-GM user attempts to open the checker window
- **THEN** the system does not render the window for that user

#### Scenario: Missing link-out field

- **WHEN** a package's fetched manifest has no `bugs` field and its `url`
  is not a GitHub repository URL, and the locally-installed manifest has no
  `bugs` field either
- **THEN** the system omits the "report issue" link-out button for that
  row rather than rendering a broken link

#### Scenario: Remote manifest unreachable, installed manifest still provides link-out fields

- **WHEN** a package's remote manifest fetch fails entirely (status
  "Couldn't check" — e.g. a GitLab CI-artifact-hosted manifest with no
  CORS-open fallback) but the package's locally-installed manifest declares
  `url`
- **THEN** the row still renders the project-page link-out button, sourced
  from the installed manifest, even though its status is "Couldn't check"

#### Scenario: Remote manifest present but incomplete

- **WHEN** a package's fetched manifest declares `url` but not `changelog`,
  and the locally-installed manifest declares `changelog`
- **THEN** the row renders both the project-page link (from the fetched
  manifest) and the changelog link (from the installed manifest) — the two
  fields are resolved independently, not as a single fetched-or-installed
  choice for the whole package

#### Scenario: Game system is not rendered as a row

- **WHEN** the checker table renders its rows
- **THEN** no row corresponds to the active game system, regardless of its
  own compatibility status — its manifest was still fetched and its
  `compatibility.verified` still participated in peer inference

#### Scenario: Verified compatibility with unknown update availability

- **WHEN** a package's compatibility passes with no severity issue and it
  is not "possibly unmaintained," but its `updateAvailable` is unknown
- **THEN** the system classifies the package as "Verified, update unknown,"
  never as "Couldn't check" or "Up to date & verified"

### Requirement: Possibly Unmaintained Heuristic

The system SHALL flag a package as "possibly unmaintained" only when BOTH
of the following hold, and MUST NOT use this label, or any harsher one,
based on either condition alone:

- The package is already failing the verified-compatibility check (its
  `compatibility.verified` verifies neither `game.release` nor the active
  comparison target), AND
- The package's GitHub repository is archived, OR that repository has had
  no pushed activity for at least 12 months (per ADR-0004).

Both signals are read from a single unauthenticated
`GET /repos/{owner}/{repo}` request — the same request, not two. The system
MUST NOT issue an additional request to obtain activity age.

- The system MUST derive activity age from the repository's `pushed_at`
  field. The system MUST NOT use `updated_at`, which advances on metadata
  changes such as stars or description edits and therefore does not
  indicate maintenance.
- The system MUST NOT use elapsed time between checks, or any other value
  that varies with when or how often a GM ran a check, as evidence toward
  this flag.
- The system MUST treat a GitHub API failure, or a package not hosted on
  GitHub, as "unknown" — evidence toward neither side.
- The system MUST only query the GitHub API for packages already failing
  the verified check.

#### Scenario: Archived repository

- **WHEN** a package fails the verified-compatibility check and its
  GitHub repository is archived
- **THEN** the system classifies the package as "possibly unmaintained"

#### Scenario: Dormant repository

- **WHEN** a package fails the verified-compatibility check and its
  repository's `pushed_at` is at least 12 months old
- **THEN** the system classifies the package as "possibly unmaintained"

#### Scenario: Recently active repository

- **WHEN** a package fails the verified-compatibility check but its
  repository was pushed to within the last 12 months and is not archived
- **THEN** the system does not classify the package as "possibly
  unmaintained", however many times it has been checked

#### Scenario: Repeated checks in quick succession

- **WHEN** the checker runs twice within one session against a
  recently-active, non-archived package that fails the verified check
- **THEN** the second check produces the same result as the first, and
  neither classifies the package as "possibly unmaintained"

#### Scenario: GitHub API failure

- **WHEN** the GitHub API request for a package's repository data fails
  or is rate-limited
- **THEN** the system treats both the archived and activity-age signals as
  "unknown" and does not classify the package as "possibly unmaintained"
  on that basis alone

#### Scenario: Package not hosted on GitHub

- **WHEN** a package fails the verified-compatibility check but its
  declared URLs do not identify a GitHub repository
- **THEN** the system treats both signals as "unknown" and does not
  classify the package as "possibly unmaintained"

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

The chat summary's **content** is further constrained as follows. Its job
is to let a GM decide whether anything needs their attention without
opening the checker, and to tell them what upgrade the results are measured
against.

- The chat summary MUST present its per-status counts as a structured list
  rather than a single prose sentence.
- The chat summary MUST state the running Foundry version and the active
  comparison target, and MUST identify whether that target is authoritative
  or inferred (see REQ "Target Version Determination"). When no target
  beyond the running version is available, it MUST say so rather than
  omitting the line.
- The chat summary MUST name each **pinned** module whose status is not
  "Up to date & verified", together with that module's status. Pinned
  modules with a clean status MUST NOT be named. When no module is pinned,
  the summary MUST omit this section entirely rather than rendering an
  empty one.
- Naming a pinned module in that section MUST NOT change any count in the
  per-status list, and MUST NOT affect toast gating. In particular a
  soft-severity pinned module MAY be named there while still being excluded
  from the "problem" figures and from the toast, per REQ "Compatibility
  Severity Classification".
- The chat summary is NOT required to repeat the volunteer reminder that
  REQ "Checker Table" mandates for the checker window. The reminder belongs
  where a GM acts on the information; repeating it on every login dilutes
  it. Every other constraint of CLAUDE.md project rule 1 continues to bind
  the notification — in particular, no wording may imply a package is dead,
  broken, or abandoned, or that a developer is at fault.

#### Scenario: Per-status counts are itemised

- **WHEN** the system posts a chat summary
- **THEN** the per-status counts appear as a structured list rather than as
  one prose sentence

#### Scenario: Version context with an authoritative target

- **WHEN** the comparison target came from `game.data.coreUpdate`
- **THEN** the chat summary states the running Foundry version and that
  target, identified as confirmed rather than inferred

#### Scenario: Version context with no target beyond the running version

- **WHEN** no authoritative target is available and peer inference yields
  no signal
- **THEN** the chat summary says no newer Foundry version is evidenced,
  rather than omitting the version line

#### Scenario: Pinned module needing attention is named

- **WHEN** a pinned module's status is not "Up to date & verified"
- **THEN** the chat summary names that module and its status

#### Scenario: Pinned module that is clean

- **WHEN** every pinned module's status is "Up to date & verified"
- **THEN** the chat summary names no pinned modules

#### Scenario: Soft-severity pinned module is named but not escalated

- **WHEN** a pinned module's only issue is soft-severity
- **THEN** the chat summary names it, the "problem" counts exclude it, and
  no `ui.notifications.warn` toast is shown

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
