# The Plugin Plugin

Foundry VTT module (id: `the-plugin-plugin`) that checks a GM's installed
modules for compatibility and updates **from inside the world**, where GMs
actually live. Foundry's built-in Pre-Flight Compatibility Checklist only
exists on the setup screen; GMs who stay logged into their world never see it.
This module closes that gap.

## Project rules

1. **Be kind to module developers.** They are volunteers. No user-facing
   language may call a module "dead", "broken", or "abandoned" — use
   "possibly unmaintained", "not yet verified", "couldn't check". The UI must
   include a visible reminder that developers are volunteers with their own
   lives, and that a module not being updated yet doesn't mean it never will
   be. This rule applies to UI strings, README, notifications, and generated
   bug-report templates.
2. **KISS.** Prefer the boring solution. No abstraction until the third use.
   No dependencies without justification.
3. **Never commit to main.** All work on feature branches, merged via PR.
4. **Dev-declared, not tested.** Never present manifest compatibility claims
   as verified-by-testing.
5. Out of scope for v1 (do not build): proxy servers, crowdsourced status
   data, transitive dependency expansion, auto-updating modules, setup-screen
   integration.

## Core v1 scope — build this and nothing more

1. **Manifest check.** For each active module (plus the game system), fetch
   the package's remote `manifest` URL from its installed manifest data
   (`game.modules`, `game.system`). Compare:
   - installed `version` vs. latest published `version` (update available?)
   - latest published `compatibility.verified` vs. the current Foundry
     version (target-version detection isn't feasible client-side — see
     [`docs/research/foundry-version-detection.md`](docs/research/foundry-version-detection.md))
   - Fall back to legacy `compatibleCoreVersion` when `compatibility` is
     absent.
   - Handle fetch failures gracefully per-module (CORS-blocked hosts, dead
     URLs): status "couldn't check", never a thrown error or a blocked scan.
   - Concurrency-limit the fetches and cache results for the session.

2. **Checker table (ApplicationV2).** GM-only window listing active packages:
   title, installed version, latest version, verified core version, status.
   Status taxonomy (keep labels kind — see rule 1):
   - Up to date & verified
   - Update available
   - Not yet verified for current/target Foundry version
   - Possibly unmaintained (see heuristic below)
   - Couldn't check
   Each row gets link-out buttons sourced from manifest fields: project page
   (`url`), report issue (`bugs`, falling back to `<url>/issues` when `url` is
   a GitHub repo), changelog (`changelog`).

3. **Pinned critical modules.** A star/pin toggle per row, stored in a
   world-scoped setting as a set of module ids. Pinned modules escalate
   notification severity. (Transitive `relationships.requires` expansion is
   v1.5 — do not build it now.)

4. **Login notification.** On `ready`, for GMs only:
   - A whispered **chat message** summarizing results, with buttons/links to
     open the checker. Persists in the chat log.
   - Additionally a `ui.notifications.warn` toast **only** when a pinned
     critical module has a problem.
   - Frequency setting: every login / daily / only when results changed
     (default: only when changed — compare a hash of results stored in a
     world setting).

5. **Copy report button.** Per-row button that copies a pre-formatted
   plain-text bug-report snippet to the clipboard: module id + version,
   Foundry version + build, game system + version, browser user agent. This
   is for pasting into GitHub issues.

### "Possibly unmaintained" heuristic (label it exactly that, never "dead")

Flag only when BOTH: the latest published manifest verifies neither the
current nor a newer Foundry generation, AND the manifest's declared version
has not changed across checks / the GitHub repo is archived (GitHub API
`archived` field, unauthenticated — respect rate limits, treat API failure as
"unknown", and only call it for packages already failing the verified check).

## Technical constraints

- Foundry v13+ target. ApplicationV2 + HandlebarsApplicationMixin for UI.
- Plain JavaScript, no framework runtime (no Svelte/React/TRL), no bundler
  unless genuinely needed — prefer zero-build esmodules loaded straight from
  `module.json`.
- No server component. No API keys. No crowdsourced data. All checks are
  client-side manifest fetches.
- Clearly label compatibility as **developer-declared** (from manifests), not
  community-tested, in the UI and README.
- Standard Foundry module layout: `module.json`, `scripts/`, `templates/`,
  `styles/`, `languages/en.json` (localize all user-facing strings from day
  one).
- GitHub release workflow: CI builds a release zip + `module.json` with a
  stable `releases/latest/download/module.json` manifest URL.

## Prior art

`arcanistzed/mcc` (MIT, archived) solved a related problem with a Cloudflare
Worker + community Google Sheets; that architecture died with its data
source — see [`docs/research/mcc-research.md`](docs/research/mcc-research.md).
Reference it for concepts only — reuse no code. Concepts worth keeping: the
`renderModuleManagement` hook to color-code the stock module list rows
(nice-to-have after core v1), the dev-claimed vs. tested distinction, and the
kindness reminder.
