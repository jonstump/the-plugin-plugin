# Research: Detecting the Latest Foundry VTT Version, Client-Side

Question: from inside a running world (browser JS, no server component, no API
keys), can we reliably determine the *latest available* Foundry VTT core
version, so the checker table can flag "verified for current, but not for the
newest generation"?

Findings as of 2026-08-15 (Foundry core is currently on the v14 generation;
v13 is the prior stable generation).

## What's available on the client already

- `game.release` (a `ReleaseData` instance) exposes version/generation/build
  info, but only for **the version currently running** — not the latest
  published release. There's no companion field anywhere in `game.data` for
  "latest available."
- Foundry's own update check (Setup screen "Check for Update") happens
  through the local Node server, which talks to foundryvtt.com using the
  world owner's **license key**. That flow isn't reachable client-side and
  requires privileged access we were told not to assume (constraint: no API
  keys).

## What was tested against foundryvtt.com directly

| Endpoint | CORS (`Access-Control-Allow-Origin`) | Usable without auth? |
|---|---|---|
| `https://foundryvtt.com/releases/` (HTML release notes index) | Not present | Fetch works at the network level but the browser blocks reading the response cross-origin — no ACAO header means `fetch()` from a world's own origin throws. |
| `https://foundryvtt.com/releases/<version>` (per-release HTML page) | Not present | Same as above. |
| `https://foundryvtt.com/_api/packages/get` (official package API mentioned in the mcc prior-art doc) | `*` (open) | No — returns `403 Forbidden` without a privileged API key, confirming the mcc doc's note that this endpoint requires privileged access. Open CORS doesn't help if the endpoint itself rejects unauthenticated requests. |
| `https://foundryvtt.com/api/status` | N/A | `404` — not a real public endpoint (this was a guess based on generic "status API" naming, ruled out). |

No RSS/JSON feed of releases exists (`/releases/feed`, `/feed/`, `/releases.rss`
all 404).

## Conclusion

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
