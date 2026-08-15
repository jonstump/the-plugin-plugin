# Prior Art Research: Module Compatibility Checker (mcc)

Reference notes for a new Foundry VTT module-compatibility module. Describes how
`arcanistzed/mcc` worked and why it died. **No code was copied from mcc** — this
document describes mechanisms only. mcc is MIT-licensed (© 2021 arcanist).

- Repo: https://github.com/arcanistzed/mcc (archived by owner 2026-04-08, read-only)
- Verified for: Foundry v10 (minimum v9)
- Last feature release: 1.4.0 (Nov 2022). Last release: 1.4.1 (Feb 2023, dep bump only)
- Stack: Svelte + TyphonJS Runtime Library (TRL), Vite, Cloudflare Worker + KV

## Architecture

Client (Foundry module) → Cloudflare Worker → two upstream data sources.

### Client
- Hooked `renderModuleManagement` to inject a launcher button and color-code each
  row of the stock Module Management window by compatibility status.
- Main UI: sortable/filterable table of all installed packages plus the game
  system, with a pie-chart summary, "active only" toggle, and session-storage
  persistence of filters.
- Local data source: `[game.system, ...game.modules.values()]`, reading each
  package's `compatibility.verified` with fallback to the legacy
  `compatibleCoreVersion` field.
- Merge rule: for each package, take the *newer* of the locally installed
  version claim vs. the remote (worker) version claim.
- Version comparison: major-version string compare using Foundry's built-in
  `isNewerVersion` helper.

### Worker (mcc2.arcanist.workers.dev)
- Endpoint took a Foundry core version, returned merged compatibility rows.
- **Source 1 — community Google Sheets.** One spreadsheet per Foundry major
  version, spreadsheet IDs *hardcoded* for v8/v9/v10 only. These were the
  community module-testing spreadsheets where volunteers manually recorded test
  results. Fetched via Google Sheets API with a server-held API key.
- **Source 2 — official foundryvtt.com package API.** POST to
  `/_api/packages/get` (type + version), returning every package's
  `compatible_core_version`. **Required an API key** (privileged access; do not
  assume availability). Used to supplement spreadsheet rows and flag packages
  as "official" (present in the package listing).
- 10-minute cache in Cloudflare KV. CORS headers `*` (the worker existed partly
  to sidestep CORS on upstream sources).

### Status taxonomy (worth reusing conceptually)
| Code | Meaning |
|------|---------|
| X | Does not function / prevents world load |
| O | Functions with some errors |
| B | Blocked from being tested |
| G | Works without issue, or updated version available |
| N | No testing necessary |
| A | Archived — may work but unmaintained |
| U | Unknown — possibly not in official listing |
| C | Marked compatible by developer in manifest |

Note the C/G distinction: **dev-claimed** vs. **community-tested** compatibility
were treated as different signals.

## Why it died (evidence)

1. **Data source died.** The design was fully dependent on volunteers
   maintaining a per-major-version testing spreadsheet. That community effort
   faded after v10; v11 support required a new spreadsheet plus a worker
   redeploy (hardcoded IDs). No spreadsheet, no product.
2. **v11 shipped a built-in Pre-Flight Compatibility Checklist (May 2023)**,
   absorbing the core use case at the setup screen. Issue #30 requesting v11
   support (May 2023) went unanswered; development had already stalled since
   Nov 2022/Feb 2023.
3. **Operational weight.** Cloudflare Worker + KV + Google API key + privileged
   Foundry API key is heavy standing infrastructure for one volunteer's free
   module, and impossible to hand off cleanly.
4. Code aging: issue #27 (Feb 2023) reports deprecation-warning floods —
   AppV1-era UI against evolving core.
5. Repo archived by owner Apr 8, 2026.

Demand signal: open issue #31 (Jun 2023) requests exactly "check if installed
modules have versions for higher Foundry versions than currently used."

## Design implications for the new module

Do differently:
- **No server component.** Fetch each installed package's own `manifest` URL
  directly from the client. GitHub-hosted manifests (the common case) allow
  CORS. Handle non-CORS hosts gracefully ("couldn't check") instead of adding
  a proxy; add a proxy only if real-world failure rates justify it.
- **No crowdsourced data dependency.** Dev-claimed `compatibility.verified`
  from the latest published manifest is the KISS v1 signal. Label it as
  dev-claimed, not tested.
- **No hardcoded target versions.** Derive the latest Foundry version
  dynamically (research task: confirm what's fetchable client-side in the
  v13/v14 era; core's package-discovery renovation may expose new endpoints).
- **Plain ApplicationV2 + Handlebars** instead of a framework runtime (TRL/
  Svelte) that churns with each Foundry generation.

Reuse conceptually:
- `renderModuleManagement` hook to color-code the stock module list (great UX).
- Status taxonomy above, especially dev-claimed vs. verified distinction and an
  explicit "abandoned/archived" state (layer GitHub last-release-date on top as
  a v2 heuristic).
- Include game system alongside modules — the system is the biggest breakage
  risk of all.
- Graceful merge/fallback when remote data is missing.
- The community-kindness reminder ("devs are volunteers") shown in the UI.

Differentiators vs. core's built-in pre-flight check:
- Runs **in-world** where GMs live, not only at setup.
- Can notify when a previously-blocking module publishes a verified release.
- Summary framing: "N of M active modules are ready for vX; here are the
  blockers."
