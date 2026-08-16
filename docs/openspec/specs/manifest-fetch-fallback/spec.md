---
status: approved
date: 2026-08-15
implements: [ADR-0003, ADR-0008]
extends: [SPEC-0001]
---

# SPEC-0002: Manifest Fetch Fallback

## Overview

SPEC-0001 REQ "Manifest Check" fetches each active package's declared
`manifest` URL. In practice most of those fetches fail: the dominant
Foundry convention,
`https://github.com/<owner>/<repo>/releases/latest/download/module.json`,
sends no `Access-Control-Allow-Origin` header anywhere in its redirect
chain, so a browser rejects it. Measured against a real modlist, six of
seven packages returned "Couldn't check."

This capability adds a second, CORS-open attempt when the declared URL
fails: a `raw.githubusercontent.com` URL derived from the declared URL
itself, for `github.com`-hosted packages. A `cdn.statically.io` mirror URL
serves the same role for `gitlab.com`- and `bitbucket.org`-hosted
packages, since neither host's own raw-file endpoint is CORS-open in the
way that matters here — GitLab's not at all, Bitbucket's only when the
request carries an `Origin` header, which its Downloads feature (release
assets) still fails regardless (ADR-0008, amended 2026-08-16). It realizes
ADR-0003 and ADR-0008 and extends SPEC-0001's manifest-check behavior
rather than replacing it — the declared URL remains the primary and
preferred source, and every existing SPEC-0001 guarantee (per-package
error isolation, concurrency capping, session caching) continues to hold
unchanged.

Because the fallback reads a repository's default branch rather than its
released tag, the data it produces is **not** equivalent to the data the
declared URL would have returned — and can differ in either direction.
This spec addresses that in two ways, both requirements rather than
implementation niceties:

- REQ "Result Provenance" — the source of every resolved result is recorded
  and surfaced, so fallback-sourced data is never mistaken for released
  data.
- REQ "Fallback Field Trust" — marking alone proved insufficient, because a
  correctly-marked row can still carry a wrong value. Fields whose
  reliability does not survive the default-branch read are not used at all.
- REQ "Release Tag Resolution" (ADR-0003 Amendment 2, 2026-08-16) — before
  accepting the default-branch read's reduced trust, the system first
  tries to resolve the package's actual latest release and read the
  manifest there instead, within a rate-limit budget shared with
  SPEC-0001's "possibly unmaintained" check.

This spec uses "comparison target" and `inferredLatest` per SPEC-0001's
Overview terminology note: `inferredLatest` is specifically the
peer-inferred value, and is the comparison target only when no
authoritative target (`game.data.coreUpdate`) is available. REQ "Inferred
Latest Participation" below concerns fallback-sourced data feeding that
specific peer-inference computation — not the comparison target generally.

## Requirements

### Requirement: Fallback Trigger and Ordering

The system SHALL attempt each package's declared `manifest` URL first, and
SHALL attempt the derived fallback URL only when that first attempt fails.

- The system MUST NOT request the fallback URL for a package whose declared
  manifest URL resolved successfully.
- The system MUST treat every SPEC-0001 failure mode (network error,
  CORS rejection, non-200 response, malformed JSON, missing manifest URL)
  as a trigger for the fallback attempt.
- The system MUST NOT attempt the fallback more than once per package per
  check.

#### Scenario: Declared URL succeeds

- **WHEN** a package's declared manifest URL returns a valid manifest
- **THEN** the system uses that manifest and issues no fallback request for
  that package

#### Scenario: Declared URL fails

- **WHEN** a package's declared manifest URL fails for any reason
- **THEN** the system attempts exactly one fallback request for that
  package

#### Scenario: Fallback also fails

- **WHEN** both the declared URL and the fallback URL fail for a package
- **THEN** the system records that package's status as "Couldn't check",
  unchanged from SPEC-0001's behavior

### Requirement: Fallback URL Derivation

The system SHALL derive the fallback URL from the package's **declared
manifest URL**, and MUST NOT derive it from the fetched manifest body.

- The system MUST parse `<owner>` and `<repo>` from the declared manifest
  URL when that URL is a `github.com`, `gitlab.com`, or `bitbucket.org` URL
  (per ADR-0008 Amendments, 2026-08-16).
- The system MUST NOT source `<owner>`/`<repo>` from the fetched manifest's
  `url` or `bugs` fields. Those fields live inside the manifest body, which
  is by definition unavailable on the path where the fallback is required.
- The system MUST carry the filename from the declared manifest URL into
  the fallback URL, and MUST NOT hardcode `module.json`. Game systems
  declare `system.json`.
