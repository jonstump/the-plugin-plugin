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

The full v1 scope is implemented and merged: manifest fetching, the
compatibility classification layer, the GM-only checker table (with
pinning and copy-report), and the login notification. No tagged release
exists yet. See [CLAUDE.md](CLAUDE.md) for the full v1 scope and project
rules.

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

## How we detect a newer Foundry version

Your Foundry server already checks for core updates and hands the result to
the browser, so this module reads it straight from your running world —
no request to foundryvtt.com, no license key, nothing to configure. That
gives an authoritative "the latest Foundry version is X," not a guess.

If your server couldn't reach foundryvtt.com (offline, firewalled, or the
check failed), the module falls back to inferring a target version from your
own installed packages: actively-maintained packages, especially your game
system, tend to bump `compatibility.verified` within days of a new Foundry
release, so the highest `verified` value across everything you have
installed stands in for "a newer Foundry generation likely exists."

That fallback is an inference, not a fact. If your entire modlist is equally
behind, there's no peer signal to go on, and the check simply has nothing to
report — same as if the check didn't exist, not a false "you're all set."

See
[`docs/adrs/ADR-0001-infer-newer-foundry-version-from-installed-packages.md`](docs/adrs/ADR-0001-infer-newer-foundry-version-from-installed-packages.md)
for the reasoning, and
[`docs/research/foundry-version-detection.md`](docs/research/foundry-version-detection.md)
for what was tried. Note both documents originally concluded, incorrectly,
that the latest version was undiscoverable client-side; each now carries a
dated correction explaining what was wrong.

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
