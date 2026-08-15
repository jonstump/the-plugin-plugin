# Research: Detecting the Latest Foundry VTT Version, Client-Side

> ## ⚠️ Corrected 2026-08-15 — the original conclusion was wrong
>
> This document originally concluded that the latest core version could not
> be determined client-side. **That conclusion was incorrect.** Foundry
> exposes it at **`game.data.coreUpdate.version`**, in-world, with no
> credentials and no fetch of any kind.
>
> The error is isolated to the "What's available on the client already"
> section below, which asserted that no such field exists. Everything in
> "What was tested against foundryvtt.com directly" remains accurate and
> still stands — you genuinely cannot fetch this from foundryvtt.com. The
> mistake was concluding that therefore it was unavailable, when in fact
> Foundry's own server had already fetched it and handed it to the client.
>
> See "Correction" at the end of this document for the evidence and the
> method failure that produced the error. ADR-0001 has been amended
> accordingly.

Question: from inside a running world (browser JS, no server component, no API
keys), can we reliably determine the *latest available* Foundry VTT core
version, so the checker table can flag "verified for current, but not for the
newest generation"?

Findings as of 2026-08-15 (Foundry core is currently on the v14 generation;
v13 is the prior stable generation).

## What's available on the client already

- `game.release` (a `ReleaseData` instance) exposes version/generation/build
  info, but only for **the version currently running** — not the latest
  published release. ~~There's no companion field anywhere in `game.data` for
  "latest available."~~ **← This was wrong. See Correction below:
  `game.data.coreUpdate.version` is exactly that field.**
- Foundry's own update check (Setup screen "Check for Update") happens
  through the local Node server, which talks to foundryvtt.com using the
  world owner's **license key**. That flow isn't reachable client-side and
  requires privileged access we were told not to assume (constraint: no API
  keys). **Partially wrong in its implication:** the *flow* is indeed not
  reachable client-side, but its *result* is relayed to the client in
  `game.data.coreUpdate` — so the license-key barrier does not prevent us
  from learning the answer.

## What was tested against foundryvtt.com directly

| Endpoint | CORS (`Access-Control-Allow-Origin`) | Usable without auth? |
|---|---|---|
| `https://foundryvtt.com/releases/` (HTML release notes index) | Not present | Fetch works at the network level but the browser blocks reading the response cross-origin — no ACAO header means `fetch()` from a world's own origin throws. |
| `https://foundryvtt.com/releases/<version>` (per-release HTML page) | Not present | Same as above. |
| `https://foundryvtt.com/_api/packages/get` (official package API mentioned in the mcc prior-art doc) | `*` (open) | No — returns `403 Forbidden` without a privileged API key, confirming the mcc doc's note that this endpoint requires privileged access. Open CORS doesn't help if the endpoint itself rejects unauthenticated requests. |
| `https://foundryvtt.com/api/status` | N/A | `404` — not a real public endpoint (this was a guess based on generic "status API" naming, ruled out). |

No RSS/JSON feed of releases exists (`/releases/feed`, `/feed/`, `/releases.rss`
all 404).

## Conclusion (original — superseded, retained for the record)

There is no reliable, unauthenticated, CORS-enabled way to fetch "the latest
Foundry core version" from inside a running world. Building one would mean
either a proxy server (explicitly out of scope) or scraping an
uncooperative-CORS HTML page through a workaround that's brittle and likely to
break.

**v1 decision:** the target-version check falls back to comparing each
package's `compatibility.verified` (and legacy `compatibleCoreVersion`)
against the **currently running** Foundry version only (`game.release`). We do
not attempt to detect or compare against a hypothetical newer generation. This
limitation is documented in the README. If Foundry core ever exposes a public,
CORS-friendly "latest release" endpoint, this is the natural place to revisit
it — re-run the checks in this doc against the current foundryvtt.com surface
before building anything.

> The narrow claim above — that you cannot **fetch** this from foundryvtt.com
> — is still true. The conclusion drawn from it was not: fetching was never
> necessary.

## Correction (2026-08-15)

### What is actually available

Measured in a live Foundry v13.351 world, logged in as GM, with no module
network calls of any kind:

```js
game.data.coreUpdate
// {
//   hasUpdate: false,
//   canUpdate: true,
//   couldReachWebsite: true,
//   slowResponse: false,
//   version: "14.366",        // <- the latest core version. Ground truth.
//   channel: "stable",
//   willDisableModules: true
// }

game.data.systemUpdate
// { hasUpdate: true, version: "14.0.2" }   // running system was 0.30.1
```

`game.data.coreUpdate.version` is the latest available core version on the
configured update channel. It is populated because the **local Node server**
performs the license-authenticated check against foundryvtt.com and relays
the result into the client's `game.data` payload. The module never contacts
foundryvtt.com, never holds a credential, and never encounters CORS — the
data is simply already present.

Corroboration: the Foundry server log for the same session recorded
`Core software stable update 14.366 is available!`, matching the value in
`game.data.coreUpdate.version` exactly.

### Two traps in this surface

1. **`hasUpdate` is not the signal you want.** It read `false` while
   `version` read `14.366` against a running `13.351`. It appears scoped to
   the current generation — "no newer v13 build" — while `version` carries
   the absolute latest. Code that gates on `hasUpdate` would hide precisely
   the cross-generation signal this project needs. Compare
   `coreUpdate.version` against `game.release.version` directly.
2. **`couldReachWebsite` is the validity gate.** When the Foundry server
   cannot reach foundryvtt.com, this reads `false` and the version data
   should be treated as unavailable rather than authoritative. This is the
   case where peer inference is still needed.

### How the error happened

The original "What's available on the client already" section asserted that
no `game.data` field existed for the latest version. That absence was never
verified — `game.data` was not enumerated. The conclusion was reasoned
forward from a correct premise (foundryvtt.com is unreachable cross-origin)
to an incorrect one (therefore the data is unavailable), without checking
whether something else had already solved the problem.

The durable lesson: **an absence claim needs the same evidence as a presence
claim.** Enumerating `game.data` once — a single expression in a live world
— would have caught this before it shaped an ADR, a spec, the README, and
CLAUDE.md. Every later claim in this project asserting "X is not available"
should be treated as unverified until someone has actually looked.

### What this changes

- ADR-0001 is amended: `game.data.coreUpdate.version` becomes the primary
  target-version source, with peer inference (`inferredLatest`) retained as
  the fallback for when `couldReachWebsite` is `false` or the field is
  absent.
- `game.data.systemUpdate` additionally supplies the active game system's
  latest version with no manifest fetch at all — relevant to SPEC-0002,
  since the game system is one of the packages whose manifest URL is
  CORS-blocked.
- Revisit if: Foundry changes or removes the `coreUpdate` /`systemUpdate`
  payload, or scopes it away from GM clients.
