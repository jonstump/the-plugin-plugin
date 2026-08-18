# The Plugin Plugin

Foundry VTT module (id: `the-plugin-plugin`) that checks a GM's installed
modules for compatibility and updates **from inside the world**, where GMs
actually live. Foundry's built-in Pre-Flight Compatibility Checklist only
exists on the setup screen; GMs who stay logged into their world never see it.
This module closes that gap.

## Project rules

1. **Be kind to module developers.** They are volunteers. No user-facing
   language may call a module "dead", "broken", or "abandoned" — use
   "possibly unmaintained", "not yet verified", "couldn't check", and never
   imply a developer is at fault. This half of the rule applies everywhere:
   UI strings, README, notifications, and generated bug-report templates.

   Additionally, a **visible reminder** that developers are volunteers with
   their own lives — and that a module not being updated yet doesn't mean it
   never will be — must appear in the **checker window** and the **README**.
   Amended 2026-08-16: this reminder is deliberately *not* required in the
   login notification. A reminder shown where a GM acts on the information
   carries weight; one repeated on every login becomes furniture. See
   SPEC-0001 REQ "Login Notification".
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
     version (`game.release`)
   - latest published `compatibility.verified` vs. the **target version**.
     The target comes from `game.data.coreUpdate.version`, which Foundry's
     own server populates in-world — authoritative, no credentials, no
     fetch by this module. Compare it against `game.release.version`
     directly; do **not** gate on `coreUpdate.hasUpdate`, which is scoped to
     the current generation and reads `false` even when a newer generation
     exists. When `coreUpdate.couldReachWebsite` is `false` or the payload
     is absent, fall back to `inferredLatest` —
     `max(compatibility.verified)` across every currently-installed package
     and the active game system. See
     [`docs/adrs/ADR-0001-infer-newer-foundry-version-from-installed-packages.md`](docs/adrs/ADR-0001-infer-newer-foundry-version-from-installed-packages.md)
     (amended 2026-08-15 — earlier revisions of this file and of
     [`docs/research/foundry-version-detection.md`](docs/research/foundry-version-detection.md)
     wrongly claimed no such field existed).
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
   - Verified, update unknown (compatibility passes but update availability
     couldn't be determined — most commonly a fallback-sourced result, see
     ADR-0006; never conflated with "Couldn't check")
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
     critical module has a problem. "Has a problem" means a hard-severity
     compatibility status (`compatibility.maximum` declared and below the
     comparison target) or the "possibly unmaintained" heuristic — never a
     bare `compatibility.verified` lag on its own. See
     [`docs/adrs/ADR-0002-severity-by-declared-maximum-not-just-verified-lag.md`](docs/adrs/ADR-0002-severity-by-declared-maximum-not-just-verified-lag.md).
   - Frequency setting: every login / daily / only when results changed
     (default: only when changed — compare a hash of results stored in a
     world setting).

5. **Copy report button.** Per-row button that copies a pre-formatted
   plain-text bug-report snippet to the clipboard: module id + version,
   Foundry version + build, game system + version, browser user agent. This
   is for pasting into GitHub issues.

### "Possibly unmaintained" heuristic (label it exactly that, never "dead")

