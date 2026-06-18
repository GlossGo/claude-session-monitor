# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.1.0]

### Added

- A vitest unit-test suite (22 tests) for the core data layer, and a CI step that
  runs typecheck + tests on every push.

### Fixed (from an adversarial review)

- **Token scanner**: bounded per-file reads (no out-of-memory on a large delta), the
  offset now always advances (no infinite re-read loop), and offsets advance by
  byte length so multi-byte UTF-8 no longer drifts/double-counts.
- **Resume sweep**: self-chained with `setTimeout` so a slow step can no longer
  overlap and type into the wrong tab; it re-verifies the active tab and that VS Code
  is frontmost immediately before typing.
- **Keychain read** is now async (`execFile`), so it no longer blocks the extension
  host for up to 5s every 90s.
- **Atomic writes** (temp + rename) for the token offsets/buckets and limits history,
  and `readJson` now rejects a truncated `null`/array so a partial write can't crash
  or double-count the scan.

## [1.0.1]

### Fixed

- Official usage gauges going stale ("updated Nh ago"): replaced the Node
  `https.request` call (which intermittently timed out in the extension host and
  threw an internal `reading 'req'` error on destroy) with the global `fetch` API and
  an abort timeout. Usage now refreshes reliably every ~90s.
- Hardened tree rendering with a per-item guard and added a debug log
  (`~/.claude/session-monitor/csm-debug.log`) for diagnosis.

## [1.0.0]

First public release.

### Added

- Activity Bar panel listing every interactive Claude Code session, grouped by live
  state: Limited / Waiting for you / Your turn / Working / Ended.
- Per-session CPU% and RAM, a total-load summary, and a 🔥 flag for CPU hogs.
- Official **Session (5h)** and **Weekly (7d)** usage gauges (% used, % left, reset
  countdown) via `api.anthropic.com/api/oauth/usage`, plus a rolling token-usage
  trend with an hourly chart.
- In-VS-Code toasts and native macOS notifications on limit/waiting transitions.
- Stuck-session alert for working sessions that go silent.
- Staggered **Resume All** that auto-types resume across sessions one per minute to
  avoid hitting the rate limit after an outage.
- Activity Bar badge, "needs-you only" filter, click-to-jump to a session's tab, and
  clear/remove of ended sessions.
- One-command hook installer (`scripts/install.sh`).
