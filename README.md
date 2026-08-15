# The Plugin Plugin

A Foundry VTT module that checks a GM's installed modules for update
availability and Foundry-version compatibility — **from inside the world**,
where GMs actually live.

Foundry's built-in Pre-Flight Compatibility Checklist only exists on the
setup screen, before you log into a world. GMs who stay logged in never see
it. The Plugin Plugin closes that gap: a checker table, a login notification,
and one-click bug-report snippets, all running client-side against each
package's own manifest.

## Status

Early scaffolding — no feature code yet. See [CLAUDE.md](CLAUDE.md) for the
full v1 scope and project rules.

## Important: compatibility is developer-declared, not tested

Everything this module reports comes from each package's own published
`manifest` — the `compatibility.verified` / `compatibleCoreVersion` fields
that the developer set when they cut a release. **Nothing here is
community-tested or verified by us.** A module marked "verified" for your
Foundry version means its developer declared it so, not that anyone has
confirmed it works. Treat it as a starting point for your own testing, not a
guarantee.

Module developers are volunteers, often with day jobs and limited time. A
module that hasn't been updated recently, or isn't yet verified for the
newest Foundry release, doesn't mean it's abandoned — it means nobody's
gotten to it yet. This module never labels anything "dead", "broken", or
"abandoned"; at most, "possibly unmaintained."

## Known limitation: no forward-looking version check

There is currently no reliable, unauthenticated, CORS-enabled way to detect
"the latest available Foundry core version" from inside a running world (see
[`docs/research/foundry-version-detection.md`](docs/research/foundry-version-detection.md)
for what was tried). So compatibility checks compare against the **Foundry
version you're currently running**, not a hypothetical newer generation. If
you're on an older core version, this module won't tell you whether a package
is ready for a newer one you haven't upgraded to yet.

## Installation

Manifest URL (once releases exist):

```
https://github.com/jonstump/the-plugin-plugin/releases/latest/download/module.json
```

Paste that into Foundry's **Install Module** dialog, or add it manually via
`module.json`.

## Scope

See [CLAUDE.md](CLAUDE.md) for the full v1 feature scope, status taxonomy,
and out-of-scope list (no proxy server, no crowdsourced data, no transitive
dependency expansion, no auto-updating, no setup-screen integration).

## Prior art

This module's design intentionally differs from `arcanistzed/mcc` (MIT,
archived), which relied on a Cloudflare Worker and a community-maintained
Google Sheet that died with the community effort behind it. See
[`docs/research/mcc-research.md`](docs/research/mcc-research.md) for that
history and what this module does differently (no server component, no
crowdsourced data dependency).

## License

[MIT](LICENSE)