Flag only when BOTH: the latest published manifest verifies neither the
current nor a newer Foundry generation, AND the GitHub repo is archived or
has had no pushed activity for at least 12 months (GitHub API `archived` and
`pushed_at` fields, read from a single unauthenticated request — respect
rate limits, treat API failure as "unknown", and only call it for packages
already failing the verified check). Activity age is measured from
`pushed_at`, never `updated_at`, and never from whether a manifest version
changed between checks — that signal fired on any two checks close together
regardless of real staleness (issue #22); see
[`docs/adrs/ADR-0004-bound-unmaintained-signal-by-repository-activity-age.md`](docs/adrs/ADR-0004-bound-unmaintained-signal-by-repository-activity-age.md).

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

## Versioning

`module.json`'s `version` field bumps as part of the branch/PR that makes
the change, not as an afterthought at release time — a branch that changes
behavior (including an experimental prototype out for real-world feedback,
like ADR-0009's mock) should leave `version` incremented when it's pushed,
same as it leaves tests updated.

While pre-1.0 (`0.x.y`), semver applies at that scale:

- **Patch** (`0.x.Y`): bug fixes, doc-only changes, anything with no
  behavior change.
- **Minor** (`0.X.0`): new functionality — including a prototype/experiment
  merged as real committed code (this project has no feature-flag
  mechanism per rule 2's KISS/no-dependencies stance, so "experimental"
  means "documented as such," not "hidden behind a flag").
- **1.0.0**: reserved for when the full v1 scope (see "Core v1 scope"
  above) is built *and* real-world validated — not just code-complete.
  "Andy says it meets his needs" is the kind of signal that moves this
  forward; a passing test suite alone is not.

A version bump in `module.json` is not the same commitment as a git tag.
Tagging (`vX.Y.Z`, triggers `.github/workflows/release.yml`) publishes a
real GitHub release and moves the `releases/latest/download/...` URLs
every installed instance of this module points at — that's an externally
visible act, reserved for versions actually meant for someone to install,
not every intermediate commit on a WIP branch. A prototype branch bumps
`version` for honest bookkeeping; it does not get tagged until it's merged
and actually ready to ship.

Once this module is accepted into Foundry's official package list, tagging
discipline gets stricter: every merge to `main` that ships a real change
should get its own tag and release rather than batching several PRs into
one, since the Setup-screen manifest URL GMs see there is exactly the kind
of "developer-declared, freshly published" data this module itself reads
from other packages (rule 4) — sloppy tagging here would be the same
failure mode this module exists to flag elsewhere.

## Prior art

`arcanistzed/mcc` (MIT, archived) solved a related problem with a Cloudflare
Worker + community Google Sheets; that architecture died with its data
source — see [`docs/research/mcc-research.md`](docs/research/mcc-research.md).
Reference it for concepts only — reuse no code. Concepts worth keeping: the
`renderModuleManagement` hook to color-code the stock module list rows
(nice-to-have after core v1), the dev-claimed vs. tested distinction, and the
kindness reminder.

## Architecture Context

This project uses the [SDD plugin](https://github.com/joestump/claude-plugin-sdd) for architecture governance.

- Architecture Decision Records are in `docs/adrs/`
- Specifications are in `docs/openspec/specs/`

### SDD Configuration

#### Tracker
- **Type**: github
- **Owner**: jonstump
- **Repo**: the-plugin-plugin

### qmd Dependency

Starting with SDD plugin v5.0.0, [qmd](https://github.com/tobi/qmd) is a hard dependency — `/sdd:init` enforces qmd presence at setup, and every qmd-aware consumer skill (`/sdd:prime`, `/sdd:check`, `/sdd:audit`, `/sdd:discover`, `/sdd:adr`, `/sdd:spec`, `/sdd:plan`, `/sdd:work`, `/sdd:review`) MAY assume qmd is installed and MUST NOT include conditional fallback paths. If a skill needs to handle "qmd installed but this repo not yet indexed", it routes to `/sdd:index` rather than silently degrading. This invariant lets every skill be designed for hybrid retrieval rather than around its absence.

### SDD Skills

| Skill | Purpose |
|-------|---------|
| `/sdd:adr` | Create a new Architecture Decision Record (ADR) using MADR format |
| `/sdd:spec` | Create a specification with requirements, scenarios, and design rationale |
| `/sdd:list` | List all architecture decisions and specs with their status |
| `/sdd:status` | Change the status of an ADR or spec (e.g., proposed to accepted, draft to review) |
| `/sdd:docs` | Generate a documentation site from your ADRs and specs |
| `/sdd:init` | Set up CLAUDE.md with SDD plugin references for architecture-aware sessions |
| `/sdd:prime` | Load ADR and spec context into the session for architecture-aware responses |
| `/sdd:check` | Quick-check code against ADRs and specs for drift |
| `/sdd:audit` | Comprehensive audit of design artifact alignment across the project |
| `/sdd:discover` | Discover implicit architectural decisions and spec-worthy subsystems in an existing codebase |
| `/sdd:plan` | Break an existing spec into trackable issues in your issue tracker |
| `/sdd:organize` | Retroactively group existing issues into tracker-native projects |
| `/sdd:enrich` | Retroactively add branch naming and PR convention sections to existing issue bodies |
| `/sdd:work` | Pick up tracker issues and implement them in parallel using git worktrees |
| `/sdd:review` | Review and merge PRs produced by /sdd:work using reviewer-responder agent pairs |
| `/sdd:graph` | Build and query the SDD artifact graph |
| `/sdd:index` | Index a repository's ADRs, OpenSpec specs, and source code into qmd collections for hybrid (BM25 + vector + reranker) semantic search |
| `/sdd:report-friction` | File a feedback issue against the SDD plugin (joestump/claude-plugin-sdd) when an agent encounters significant friction with one of its skills |
| `/sdd:respond` | Respond to review feedback on a PR — gather review comments, requested changes, and failing CI, make the code fixes on the PR branch, push, and reply to each thread explaining what was done |
| `/sdd:search` | Unified semantic exploration skill combining qmd hybrid retrieval with cgg call graph generation |

Run `/sdd:prime [topic]` at the start of a session to load relevant ADRs and specs into context.

### Governing Comments

When implementing code governed by ADRs or specs, leave comments referencing the governing artifacts:

```
// Governing: ADR-0001 (chose JWT over sessions), SPEC-0003 REQ "Token Validation"
```

These comments help future sessions (and `/sdd:check`) trace implementation back to decisions.

### Workflow

1. **Decide**: `/sdd:adr` — record the architectural decision
2. **Specify**: `/sdd:spec` — formalize requirements with RFC 2119 language
3. **Plan**: `/sdd:plan` — break the spec into trackable issues in your tracker
4. **Enrich**: `/sdd:organize` and `/sdd:enrich` — add projects and branch conventions
5. **Build**: `/sdd:work` — pick up issues and implement in parallel using git worktrees
6. **Review**: `/sdd:review` — review and merge PRs with spec-aware code review
7. **Validate**: `/sdd:check` and `/sdd:audit` to catch drift

### Session Coordination

When orchestrating multiple SDD plugin skills in a single session (e.g., running `/sdd:work` on several issues), use `TeamCreate` to coordinate agents. Do not spawn ad-hoc background agents for work that requires coordination — `SendMessage` only works within a Team, and isolated agents cannot see sibling file claims or type creations.
