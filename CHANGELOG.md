# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.3.1]

### Changed

- Ended (closed) sessions are now hidden by default. Closing a session's tab removes
  it from the list instead of parking it under an "Ended" group. Set
  `claudeSessionMonitor.showEnded` to `true` to bring the old behavior back.

## [1.3.0]

### Added

- Raised core + view branch coverage to ~86% (60 tests total) with targeted edge
  cases (stalled/ended/maxAge resolution, rate vs session limit, no-cwd tooltips,
  unknown-entrypoint, candidate dedup, token-scanner truncation / no-trailing-newline
  / per-call budget / boundary backfill, corrupt-state tolerance).
- A `vscode`-mocked integration test for `extension.ts`: `activate()` wires the tree,
  webview, status bar and all 11 commands, and refresh / openSession / deactivate run
  without throwing (isolated to a temp home, no real keychain / ps / network).
- Extracted `parsePsOutput` into `src/view.ts` with its own test.

## [1.2.0]

### Added

- Expanded test suite to 41 tests (~92% statement / ~97% function coverage on the
  core + view logic). Extracted the pure UI helpers into `src/view.ts`
  (`groupOf`, `normPct`, `normResetMs`, `fmtMb`, `labelsMatch`, `parsePsOutput`) with
  their own tests, and made the IO functions dependency-injectable for testing.

### Fixed (from a second adversarial review)

- `scanTokenUsage` no longer drops a complete first usage line when a backfill window
  begins exactly on a line boundary.
- A non-error line written in the same second as a 429 no longer clears the detected
  limit, so the "Limited" state is preserved.

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
