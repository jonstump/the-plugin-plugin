---
status: accepted
date: 2026-08-15
decision-makers: Jon Stump
extends: [ADR-0003]
---

# ADR-0008: Non-GitHub hosts have no CORS-open fallback path — a documented limit, not an oversight

> ## ⚠️ Amended 2026-08-16 — a CORS-open third-party mirror exists for GitLab
>
> This ADR tested GitLab's *own* endpoints and correctly found neither
> CORS-open. It did not test third-party mirrors of that same content —
> `cdn.statically.io` mirrors GitLab (and GitHub) source with
> `Access-Control-Allow-Origin: *`, confirmed directly against real content,
> including a `HEAD` ref alias equivalent to
> `raw.githubusercontent.com/.../HEAD/...`. The "accept and document as
> permanent" decision below is revised — see "Amendment" at the end.

> ## ⚠️ Amended 2026-08-16 (2) — Bitbucket support added, and a methodology gap fixed
>
> First reported informally (verbally, not written here) as "no CORS-open
> path for Bitbucket, same as GitLab." That was wrong, and wrong for a
> specific, correctable reason: the verification method (`curl` without an
> explicit `Origin` header) cannot detect a CORS setup that *reflects* the
> requesting origin instead of sending a static `*` — which is exactly what
> Bitbucket's `raw/` endpoint does. A real browser (and `curl -H "Origin:
> ..."`) shows it's genuinely CORS-open. See "Amendment 3" at the end for
> the full picture, including where Bitbucket's actual CORS gap really is
> (its Downloads feature, not raw file access).

## Context and Problem Statement

SPEC-0002's fallback mechanism (ADR-0003) is scoped to `github.com`-hosted
declared manifest URLs only. In the real test world, 2 of 7 packages
(`pings`, `settings-extender`) are GitLab-hosted and get an honest
"Couldn't check" with no fallback attempt at all — ADR-0003's own
Consequences section already flagged this as a known gap: *"GitLab-hosted
packages in particular have no equivalent path."*

That line reads like an unfinished feature — "we haven't gotten to GitLab
yet." Investigating issue #58 raised the natural follow-up: could a
GitLab-equivalent fallback (`gitlab.com/.../-/raw/<branch>/<file>`, mirroring
`raw.githubusercontent.com`) be added the same way? This ADR answers that
directly, with measurement rather than assumption, because the honest
answer changes the shape of the gap: it isn't unfinished, it's closed.

## What was measured

`raw.githubusercontent.com` is CORS-open — `access-control-allow-origin: *`
on every response, which is the entire reason ADR-0003's fallback works at
all. The equivalent question for GitLab is whether its raw-file endpoint or
public API sends the same header. Tested directly, using a file confirmed
to exist (this project's own repo's README, not a 404 that could be
mistaken for "wrong path"):

```
GET https://gitlab.com/foundry-azzurite/pings/-/raw/master/README.md
Status: 200
(full response headers inspected — no Access-Control-Allow-Origin present,
 on a 200 response for a file known to exist)

GET https://gitlab.com/api/v4/projects/foundry-azzurite%2Fpings/releases
Status: 200
(no Access-Control-Allow-Origin present)
```

Both GitLab surfaces return **200 with no CORS header at all** — GitHub's
`access-control-allow-origin: *` is a deliberate choice on GitHub's part,
not a default every forge shares. A browser rejects both requests before
this module would ever see the body, exactly like the CORS-blocked
declared URL that started this whole chain of ADRs (ADR-0003's original
problem statement). There is no equivalent of `raw.githubusercontent.com`
to fall back to.

`pings` and `settings-extender` additionally declare CI job-artifact URLs
(`.../-/jobs/artifacts/master/raw/dist/pings/module.json?job=build`) rather
than a manifest committed to the repo root — the same "build artifact, not
in source" pattern ADR-0003 already treats as a 404-and-give-up case for
GitHub. Even a hypothetical CORS-open GitLab raw endpoint would still miss
these two specific packages for that separate reason.

## Decision Drivers

* Accuracy — "we haven't built it yet" and "it cannot be built the same
  way" call for different responses, and the wrong one wastes a future
  session's time re-investigating a closed question
* No server component, no proxy (project rule 5) — the only mechanism that
  *would* solve this (a relay fetching manifests server-side, immune to
  CORS) is the exact architecture that killed `arcanistzed/mcc`
  (`docs/research/mcc-research.md`) and is explicitly out of scope
* KISS (project rule 2) — don't build a per-forge fallback that only ever
  serves one forge; if a second CORS-open forge is found, the derivation
  pattern ADR-0003 established generalizes, but GitLab isn't one

