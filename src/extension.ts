/**
 * extension.ts — VS Code UI for the Claude Session Monitor.
 *
 * Renders all interactive Claude Code sessions in an Activity Bar sidebar,
 * grouped by live state (limit / waiting / your-turn / working), with a status
 * bar summary and toast notifications when a session needs you or hits a limit.
 *
 * All session state comes from core.ts (hook status files + transcript tails).
 */
import * as vscode from "vscode";
import * as fs from "fs";
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

function groupOf(v: SessionView): GroupKey {
  if (v.bucket === "limited") return "limited";
  if (v.bucket === "working") return "working";
  if (v.bucket === "ended") return "ended";
  if (v.bucket === "attention") {
    if (v.sub === "seni bekliyor") return "waiting";
    return "done"; // "turn bitti" / "API hatası"
  }
  return "unknown";
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
    item.description = v.detail ? `${v.sub} · ${v.detail}` : v.sub;
    item.tooltip = v.tooltip;
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
  const tree = new SessionTree();
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
  let recentCache: RecentTranscript[] = [];
  let lastRecentScan = 0;
  let lastCleanup = 0;
  let firstPaintDone = false;
  let workspaceOnlyOverride: boolean | undefined; // set by toggle command

  const cfg = () => vscode.workspace.getConfiguration("claudeSessionMonitor");
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

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

    tree.setData(views);
    updateStatusBar(statusBar, views);
    detectTransitions(views, lastSeen, firstPaintDone, c);
    firstPaintDone = true;
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
          ? "Claude Oturumları: sadece bu workspace gösteriliyor."
          : "Claude Oturumları: tüm workspace'ler gösteriliyor.",
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
      onSessionClick(v),
    ),
  );

  // Watch the monitor dir for instant hook updates; poll as the safety net.
  const debouncedRefresh = debounce(refresh, 200);
  try {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
    const w = fs.watch(MONITOR_DIR, debouncedRefresh);
    w.on("error", () => {}); // an unhandled FSWatcher 'error' would crash the host
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

  refresh(); // initial paint (seeds lastSeen without toasting)
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateStatusBar(item: vscode.StatusBarItem, views: SessionView[]): void {
  const counts = countBuckets(views);
  let waiting = 0;
  let done = 0;
  for (const v of views) {
    const g = groupOf(v);
    if (g === "waiting") waiting++;
    else if (g === "done") done++;
  }
  const segs: string[] = [];
  if (counts.working) segs.push(`$(loading~spin) ${counts.working}`);
  if (waiting) segs.push(`$(bell-dot) ${waiting}`);
  if (done) segs.push(`$(comment) ${done}`);
  if (counts.limited) segs.push(`$(error) ${counts.limited}`);

  item.text = segs.length ? `$(pulse) ${segs.join("  ")}` : "$(pulse) Claude: oturum yok";
  item.tooltip = `Claude oturumları\nçalışıyor: ${counts.working}\nseni bekliyor: ${waiting}\nturn bitti: ${done}\nlimit: ${counts.limited}\n(tıkla: paneli aç)`;

  if (counts.limited > 0) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (waiting > 0) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    item.backgroundColor = undefined;
  }
}

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

    if (!firstPaintDone) continue; // seed only, don't toast on startup
    if (prev === g) continue; // no transition

    if (g === "limited" && notifyLimited) {
      const reset = v.resetText ? ` (reset ${v.resetText})` : "";
      toast("error", `🔴 Limit: "${truncate(v.title, 48)}" — ${v.sub}${reset}`, v);
    } else if (g === "waiting" && notifyWaiting) {
      const msg = v.notifMessage ? ` — ${truncate(v.notifMessage, 60)}` : "";
      toast("warn", `🟡 Seni bekliyor: "${truncate(v.title, 48)}"${msg}`, v);
    } else if (g === "done" && notifyDone) {
      toast("info", `🔵 Turn bitti: "${truncate(v.title, 48)}"`, v);
    }
  }
  for (const id of [...lastSeen.keys()]) if (!present.has(id)) lastSeen.delete(id);
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

function onSessionClick(v: SessionView): void {
  const reset = v.resetText ? `\nlimit reset: ${v.resetText}` : "";
  vscode.window
    .showInformationMessage(`${v.title}\n${v.sub}${reset}`, "Transcript Aç")
    .then((choice) => {
      if (choice === "Transcript Aç") openTranscript(v);
    });
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