- For a `github.com`-hosted declared URL, the derived URL MUST take the
  form `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<filename>`.
- For a `gitlab.com`- or `bitbucket.org`-hosted declared URL, the derived
  URL MUST take the form
  `https://cdn.statically.io/gl/<owner>/<repo>@HEAD/<filename>` or
  `https://cdn.statically.io/bb/<owner>/<repo>@HEAD/<filename>`
  respectively (per ADR-0008 Amendments) — a third-party CORS-open mirror,
  since neither host's own raw-file endpoint is reliably CORS-open for
  this module's purposes (GitLab: never; Bitbucket: only with an `Origin`
  header present on its `raw/` path, and not at all on its Downloads
  feature — measured, ADR-0008 Amendment 3). All forms resolve `HEAD` to
  the actual default branch without a prior lookup.

#### Scenario: Module manifest URL (GitHub)

- **WHEN** a package declares
  `https://github.com/ruipin/fvtt-lib-wrapper/releases/latest/download/module.json`
  and that URL fails
- **THEN** the system requests
  `https://raw.githubusercontent.com/ruipin/fvtt-lib-wrapper/HEAD/module.json`

#### Scenario: Module manifest URL (GitLab)

- **WHEN** a package declares a `gitlab.com`-hosted manifest URL
  (`https://gitlab.com/<owner>/<repo>/...`) and that URL fails
- **THEN** the system requests
  `https://cdn.statically.io/gl/<owner>/<repo>@HEAD/<filename>`, with
  `<owner>`, `<repo>`, and `<filename>` parsed from the declared URL

#### Scenario: Module manifest URL (Bitbucket)

- **WHEN** a package declares a `bitbucket.org`-hosted manifest URL
  (`https://bitbucket.org/<owner>/<repo>/...`) and that URL fails
- **THEN** the system requests
  `https://cdn.statically.io/bb/<owner>/<repo>@HEAD/<filename>`, with
  `<owner>`, `<repo>`, and `<filename>` parsed from the declared URL

#### Scenario: Game system manifest URL

- **WHEN** the active game system declares a manifest URL ending in
  `system.json` and that URL fails
- **THEN** the derived fallback URL ends in `system.json`, not
  `module.json`, regardless of which host-specific form applies

#### Scenario: Manifest body is unavailable

- **WHEN** the declared manifest URL fails and no manifest body was
  retrieved for that package
- **THEN** the system still derives a fallback URL, because derivation
  depends only on the declared URL and not on any fetched content

### Requirement: Fallback Scope and Limits

The system SHALL restrict the fallback to packages whose declared manifest
URL is a `github.com`, `gitlab.com`, or `bitbucket.org` URL (per ADR-0008
Amendments, 2026-08-16), and SHALL report an honest "Couldn't check" for
every package the fallback cannot serve.

- The system MUST NOT attempt a fallback for packages hosted anywhere other
  than `github.com`, `gitlab.com`, or `bitbucket.org` — there is no
  CORS-open path (own or third-party mirror) known for any other host, per
  ADR-0008. This includes self-hostable forges (e.g. Gitea/Forgejo) by
  construction: no third-party mirror can exist for a host with no fixed
  domain a CDN could build support for.
- The system MUST treat a non-200 response from the fallback URL as a
  terminal failure for that package, with no further attempts.
- The system MUST NOT attempt fallback-of-fallback logic for the GitLab or
  Bitbucket paths (e.g. retrying a second mirror if `cdn.statically.io`
  fails) — per ADR-0008 Amendments, that failure degrades to "Couldn't
  check" exactly as it would have without this fallback at all,
  deliberately not engineered around further.
- The system MAY contact the GitHub API as part of resolving a package's
  GitHub-hosted fallback, per REQ "Release Tag Resolution" (ADR-0003
  Amendment 2, 2026-08-16) — but only within the shared rate-limit budget
  that requirement defines, which also governs SPEC-0001 REQ "Possibly
  Unmaintained Heuristic"'s own GitHub API usage. Neither consumer may
  spend the budget independently of the other. This does not apply to the
  GitLab or Bitbucket paths, neither of which has an equivalent
  release-tag API this module uses.

#### Scenario: Unsupported host

- **WHEN** a package declares a manifest URL on a host other than
  `github.com`, `gitlab.com`, or `bitbucket.org`, and that URL fails
- **THEN** the system records "Couldn't check" without attempting any
  fallback request. This is a permanent limitation for hosts with no known
  CORS-open path, own or third-party, not a pending gap — see ADR-0008.

#### Scenario: GitLab mirror fails

