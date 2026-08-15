# Changelog

## Unreleased

- Repo scaffold: `module.json`, project rules (`CLAUDE.md`), README, MIT
  license, CI release workflow, and the Foundry-version-detection research
  doc.
- Manifest fetching: per-package remote manifest fetch with concurrency
  limiting, per-package error isolation, and session caching (#11).
- Compatibility classification layer: inferred-latest-version signal,
  hard/soft severity split, and the "possibly unmaintained" heuristic
  (#12).
- Login notification: whispered GM chat summary on `ready`, with a
  pinned-module warning toast and a configurable notification frequency
  (#13).
- GM-only checker table window (ApplicationV2): status table, pin/star
  toggles for critical modules, link-out buttons, and the copy-report
  button (#14).
- Test coverage for the checker table's Handlebars template and GM-only
  visibility gate (#15).
