/**
 * extension.ts — VS Code UI for the Claude Session Monitor (v0.2).
 *
 * Renders all interactive Claude Code sessions in an Activity Bar sidebar,
 * grouped by live state (limit / waiting / your-turn / working), with:
 *  - per-session CPU% + RAM (sampled via `ps` against the session worker PID),
 *  - an Activity Bar badge (count of sessions needing you),
 *  - in-VS-Code toasts + native macOS notifications on urgent transitions,
 *  - a live limit-reset countdown,
 *  - a stuck-session alert (working but silent too long),
 *  - a "only needs-you" filter,
 *  - click -> best-effort jump to that session's tab (fallback: open transcript).
 *
 * All session state comes from core.ts (hook status files + transcript tails).
 */
import * as vscode from "vscode";
import * as fs from "fs";
import { execFile } from "child_process";
import {
  collectSessions,
  countBuckets,
  findRecentTranscripts,
  cleanupMonitorFiles,
  cleanupEndedMonitorFiles,
  MONITOR_DIR,
  PROJECTS_DIR,
  DEFAULT_ENTRYPOINTS,
  type SessionView,
  type RecentTranscript,
  type TxInfo,
} from "./core";

type GroupKey = "limited" | "waiting" | "done" | "working" | "ended" | "unknown";

interface GroupMeta {
  key: GroupKey;
  label: string;
  icon: string;
  color: string;
}

const GROUPS: GroupMeta[] = [
  { key: "limited", label: "Limit", icon: "error", color: "charts.red" },
  { key: "waiting", label: "Seni bekliyor", icon: "bell-dot", color: "charts.yellow" },
  { key: "done", label: "Turn bitti (senin sıran)", icon: "comment", color: "charts.blue" },
  { key: "working", label: "Çalışıyor", icon: "sync", color: "charts.green" },
  { key: "ended", label: "Kapandı", icon: "circle-slash", color: "disabledForeground" },
  { key: "unknown", label: "Bilinmiyor", icon: "question", color: "disabledForeground" },
];

const GROUP_INDEX: Record<GroupKey, number> = {
  limited: 0,
  waiting: 1,
  done: 2,
  working: 3,
  ended: 4,
  unknown: 5,
};

const NEEDS_YOU: GroupKey[] = ["limited", "waiting", "done"];
const RES_FRESH_SEC = 12; // only show resource numbers sampled within this window

function groupOf(v: SessionView): GroupKey {
  if (v.bucket === "limited") return "limited";
  if (v.bucket === "working") return "working";
  if (v.bucket === "ended") return "ended";
  if (v.bucket === "attention") return v.sub === "seni bekliyor" ? "waiting" : "done";
  return "unknown";
}

interface ResStat {
  cpu: number;
  rssMb: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

type Node =
  | { kind: "group"; group: GroupMeta; count: number }
  | { kind: "session"; view: SessionView };

class SessionTree implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private grouped = new Map<GroupKey, SessionView[]>();

  constructor(
    private readonly res: Map<number, ResStat>,
    private readonly hogThreshold: () => number,
  ) {}

  setData(views: SessionView[]): void {
    const g = new Map<GroupKey, SessionView[]>();
    for (const v of views) {
      const k = groupOf(v);
      const arr = g.get(k) ?? [];
      arr.push(v);
      g.set(k, arr);
    }
    this.grouped = g;
    this._onDidChange.fire();
  }

  rerender(): void {
    this._onDidChange.fire();
  }

