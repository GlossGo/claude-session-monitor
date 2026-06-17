# Claude Session Monitor

Live monitor for all your open Claude Code sessions (VS Code tabs) in one panel:
which is **working**, which is **waiting for you**, which **finished its turn**, and
which **hit a session/rate limit**, plus **per-session CPU/RAM** and the account
**5-hour / 7-day usage limits** charted at the bottom.

Built for working with 10-15 Claude tabs at once and seeing each one's state at a glance.

## What it shows

Activity Bar container "Claude Sessions" with two views.

### Sessions tree (grouped by live state)

| Group | Meaning |
|-------|---------|
| 🔴 **Limited** | Hit a session limit (with reset countdown) or got rate limited |
| 🟡 **Waiting for you** | Needs permission/input (Notification) |
| 🔵 **Your turn** | Finished its turn, your move |
| 🟢 **Working** | Actively running (after 2 min silent it shows "working (stalled?)") |
| ⚪ **Ended** | Session closed |

Each row also shows that session's **CPU% + RAM** (e.g. `CPU 14% · 261MB`), a 🔥 on
CPU hogs, and a live reset countdown for limited sessions. The panel header shows the
total Claude load; the Activity Bar icon carries a badge with the count of sessions
that need you.

Extras: in-VS-Code toasts + native macOS notifications on urgent transitions, a
stuck-session alert, a "needs-you only" filter (bell button), and click a row to
best-effort **jump to that session's tab** (falls back to opening the transcript).

### Usage limits (webview)

Gauges for the **5-hour** and **7-day** account limits (and 7-day Sonnet if present)
with percent used, color (green/yellow/red), a "resets in Xh Ym" countdown, and a
usage sparkline over time.

## How it works

A pure, `vscode`-free data layer (`src/core.ts`) merges three sources per session:

1. **Hook status files** `~/.claude/session-monitor/<id>.json` written by `hook.py`
   on SessionStart / UserPromptSubmit / Stop / Notification / SessionEnd. This is the
   only source of "waiting for you" (permission prompts are not in the transcript) and
   of the session's worker **PID** (captured by walking the process tree).
2. **Transcript tail** `~/.claude/projects/.../<id>.jsonl` for the title (`ai-title`),
   newest conversational state, and limit detection (`isApiErrorMessage` + 429).
   Only `entrypoint == claude-vscode | cli` sessions are shown (SDK observers/subagents
   filtered out).
3. **Usage limits** `~/.claude/session-monitor/limits.json` + `limits-history.jsonl`
   written by `statusline.sh` from Claude Code's `rate_limits` stdin (5h/7d utilization
   + reset timestamps).

The extension samples each session PID's CPU/RAM with `ps` (every ~3s).

## Install

Hook + status line (once, additive to `~/.claude/settings.json`):

```jsonc
"hooks": {
  "SessionStart":     [{ "matcher": "startup|resume|clear|compact", "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/python3 ~/.claude/session-monitor/hook.py SessionStart" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/python3 ~/.claude/session-monitor/hook.py UserPromptSubmit" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/python3 ~/.claude/session-monitor/hook.py Stop" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/python3 ~/.claude/session-monitor/hook.py Notification" }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/python3 ~/.claude/session-monitor/hook.py SessionEnd" }] }]
},
"statusLine": { "type": "command", "command": "bash ~/.claude/session-monitor/statusline.sh", "padding": 0 }
```

> The status line is required to read the 5h/7d limit budget; it also prints a compact
> `Claude  5h NN%  ·  7d NN%` line in each Claude session. Both the hooks and the status
> line are picked up after a window reload.

Extension:

```bash
npm install
npm run build
npm run package        # -> claude-session-monitor-0.3.0.vsix
code --install-extension claude-session-monitor-0.3.0.vsix
```

Reload the window (Developer: Reload Window).

## Settings (`claudeSessionMonitor.*`)

| Setting | Default | Description |
|---------|---------|-------------|
| `notifyOnWaiting` | `true` | Notify on transition to waiting-for-you |
| `notifyOnLimited` | `true` | Notify on transition to limited |
| `notifyOnDone` | `false` | Notify when a session finishes its turn |
| `nativeNotifications` | `true` | Native macOS notification on limit/waiting |
| `stuckAlertMinutes` | `5` | Alert when a working session is silent this long (0 = off) |
| `cpuHogThreshold` | `60` | CPU% above which a session is flagged 🔥 |
| `resourceSampleMs` | `3000` | CPU/RAM sampling interval |
| `pollIntervalMs` | `1500` | Status refresh interval |
| `recentScanMaxAgeHours` | `6` | Show sessions active within the last N hours |
| `hideEndedAfterMinutes` | `30` | Hide ended sessions after this long |
| `workspaceOnly` | `false` | Only show this workspace's sessions |

## Development

```bash
npm run watch     # esbuild --watch
npm run verify    # run the core data layer against real transcripts
```

## License

MIT
