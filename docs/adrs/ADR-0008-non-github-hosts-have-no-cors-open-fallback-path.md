---
status: accepted
date: 2026-08-15
decision-makers: Jon Stump
extends: [ADR-0003]
---

# ADR-0008: Non-GitHub hosts have no CORS-open fallback path — a documented limit, not an oversight

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