- **WHEN** a package's declared URL is `gitlab.com`-hosted and fails, and
  the `cdn.statically.io` mirror fetch also fails (network error, non-200,
  the manifest is a build artifact not in source, or the mirror is
  unreachable)
- **THEN** the system records "Couldn't check" for that package — the
  same outcome as if the GitLab fallback did not exist, per ADR-0008
  Amendment's explicit no-engineering-around-it stance

#### Scenario: Bitbucket mirror fails

- **WHEN** a package's declared URL is `bitbucket.org`-hosted and fails
  (most commonly a Downloads-feature URL, per ADR-0008 Amendment 3), and
  the `cdn.statically.io` mirror fetch also fails
- **THEN** the system records "Couldn't check" for that package — the
  same outcome as if the Bitbucket fallback did not exist

#### Scenario: Manifest absent from the default branch

- **WHEN** a package's manifest is a build artifact not committed to the
  repository root, so the derived fallback URL returns 404
- **THEN** the system records "Couldn't check" for that package,
  regardless of which host-specific fallback form was attempted

### Requirement: Release Tag Resolution

Before falling back to a raw/default-branch read, the system SHALL attempt
to resolve the package's actual latest release and read the manifest at
that release, per ADR-0003 Amendment 2 (2026-08-16).

- WHEN a package's declared URL fails and its fallback URL is
  GitHub-hosted, the system SHALL first call
  `GET /repos/{owner}/{repo}/releases/latest`, subject to the shared
  rate-limit budget below.