## Considered Options

* Add a `gitlab.com/.../-/raw/<branch>/<file>` fallback, mirroring ADR-0003
* Add a GitLab API-based fallback, mirroring this project's GitHub
  `releases/latest` tag-resolution approach (ADR-0003 Amendment 2)
* Build a proxy/relay service to fetch manifests server-side regardless of
  host
* Accept the limitation and document it as permanent, not pending

## Decision Outcome

Chosen option: **accept and document the limitation as permanent** (absent
a change on GitLab's side, or a future forge whose public endpoints are
CORS-open the way GitHub's are).

Both fallback variants (raw-file, API) are ruled out by the same
measurement: neither GitLab surface sends
`Access-Control-Allow-Origin`, so a browser blocks the request identically
to the already-failing declared URL — there is nothing to fall back *to*.
The proxy option would work but was already rejected by ADR-0003 and
project rule 5 for the same reason it isn't reconsidered here: standing
server infrastructure a volunteer must maintain forever, with no handoff
path, is the specific failure mode this project exists to avoid repeating.

Non-GitHub-hosted packages continue to resolve to an honest "Couldn't
check" — unchanged behavior, now backed by a recorded reason rather than a
gap implicitly awaiting a fix.

### Consequences

* Good, because a future session (or this one, later) doesn't re-spend
  time investigating "why don't we support GitLab" as if it were an
  oversight — the measurement is recorded and the answer won't change
  without GitLab changing its own CORS policy.
* Good, because it keeps ADR-0003's fallback mechanism honestly scoped to
  what it actually is: a GitHub-specific accommodation for a GitHub-specific
  CORS gap, not a general "any forge" solution that happens to be
  incomplete.
* Neutral, because it changes no behavior — GitLab-hosted packages already
  read "Couldn't check" today; this ADR explains why rather than changing
  what happens.
* Bad, because GitLab-hosted (and any other non-GitHub-hosted) packages
  remain permanently at a coverage disadvantage compared to GitHub-hosted
  ones, for reasons outside this project's control.

### Confirmation

No code change accompanies this ADR. Code review should treat "add a
GitLab fallback" proposals as requiring new evidence that GitLab's CORS
posture has changed, not a re-implementation of the GitHub pattern —
citing this ADR's measurement is sufficient grounds to decline such a
proposal without re-testing, unless the revisit condition below applies.

## Pros and Cons of the Options

### GitLab raw-file fallback (mirroring ADR-0003)

* Good, because the derivation pattern already exists and generalizes
  trivially in code.
* Bad, because GitLab's raw-file endpoint sends no
  `Access-Control-Allow-Origin` header — measured directly against a
  known-good file, not assumed from a 404. The browser blocks it before
  any code runs.

### GitLab API-based fallback (mirroring ADR-0003 Amendment 2)

* Good, because it would also recover accurate version data, not just
  compatibility data, if it worked.
* Bad, because GitLab's public REST API also sends no CORS header —
  measured directly. Same wall, one layer up.

### Proxy/relay service

* Good, because a server has no CORS restriction and would work regardless
  of host.
* Bad, because it is explicitly out of scope (project rule 5) and is
  precisely the architecture `arcanistzed/mcc` died from — already
  rejected once by ADR-0003 for this exact reason.

### Accept and document (chosen)

* Good, because it costs nothing to implement and prevents wasted
  re-investigation.
* Bad, because it doesn't move coverage forward for non-GitHub hosts.

## More Information

* [`ADR-0003`](ADR-0003-raw-github-fallback-for-cors-blocked-manifests.md) —
  the GitHub-specific mechanism this ADR clarifies the boundary of.
* [`docs/research/mcc-research.md`](../research/mcc-research.md) — the
  prior art whose proxy architecture is the reason a relay stays rejected
  here too.
* Revisit if: GitLab begins sending `Access-Control-Allow-Origin` on its
  raw-file endpoint or public API (a change on their end, not ours); or a
  package turns up on a different forge whose public endpoints ARE
  CORS-open, in which case the *pattern* ADR-0003 established (derive from
  the declared URL, verify CORS headers before committing) generalizes —
  this ADR's conclusion is specific to GitLab as measured, not a blanket
  claim about every non-GitHub forge.

## Amendment — 2026-08-16, a CORS-open third-party GitLab mirror exists

### What was missed

The original measurement was correct as far as it went — GitLab's *own*
raw-file endpoint and REST API both genuinely lack
`Access-Control-Allow-Origin`. What it didn't check: whether a third party
already mirrors that same content with CORS enabled. `cdn.statically.io`
does, for both GitLab and GitHub:

```
GET https://cdn.statically.io/gl/foundry-azzurite/pings@HEAD/README.md
Status: 200, access-control-allow-origin: *
content-length: 942 — byte-for-byte the same file gitlab.com serves,
  confirmed against the actual README content, not a generic response.

GET https://cdn.statically.io/gl/foundry-azzurite/pings@HEAD/dist/pings/module.json
Status: 404 — the CI-built artifact still isn't in source, so this
  specific package is still unreachable, for the *separate* reason
  already noted in the original measurement (not a CORS problem).
```

The `@HEAD` ref resolves to the actual default branch without a prior
lookup, exactly mirroring `raw.githubusercontent.com/.../HEAD/...`
(ADR-0003) — no extra request needed to first discover the branch name.

### Revised decision

Add `cdn.statically.io/gl/<owner>/<repo>@HEAD/<filename>` as a second
fallback target, parallel to ADR-0003's `raw.githubusercontent.com`
fallback, for `gitlab.com`-hosted declared URLs. Same trust rules apply
identically: this is a default-branch read, not a released-tag read, so
SPEC-0002 REQ "Fallback Field Trust" governs it exactly the same way it
already governs the GitHub raw/HEAD fallback — `compatibility.verified` is
used, `version` is treated as unknown.

This is accepted as a **new, and materially different, kind of
dependency** from `raw.githubusercontent.com`: GitHub's raw-file service is
run by the dominant host itself; `statically.io` is a separate third party
neither this project nor GitLab nor the package developer controls.
Explicitly not over-engineered against that risk — no fallback-of-fallback,
no health check, no staleness detection. If `statically.io` becomes
unreliable or disappears, GitLab-hosted packages degrade to exactly
today's "Couldn't check," the same outcome as if this amendment had never
shipped. That degrade path costs nothing to keep working because it
already exists and is already tested.

### Consequences

* Good, because GitLab-hosted packages that commit their manifest to the
  repository (the common case — `pings`/`settings-extender`'s CI-artifact
  pattern is the exception, not the rule) gain the same coverage GitHub
  gets from the raw/HEAD fallback.
* Good, because the failure mode if the CDN goes away is identical to
  today's baseline, not worse — nothing regresses, coverage just stops
  improving.
* Neutral, because this doesn't touch REQ "Release Tag Resolution"
  (ADR-0003 Amendment 2) — that stays GitHub-specific; `statically.io` has
  no equivalent release-tag API, so GitLab-hosted packages get the
  raw/HEAD-equivalent trust level, not the fully-trusted `release`
  provenance GitHub-hosted packages can reach.
* Bad, because it's a new third-party dependency of unproven longevity,
  accepted deliberately rather than engineered around.

### Confirmation

Code review should reject any GitLab-fallback implementation that: derives
the mirror URL from anything other than the declared manifest URL (same
constraint as ADR-0003's GitHub derivation); trusts a GitLab-mirrored
`version` field (must follow REQ "Fallback Field Trust" identically to the
GitHub case); or adds retry/health-check/staleness logic beyond what the
GitHub fallback already has — this amendment is deliberately as simple as
the mechanism it mirrors.

### Revisit if (supersedes the original revisit note for GitLab specifically)

`cdn.statically.io` becomes unreliable, changes its URL scheme, or
disappears — in which case this amendment's fallback attempt simply starts
failing and packages degrade to "Couldn't check," the pre-amendment
baseline. No urgent action required if that happens; revisit only if a
better-suited mirror or a change in GitLab's own CORS policy makes this
amendment worth replacing.

## Amendment 3 — 2026-08-16, Bitbucket: a methodology gap, and where the real gap is

### The methodology gap

Bitbucket was informally reported as "no CORS-open path, like GitLab" —
wrong, and wrong in a way worth recording so it isn't repeated. Every prior
measurement in this ADR used `curl` **without** an explicit `Origin`
header. That's a blind spot: `curl` never identifies itself as a browser
origin unless told to, and a server whose CORS logic *reflects* the
requesting origin (rather than sending a static `*`, as GitHub,
`raw.githubusercontent.com`, and `cdn.statically.io` all do) will
correctly, silently omit `Access-Control-Allow-Origin` for a request with
no `Origin` header — producing a false "not CORS-open" reading for a host
that actually is.

```
GET https://bitbucket.org/rpgframework-cloud/shadowrun6-eden/raw/master/system.json
  (no Origin header, curl default)      -> no Access-Control-Allow-Origin
  -H "Origin: http://localhost:30000"   -> access-control-allow-origin: *
```

Confirmed live in an actual browser too — `fetch()` against this exact URL
returns `type: "cors"`, `status: 200`, fully readable. GitLab and GitHub's
declared URLs were re-checked with an explicit `Origin` header at the same
time, as a sanity check against having made the identical mistake there:
both still show no CORS header even with `Origin` present, so the
already-shipped GitLab fallback (Amendment above) is unaffected and its
conclusion stands. **Going forward, CORS verification in this project MUST
include an explicit `Origin` header** (`curl -H "Origin: <plausible-value>"
...`) — omitting it is not a neutral simplification, it's a test that can
only ever produce false negatives, never false positives.

### Where Bitbucket's real gap is

Bitbucket has two distinct file-serving surfaces, and they differ:

- **`bitbucket.org/<owner>/<repo>/raw/<branch>/<file>`** (source browsing,
  the equivalent of `raw.githubusercontent.com` or GitLab's `-/raw/`) —
  genuinely CORS-open, reflects `Origin`. A package declaring this as its
  manifest URL needs **no fallback at all** — the declared attempt already
  succeeds, the same way `multilevel-tokens` already declares a
  `raw.githubusercontent.com` URL directly (ADR-0003) and needs nothing
  extra.
- **Bitbucket "Downloads"** (uploaded release artifacts, Bitbucket's rough
  equivalent of a GitHub release asset) — 302-redirects to a presigned S3
  URL that sends no CORS header at all, `Origin` or not. This is the actual
  gap, and it's the same shape as GitHub's `releases/latest/download/...`
  problem that started ADR-0003 in the first place.

Real-world evidence for both halves, from the one Bitbucket-hosted Foundry
package found (`rpgframework-cloud/shadowrun6-eden`, a Shadowrun 6 system):

```
raw/master/system.json          -> 200, CORS-open with Origin, real content
                                    (the "raw/ needs no fallback" case)
downloads/system-staging.json   -> 302 -> S3, no CORS at all
                                    (the "Downloads is the real gap" case)
raw/master/system-staging.json  -> 404 (not committed to git source)
cdn.statically.io mirror of it  -> 404 (same reason — the fallback can't
                                    invent data that was never in source)
```

That last pair means this specific package's Downloads-hosted manifest
variant is a real **negative** case for the fallback — the same shape as
GitLab's `pings`/`settings-extender` (ADR-0003/ADR-0008 above): a genuinely
broken declared URL whose data was never committed to git at all, so no
CORS fix, real or mirrored, can recover it. No real positive proof of the
Bitbucket-Downloads-fallback-actually-recovering-data case was found;
`raw/`'s own CORS support is the real positive proof, just of a different
fact (no fallback needed at all).

### Decision

Add `bitbucket.org` alongside `gitlab.com` as a third host `deriveFallbackUrl`
derives a `cdn.statically.io/bb/<owner>/<repo>@HEAD/<filename>` mirror URL
for, on identical terms to the GitLab case: same trust rules (REQ "Fallback
Field Trust" governs it, `version` unknown), same no-engineering-around-it
stance (no fallback-of-fallback, degrades to today's baseline on failure).
Bitbucket's own REST API also reflects `Origin` correctly when tested
properly (`access-control-allow-origin: *` on `api.bitbucket.org`), noted
for completeness — not used here, since there's no Bitbucket equivalent to
ADR-0003 Amendment 2's GitHub release-tag resolution to build on it.

### Consequences

* Good, because the Bitbucket Downloads gap (the actual broken convention)
  now has the same fallback coverage GitHub and GitLab already have,
  bounded by the same honest degrade-to-baseline guarantee.
* Good, because the methodology fix (always send `Origin`) prevents this
  specific mistake from recurring for any future host investigated.
* Neutral, because packages already using Bitbucket's `raw/` convention are
  entirely unaffected — they already worked, and still do.
* Bad, because — same as the GitLab amendment — this is a real, unhedged
  dependency on `cdn.statically.io` staying up, now serving two hosts'
  worth of fallback traffic instead of one.

### Confirmation

Code review should reject: any Bitbucket-fallback implementation that
skips the shared trust rules (REQ "Fallback Field Trust") that already
govern the GitHub and GitLab fallbacks; and any future CORS verification
in this project's ADRs that omits an explicit `Origin` header when testing
`curl` against a candidate host — cite this amendment as the reason that
specific mistake is not acceptable to repeat.

### Revisit if

`cdn.statically.io` becomes unreliable for the Bitbucket path specifically
(unlikely to differ from the GitLab path's fate, but worth checking
independently if reported); or Bitbucket's Downloads feature changes to
route through a CORS-open path directly, making the mirror unnecessary for
that case too.
