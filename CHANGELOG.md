# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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