  private resOf(view: SessionView): ResStat | undefined {
    if (!view.pid) return undefined;
    const r = this.res.get(view.pid);
    if (!r) return undefined;
    if (Date.now() / 1000 - r.ts > RES_FRESH_SEC) return undefined;
    return r;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        `${node.group.label} (${node.count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(node.group.icon, new vscode.ThemeColor(node.group.color));
      item.contextValue = "group";
      return item;
    }
    const v = node.view;
    const item = new vscode.TreeItem(v.title, vscode.TreeItemCollapsibleState.None);

    const res = this.resOf(v);
    const segs = [v.sub];
    if (v.detail) segs.push(v.detail);
    if (res) {
      const hog = res.cpu >= this.hogThreshold();
      segs.push(`${hog ? "🔥" : ""}CPU %${Math.round(res.cpu)} · ${res.rssMb}MB`);
    }
    item.description = segs.join(" · ");

    const resTip = res ? `\nCPU: %${Math.round(res.cpu)}  RAM: ${res.rssMb}MB  (pid ${v.pid})` : "";
    item.tooltip = v.tooltip + resTip;
    item.contextValue = "session";
    const g = GROUPS[GROUP_INDEX[groupOf(v)]];
    item.iconPath = new vscode.ThemeIcon(
      groupOf(v) === "working" && v.stale ? "warning" : g.icon,
      new vscode.ThemeColor(g.color),
    );
    item.command = {
      command: "claudeSessionMonitor.openSession",
      title: "Open",
      arguments: [v],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const out: Node[] = [];
      for (const meta of GROUPS) {
        const arr = this.grouped.get(meta.key);
        if (arr && arr.length) out.push({ kind: "group", group: meta, count: arr.length });
      }
      return out;
    }
    if (node.kind === "group") {
      return (this.grouped.get(node.group.key) ?? []).map((view) => ({ kind: "session", view }));
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("claudeSessionMonitor");
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const resourceCache = new Map<number, ResStat>();
  const tree = new SessionTree(resourceCache, () => cfg().get<number>("cpuHogThreshold", 60));
  const treeView = vscode.window.createTreeView("claudeSessionMonitor.view", {
    treeDataProvider: tree,
    showCollapseAll: false,
  });
  ctx.subscriptions.push(treeView);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "claudeSessionMonitor.focus";
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  const txCache = new Map<string, TxInfo>();
  const lastSeen = new Map<string, GroupKey>();
  const stuckNotified = new Set<string>();
  let recentCache: RecentTranscript[] = [];
  let lastViews: SessionView[] = [];
  let lastRecentScan = 0;
  let lastCleanup = 0;
  let lastResourceSample = 0;
  let firstPaintDone = false;
  let needsYouOnly = false;
  let workspaceOnlyOverride: boolean | undefined;

  function refresh(): void {
    const now = Date.now() / 1000;
    const c = cfg();

    const maxAgeHours = c.get<number>("recentScanMaxAgeHours", 6);
    if (now - lastRecentScan > 25) {
      try {
        recentCache = findRecentTranscripts(maxAgeHours * 3600 * 1000, 120, now);
      } catch {
        /* ignore */
      }
      lastRecentScan = now;
    }

    if (now - lastCleanup > 600) {
      try {
        cleanupMonitorFiles(12 * 3600 * 1000, now);
      } catch {
        /* ignore */
      }
      lastCleanup = now;
    }

    const wsOnly =
      workspaceOnlyOverride !== undefined ? workspaceOnlyOverride : c.get<boolean>("workspaceOnly", false);

    let views: SessionView[];
    try {
      views = collectSessions({
        now,
        extraTranscripts: recentCache,
        txCache,
        allowedEntrypoints: DEFAULT_ENTRYPOINTS,
        maxAgeSec: maxAgeHours * 3600,
        hideEndedOlderThanSec: c.get<number>("hideEndedAfterMinutes", 30) * 60,
        workspaceCwd: wsOnly ? workspaceCwd() : undefined,
      });
    } catch {
      views = [];
    }

    if (needsYouOnly) views = views.filter((v) => NEEDS_YOU.includes(groupOf(v)));
    lastViews = views;

    tree.setData(views);
    updateStatusBar(statusBar, views, resourceCache);
    updateAux(treeView, views, resourceCache, needsYouOnly);

    detectTransitions(views, lastSeen, firstPaintDone, c);
    if (firstPaintDone) checkStuck(views, stuckNotified, c);
    firstPaintDone = true;

    // Sample resources for the visible session PIDs (throttled, async).
    if (now - lastResourceSample > Math.max(1000, c.get<number>("resourceSampleMs", 3000)) / 1000) {
      lastResourceSample = now;
      const pids = views.map((v) => v.pid).filter((p): p is number => !!p);
      sampleResources(pids, resourceCache, () => {
        updateStatusBar(statusBar, lastViews, resourceCache);
        updateAux(treeView, lastViews, resourceCache, needsYouOnly);
        tree.rerender();
      });
    }
  }

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand("claudeSessionMonitor.refresh", refresh),
    vscode.commands.registerCommand("claudeSessionMonitor.focus", () =>
      vscode.commands.executeCommand("workbench.view.extension.claudeSessionMonitor"),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleWorkspaceOnly", () => {
      const current =
        workspaceOnlyOverride !== undefined
          ? workspaceOnlyOverride
          : cfg().get<boolean>("workspaceOnly", false);
      workspaceOnlyOverride = !current;
      vscode.window.showInformationMessage(
        workspaceOnlyOverride
          ? "Claude Oturumları: sadece bu workspace."
          : "Claude Oturumları: tüm workspace'ler.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleNeedsYouOnly", () => {
      needsYouOnly = !needsYouOnly;
      vscode.window.showInformationMessage(
        needsYouOnly
          ? "Claude Oturumları: sadece seni bekleyenler."
          : "Claude Oturumları: tüm oturumlar.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.clearEnded", () => {
      const now = Date.now() / 1000;
      const removed = cleanupEndedMonitorFiles(now);
      vscode.window.showInformationMessage(`Claude Oturumları: ${removed} kapanan oturum temizlendi.`);
      txCache.clear();
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.openTranscript", (arg?: SessionView | Node) =>
      openTranscript(arg),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.openSession", (v: SessionView) =>
      jumpToSession(v),
    ),
  );

  // Watch the monitor dir for instant hook updates; poll as the safety net.
  const debouncedRefresh = debounce(refresh, 200);
  try {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
    const w = fs.watch(MONITOR_DIR, debouncedRefresh);
    w.on("error", () => {});
    ctx.subscriptions.push({ dispose: () => w.close() });
  } catch {
    /* polling still covers it */
  }
  try {
    const w2 = fs.watch(PROJECTS_DIR, { recursive: true }, debouncedRefresh);
    w2.on("error", () => {});
    ctx.subscriptions.push({ dispose: () => w2.close() });
  } catch {
    /* recursive watch unsupported here; polling covers it */
  }

  const pollMs = Math.max(500, cfg().get<number>("pollIntervalMs", 1500));
  const interval = setInterval(refresh, pollMs);
  ctx.subscriptions.push({ dispose: () => clearInterval(interval) });

  refresh();
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// Resource sampling
// ---------------------------------------------------------------------------

function sampleResources(pids: number[], cache: Map<number, ResStat>, done: () => void): void {
  if (!pids.length) {
    done();
    return;
  }
  const list = [...new Set(pids)].join(",");
  execFile("ps", ["-o", "pid=,pcpu=,rss=", "-p", list], { timeout: 4000 }, (err, stdout) => {
    const now = Date.now() / 1000;
    if (!err && stdout) {
      for (const line of stdout.split("\n")) {
        const p = line.trim().split(/\s+/);
        if (p.length < 3) continue;
        const pid = parseInt(p[0], 10);
        const cpu = parseFloat(p[1]);
        const rssKb = parseInt(p[2], 10);
        if (!Number.isFinite(pid)) continue;
        cache.set(pid, {
          cpu: Number.isFinite(cpu) ? cpu : 0,
          rssMb: Math.round((Number.isFinite(rssKb) ? rssKb : 0) / 1024),
          ts: now,
        });
      }
    }
    for (const [pid, v] of cache) if (now - v.ts > 60) cache.delete(pid);
    done();
  });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function freshRes(view: SessionView, cache: Map<number, ResStat>): ResStat | undefined {
  if (!view.pid) return undefined;
  const r = cache.get(view.pid);
  if (!r || Date.now() / 1000 - r.ts > RES_FRESH_SEC) return undefined;
  return r;
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  views: SessionView[],
  cache: Map<number, ResStat>,
): void {
  const counts = countBuckets(views);
  let waiting = 0;
  let done = 0;
  for (const v of views) {
    const g = groupOf(v);
    if (g === "waiting") waiting++;
    else if (g === "done") done++;
  }
  const segs: string[] = [];
  if (counts.working) segs.push(`$(sync) ${counts.working}`);
  if (waiting) segs.push(`$(bell-dot) ${waiting}`);
  if (done) segs.push(`$(comment) ${done}`);
  if (counts.limited) segs.push(`$(error) ${counts.limited}`);

  item.text = segs.length ? `$(pulse) ${segs.join("  ")}` : "$(pulse) Claude: oturum yok";

  let totalCpu = 0;
  let totalRss = 0;
  for (const v of views) {
    const r = freshRes(v, cache);
    if (r) {
      totalCpu += r.cpu;
      totalRss += r.rssMb;
    }
  }
  const resLine = totalRss ? `\ntoplam: CPU %${Math.round(totalCpu)} · ${fmtMb(totalRss)}` : "";
  item.tooltip = `Claude oturumları\nçalışıyor: ${counts.working}\nseni bekliyor: ${waiting}\nturn bitti: ${done}\nlimit: ${counts.limited}${resLine}\n(tıkla: paneli aç)`;

  if (counts.limited > 0) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (waiting > 0) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    item.backgroundColor = undefined;
  }
}

function updateAux(
  treeView: vscode.TreeView<Node>,
  views: SessionView[],
  cache: Map<number, ResStat>,
  needsYouOnly: boolean,
): void {
  let limited = 0;
  let waiting = 0;
  let totalCpu = 0;
  let totalRss = 0;
  for (const v of views) {
    const g = groupOf(v);
    if (g === "limited") limited++;
    else if (g === "waiting") waiting++;
    const r = freshRes(v, cache);
    if (r) {
      totalCpu += r.cpu;
      totalRss += r.rssMb;
    }
  }
  const badge = limited + waiting;
  treeView.badge = badge
    ? { value: badge, tooltip: `${badge} oturum seni bekliyor / limitte` }
    : undefined;

  const filt = needsYouOnly ? "[sadece seni bekleyenler] " : "";
  treeView.message = totalRss
    ? `${filt}toplam yük: CPU %${Math.round(totalCpu)} · ${fmtMb(totalRss)}`
    : filt || undefined;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function detectTransitions(
  views: SessionView[],
  lastSeen: Map<string, GroupKey>,
  firstPaintDone: boolean,
  c: vscode.WorkspaceConfiguration,
): void {
  const notifyWaiting = c.get<boolean>("notifyOnWaiting", true);
  const notifyLimited = c.get<boolean>("notifyOnLimited", true);
  const notifyDone = c.get<boolean>("notifyOnDone", false);

  const present = new Set<string>();
  for (const v of views) {
    present.add(v.sessionId);
    const g = groupOf(v);
    const prev = lastSeen.get(v.sessionId);
    lastSeen.set(v.sessionId, g);

    if (!firstPaintDone) continue;
    if (prev === g) continue;

    if (g === "limited" && notifyLimited) {
      const reset = v.resetText ? ` (reset ${v.resetText})` : "";
      toast("error", `🔴 Limit: "${truncate(v.title, 48)}" — ${v.sub}${reset}`, v);
      nativeNotify(c, "Claude: limit", `${truncate(v.title, 48)} — ${v.sub}${reset}`);
    } else if (g === "waiting" && notifyWaiting) {
      const msg = v.notifMessage ? ` — ${truncate(v.notifMessage, 60)}` : "";
      toast("warn", `🟡 Seni bekliyor: "${truncate(v.title, 48)}"${msg}`, v);
      nativeNotify(c, "Claude: seni bekliyor", `${truncate(v.title, 48)}${msg}`);
    } else if (g === "done" && notifyDone) {
      toast("info", `🔵 Turn bitti: "${truncate(v.title, 48)}"`, v);
    }
  }
  for (const id of [...lastSeen.keys()]) if (!present.has(id)) lastSeen.delete(id);
}

function checkStuck(
  views: SessionView[],
  stuckNotified: Set<string>,
  c: vscode.WorkspaceConfiguration,
): void {
  const mins = c.get<number>("stuckAlertMinutes", 5);
  if (mins <= 0) return;
  const now = Date.now() / 1000;
  const present = new Set<string>();
  for (const v of views) {
    present.add(v.sessionId);
    if (groupOf(v) === "working") {
      const age = v.lastActivityMs ? now - v.lastActivityMs / 1000 : 0;
      if (age > mins * 60) {
        if (!stuckNotified.has(v.sessionId)) {
          stuckNotified.add(v.sessionId);
          const msg = `${truncate(v.title, 48)} — ${Math.round(age / 60)}dk sessiz`;
          vscode.window.showWarningMessage(`⚠️ Takılmış olabilir: ${msg}`, "Göster").then((ch) => {
            if (ch === "Göster") vscode.commands.executeCommand("claudeSessionMonitor.focus");
          });
          nativeNotify(c, "Claude: takılmış olabilir", msg);
        }
      } else {
        stuckNotified.delete(v.sessionId);
      }
    } else {
      stuckNotified.delete(v.sessionId);
    }
  }
  for (const id of [...stuckNotified]) if (!present.has(id)) stuckNotified.delete(id);
}

function toast(level: "error" | "warn" | "info", message: string, v: SessionView): void {
  const fn =
    level === "error"
      ? vscode.window.showErrorMessage
      : level === "warn"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
  fn(message, "Göster", "Transcript").then((choice) => {
    if (choice === "Göster") vscode.commands.executeCommand("claudeSessionMonitor.focus");
    else if (choice === "Transcript") openTranscript(v);
  });
}

function nativeNotify(c: vscode.WorkspaceConfiguration, title: string, message: string): void {
  if (!c.get<boolean>("nativeNotifications", true)) return;
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/["\\]/g, " ").replace(/[\r\n]+/g, " ").slice(0, 200);
  const script = `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`;
  execFile("osascript", ["-e", script], { timeout: 4000 }, () => {});
}

// ---------------------------------------------------------------------------
// Click actions
// ---------------------------------------------------------------------------

const FOCUS_GROUP_CMDS = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

function normLabel(s: string): string {
  return s.replace(/[….]+$/, "").trim().toLowerCase();
}

function labelsMatch(tabLabel: string, title: string): boolean {
  const a = normLabel(tabLabel);
  const b = normLabel(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function jumpToSession(v: SessionView): Promise<void> {
  try {
    const groups = vscode.window.tabGroups.all;
    for (let gi = 0; gi < groups.length; gi++) {
      const tabs = groups[gi].tabs;
      const ti = tabs.findIndex((t) => t.label && labelsMatch(t.label, v.title));
      if (ti >= 0) {
        if (gi < FOCUS_GROUP_CMDS.length) {
          await vscode.commands.executeCommand(FOCUS_GROUP_CMDS[gi]);
        }
        if (ti < 9) {
          await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${ti + 1}`);
        } else {
          await vscode.commands.executeCommand("workbench.action.lastEditorInGroup");
        }
        return; // jumped
      }
    }
  } catch {
    /* fall through to transcript */
  }
  openTranscript(v);
}

function openTranscript(arg?: SessionView | Node): void {
  let p: string | undefined;
  if (arg && (arg as Node).kind === "session") p = (arg as { view: SessionView }).view.transcriptPath;
  else if (arg && (arg as SessionView).transcriptPath) p = (arg as SessionView).transcriptPath;
  if (!p) {
    vscode.window.showWarningMessage("Bu oturum için transcript yolu bulunamadı.");
    return;
  }
  vscode.workspace.openTextDocument(vscode.Uri.file(p)).then(
    (doc) => vscode.window.showTextDocument(doc, { preview: true }),
    () => vscode.window.showWarningMessage("Transcript açılamadı: " + p),
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