- WHEN that call resolves a `tag_name`, the system SHALL fetch the
  manifest from `raw.githubusercontent.com/{owner}/{repo}/{tag_name}/
  {filename}` (the same filename-derivation rule as REQ "Fallback URL
  Derivation").
- WHEN that fetch succeeds, the system SHALL treat both `version` and
  `compatibility.verified` as trustworthy — this is the package's actual
  released manifest, not a default-branch read — and MUST record the
  result's provenance as `release`, distinct from `declared` and
  `fallback`.
- WHEN the release-tag lookup fails for any reason (no releases published,
  non-200/network error, rate-limited, or budget exhausted), OR the
  tag-resolved fetch itself fails, the system MUST fall through to the
  existing raw/HEAD fallback (REQ "Fallback URL Derivation") unchanged.
  This path MUST NOT surface as an additional error beyond what the
  raw/HEAD fallback already reports.
- **Rate-limit budget**: the system MUST maintain a single counter shared
  between this requirement's `api.github.com` calls and SPEC-0001 REQ
  "Possibly Unmaintained Heuristic"'s `archived`/`pushed_at` lookups,
  scoped to one classification run (not persisted across scans). Each
  consumer MUST decrement the shared counter before making a call and MUST
  skip the call — falling through to that consumer's existing non-API
  behavior — once the counter reaches zero. The budget is best-effort: it
  bounds how much of the pool this module spends *proactively* in one
  scan, not a guarantee against real GitHub-side rate-limiting, which
  MUST continue to degrade through the standard per-package error-handling
  path (REQ "Error Handling Standards") rather than a new failure mode.
- The system MUST NOT contact `api.github.com` for a package whose
  declared URL already succeeded, or whose fallback URL is not
  GitHub-hosted.

#### Scenario: Real release exists

- **WHEN** a package's declared URL fails, its fallback URL is
  GitHub-hosted, and `releases/latest` resolves a tag whose manifest fetch
  succeeds
- **THEN** the system uses that manifest's `version` and
  `compatibility.verified` as trustworthy, provenance `release`

#### Scenario: No releases published

- **WHEN** a package's declared URL fails and `releases/latest` returns a
  non-200 response (e.g. no releases exist yet)
- **THEN** the system falls through to the raw/HEAD fallback unchanged,
  provenance `fallback`, `version` treated as unknown per REQ "Fallback
  Field Trust"

#### Scenario: Shared budget exhausted

- **WHEN** the shared rate-limit budget counter has reached zero, whether
  from this requirement's own calls or from REQ "Possibly Unmaintained
  Heuristic"'s calls earlier in the same scan
- **THEN** the system does not attempt release-tag resolution for any
  remaining package in that scan, falling through directly to the
  raw/HEAD fallback for each

#### Scenario: Tag-resolved fetch itself fails

- **WHEN** `releases/latest` resolves a tag but the manifest fetch at that
  tag fails (network error, non-200, malformed JSON)
- **THEN** the system falls through to the raw/HEAD fallback unchanged,
  rather than reporting a separate error for the tag-resolution attempt

### Requirement: Result Provenance

The system SHALL record, for every successfully resolved package, whether
the manifest came from the declared URL or from the fallback, and SHALL
surface that distinction to the GM.

Fallback-sourced data describes a repository's default branch, which MAY
differ from any released build in **either** direction. Presenting it as
the package's latest *published* release would misstate what the developer
actually shipped, violating project rule 4 (dev-declared, not tested) and —
by implying a volunteer is behind on a release they never made — project
rule 1.

Marking provenance is necessary but **not sufficient**: a correctly-marked
row can still carry a wrong value. Which fields may be used at all is
governed by REQ "Fallback Field Trust".

- Each resolved package result MUST carry a provenance value distinguishing
  `declared`, `fallback` (raw/HEAD, `version` unknown per REQ "Fallback
  Field Trust"), and `release` (resolved via REQ "Release Tag Resolution"
  — an actual released manifest, `version` and `compatibility.verified`
  both trustworthy).
- The checker table MUST visually distinguish a `fallback`-sourced row from
  a `declared`-sourced row. A `release`-sourced row MUST NOT carry that
  same marking — its data is exactly as trustworthy as `declared`, and
  marking it as uncertain would misrepresent it — but MAY carry a neutral,
  non-alarming indicator naming the resolution path, for transparency
  rather than caveat.
- The system MUST NOT label a fallback-sourced version with wording that
  asserts it is the latest published or released version.
- The system MUST NOT use language implying a package is behind, neglected,
  or at fault on the basis of fallback-sourced data.

#### Scenario: Fallback-sourced row

- **WHEN** a package's data was obtained via the default-branch fallback
  URL (`raw.githubusercontent.com` or the `cdn.statically.io` GitLab/
  Bitbucket mirror)
- **THEN** the checker table marks that row as sourced from the
  repository's default branch rather than a published release

#### Scenario: Release-sourced row

- **WHEN** a package's data was obtained via REQ "Release Tag Resolution"
- **THEN** the row carries no "uncertain" fallback marking — its data is
  as trustworthy as a declared-sourced row

#### Scenario: Declared-sourced row

- **WHEN** a package's data was obtained from its declared manifest URL
- **THEN** the row carries no fallback marking

### Requirement: Fallback Field Trust

The system SHALL treat a fallback-sourced manifest field by field rather
than as a single trustworthy unit, and MUST NOT derive update availability
from a fallback-sourced `version` (per ADR-0003 as amended 2026-08-16).

A repository's committed `version` is frequently stamped by release
tooling rather than maintained by hand, so the value on the default branch
may be an arbitrarily stale placeholder. `compatibility.verified` is
hand-edited in that same committed file and does not share this defect.

- The system MAY use `compatibility.verified`, and the legacy
  `compatibleCoreVersion` fallback, from a fallback-sourced manifest. This
  grants permission generally; REQ "Inferred Latest Participation" mandates
  one specific use of it, and REQ "Compatibility Severity Classification"
  in SPEC-0001 another.
- The system MAY use `url`, `bugs`, and `changelog` from a fallback-sourced
  manifest, which are not version-sensitive.
- The system MUST treat a fallback-sourced `version` as **unknown**: it
  MUST NOT surface it as the package's latest version, and MUST NOT derive
  an update-available verdict from it.
- The system MUST NOT present unknown update availability as "up to date",
  or as any other wording asserting the installed version is current.
- The system MUST NOT gate use of a fallback-sourced `version` on a
  plausibility check such as "only when newer than the installed version" —
  a stale placeholder that happens to be higher passes such a check and
  still reports wrongly.
- These constraints apply only to **`fallback`-provenance** results (the
  raw/HEAD read). A `declared`-sourced `version` is the released version
  and is used unchanged; a `release`-sourced `version` (REQ "Release Tag
  Resolution") is also the released version, obtained via a different
  resolution path, and is likewise used unchanged.

#### Scenario: Fallback version older than installed

- **WHEN** a package resolves via the fallback and the fetched `version` is
  older than the installed version
- **THEN** the system reports update availability as unknown, and does not
  report the package as up to date

#### Scenario: Fallback version newer than installed

- **WHEN** a package resolves via the fallback and the fetched `version` is
  newer than the installed version
- **THEN** the system still reports update availability as unknown, because
  the fetched value is not evidence of a published release

#### Scenario: Compatibility retained from a fallback-sourced manifest

- **WHEN** a package resolves via the fallback
- **THEN** its `compatibility.verified` is used for severity classification
  and for the peer-inference computation, unchanged

#### Scenario: Declared-sourced version is unaffected

- **WHEN** a package resolves from its declared manifest URL
- **THEN** its `version` is used to determine update availability as before

### Requirement: Inferred Latest Participation

The system SHALL include `compatibility.verified` values obtained via the
fallback when computing `inferredLatest` (SPEC-0001 REQ "Inferred Latest
Version").

`inferredLatest` is the fallback comparison target, used when no
authoritative target is available from `game.data.coreUpdate` (SPEC-0001
REQ "Target Version Determination"). Excluding fallback-sourced values
would make that fallback depend on which packages happened to have
CORS-friendly manifest URLs — a property unrelated to how current those
packages are. Including them is consistent with ADR-0001, which frames
`inferredLatest` as advisory inference rather than ground truth, and with
ADR-0002, which gates severity escalation on `compatibility.maximum`
rather than on `verified` alone.

- Fallback-sourced `verified` values MUST participate in the
  `inferredLatest` computation on the same terms as declared-sourced
  values.
- The system MUST continue to treat `inferredLatest` as advisory, and MUST
  NOT present it as an authoritative statement about the latest Foundry
  release.

#### Scenario: Peer signal recovered via fallback

- **WHEN** every package that declares a `compatibility.verified` higher
  than `game.release` was resolved via the fallback
- **THEN** `inferredLatest` reports a peer signal derived from those values

### Requirement: Error Handling Standards

The fallback attempt SHALL be subject to the same structured error handling
as the declared-URL attempt (SPEC-0001 REQ "Error Handling Standards"),
which this requirement extends rather than restates.

- A fallback failure MUST be caught per-package and MUST NOT propagate
  uncaught out of the scan.
- When both attempts fail, the recorded diagnostic MUST identify the
  package and MUST make clear that both a declared and a fallback attempt
  were made, so a "Couldn't check" row is not mistaken for an untried one.
- A fallback failure for one package MUST NOT affect any other package's
  result.

#### Scenario: Fallback throws

- **WHEN** the fallback request throws or rejects for a given package
- **THEN** that package resolves to "Couldn't check" with a diagnostic
  attributing the failure to that package, and every other package's result
  is unaffected

### Requirement: Concurrency and Caching Interaction

The fallback attempt SHALL operate within SPEC-0001 REQ "Fetch Concurrency
and Caching" rather than outside it.

- Fallback requests MUST be subject to the same in-flight concurrency cap
  as declared-URL requests, so that adding a second attempt per failing
  package cannot exceed the configured limit.
- A package's resolved result MUST be cached for the session regardless of
  which source produced it, and the cached entry MUST retain its
  provenance.
- Fallback requests MUST honor cancellation on the same signal as
  declared-URL requests.
- SPEC-0001's constraint that the system "MUST NOT re-fetch a package's
  manifest ... more than once per session" governs repeated *checks* across
  checker-window opens — the case its own "Re-check within the same
  session" scenario describes. It does not cap the number of HTTP attempts
  within a single check. A declared-URL attempt and its fallback together
  constitute **one** check of that package, and MUST NOT be counted as two
  for the purposes of that constraint.

#### Scenario: Concurrency cap holds under fallback load

- **WHEN** every package in a scan fails its declared URL and triggers a
  fallback attempt
- **THEN** the number of in-flight requests never exceeds the configured
  concurrency limit at any point

#### Scenario: Cached fallback result reused

- **WHEN** a GM reopens the checker within the same session and a package's
  cached result was fallback-sourced
- **THEN** the system reuses the cached result, including its provenance,
  without re-requesting either URL

## Accessibility Requirements

This spec adds a provenance indicator to the checker table, which is
browser-rendered UI. SPEC-0001's Accessibility Requirements govern the
checker window as a whole and continue to apply unchanged; the requirements
below cover only what this capability adds.

### WCAG 2.1 AA Compliance

The provenance indicator MUST meet WCAG 2.1 Level AA, consistent with the
rest of the checker window.

### ARIA Landmarks

No new landmark regions are introduced. The provenance indicator lives
inside the existing `role="main"` results region established by SPEC-0001.

### Icon-Only Controls

If the provenance indicator is rendered as an icon or other non-text mark,
it MUST carry a text alternative naming the source specifically — for
example "Read from the repository's default branch, not a published
release" — and MUST NOT rely on color, position, or shape alone to convey
that meaning.

### Dynamic Content Regions

Provenance is resolved as part of the existing scan, so it MUST appear
within the `aria-live="polite"` status updates SPEC-0001 already defines,
rather than introducing a separate live region.

### Keyboard Navigation

The provenance indicator MUST NOT introduce a focus stop unless it is
interactive. If it exposes explanatory detail (for example a tooltip), that
detail MUST be reachable and dismissible by keyboard.

### Focus Management

This capability introduces no modal or dialog and therefore no new focus
trap. SPEC-0001's focus-restoration requirement for the checker window
continues to apply unchanged.
