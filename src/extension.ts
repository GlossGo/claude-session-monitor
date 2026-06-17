/**
 * extension.ts - VS Code UI for the Claude Session Monitor (v0.3).
 *
 * Activity Bar sidebar with two views:
 *  - a tree of all interactive Claude Code sessions grouped by live state
 *    (limited / waiting / your-turn / working / ended), each row showing
 *    CPU% + RAM, with an Activity Bar badge, toasts + native macOS
 *    notifications, a live limit-reset countdown, a stuck-session alert,
 *    a "needs-you only" filter, and click -> best-effort jump to that tab.
 *  - a webview charting the account usage limits (5-hour / 7-day) as gauges
 *    with reset countdowns plus a usage sparkline.
 *
 * Session state comes from core.ts (hook status files + transcript tails).
 * Usage-limit data comes from limits.json (written by statusline.sh).
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
  readLimits,
  readLimitsHistory,
  pruneLimitsHistory,
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
  { key: "limited", label: "Limited", icon: "error", color: "charts.red" },
  { key: "waiting", label: "Waiting for you", icon: "bell-dot", color: "charts.yellow" },
  { key: "done", label: "Your turn", icon: "comment", color: "charts.blue" },
  { key: "working", label: "Working", icon: "sync", color: "charts.green" },
  { key: "ended", label: "Ended", icon: "circle-slash", color: "disabledForeground" },
  { key: "unknown", label: "Unknown", icon: "question", color: "disabledForeground" },
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
const RES_FRESH_SEC = 12;

function groupOf(v: SessionView): GroupKey {
  if (v.bucket === "limited") return "limited";
  if (v.bucket === "working") return "working";
  if (v.bucket === "ended") return "ended";
  if (v.bucket === "attention") return v.sub === "waiting for you" ? "waiting" : "done";
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
      segs.push(`${hog ? "🔥" : ""}CPU ${Math.round(res.cpu)}% · ${res.rssMb}MB`);
    }
    item.description = segs.join(" · ");

    const resTip = res ? `\nCPU: ${Math.round(res.cpu)}%  RAM: ${res.rssMb}MB  (pid ${v.pid})` : "";
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
// Usage-limits webview
// ---------------------------------------------------------------------------

interface Gauge {
  key: string;
  label: string;
  pct: number | null;
  resetMs: number | null;
}

interface LimitsPayload {
  type: "update";
  ts: number | null;
  model: string | null;
  gauges: Gauge[];
  history: { t: number; fh: number | null; sd: number | null }[];
}

function normPct(u: unknown): number | null {
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  return u <= 1 ? u * 100 : u;
}

function normResetMs(r: unknown): number | null {
  if (typeof r === "number" && Number.isFinite(r)) return r < 1e12 ? r * 1000 : r;
  if (typeof r === "string") {
    const ms = Date.parse(r);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function buildLimitsPayload(): LimitsPayload {
  const lim = readLimits();
  const gauges: Gauge[] = [];
  if (lim) {
    gauges.push({ key: "5h", label: "5-hour", pct: normPct(lim.fh), resetMs: normResetMs(lim.fh_reset) });
    gauges.push({ key: "7d", label: "7-day", pct: normPct(lim.sd), resetMs: normResetMs(lim.sd_reset) });
    if (lim.sds != null)
      gauges.push({
        key: "7d-sonnet",
        label: "7-day (Sonnet)",
        pct: normPct(lim.sds),
        resetMs: normResetMs(lim.sds_reset),
      });
  }
  const history = readLimitsHistory(240).map((p) => ({
    t: typeof p.ts === "number" ? p.ts * 1000 : 0,
    fh: normPct(p.fh),
    sd: normPct(p.sd),
  }));
  return { type: "update", ts: lim?.ts ?? null, model: lim?.model ?? null, gauges, history };
}

class LimitsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: LimitsPayload;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = limitsHtml();
    if (this.pending) view.webview.postMessage(this.pending);
  }

  update(payload: LimitsPayload): void {
    this.pending = payload;
    this.view?.webview.postMessage(payload);
  }
}

function nonceStr(): string {
  return (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, "").slice(0, 24);
}

function limitsHtml(): string {
  const nonce = nonceStr();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 10px; }
  .empty { opacity: .65; padding: 6px 0; }
  .gauge { margin: 0 0 10px 0; }
  .grow { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:3px; }
  .glabel { font-weight:600; }
  .gpct { font-variant-numeric: tabular-nums; }
  .greset { opacity:.7; font-size:11px; }
  .bar { height:8px; border-radius:4px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.18)); overflow:hidden; }
  .fill { height:100%; border-radius:4px; transition: width .4s ease; }
  .spark { margin-top:8px; }
  .spark h4 { margin:0 0 4px 0; font-size:11px; opacity:.7; font-weight:600; }
  .legend { font-size:11px; opacity:.7; display:flex; gap:12px; margin-top:2px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:middle; }
  svg { width:100%; height:48px; display:block; }
  .foot { margin-top:8px; font-size:11px; opacity:.55; }
</style>
</head>
<body>
  <div id="root"><div class="empty">Waiting for usage-limit data… (reload the window once so the status line starts reporting)</div></div>
<script nonce="${nonce}">
const C_OK = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-green') || '#4caf50';
const C_WARN = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-yellow') || '#e6b800';
const C_BAD = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-red') || '#f14c4c';
const C_BLUE = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-blue') || '#3794ff';
let last = null;

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function color(p){ if(p==null) return 'gray'; if(p>=90) return C_BAD; if(p>=70) return C_WARN; return C_OK; }
function fmtLeft(ms){
  if(ms==null) return '';
  let s = Math.round((ms - Date.now())/1000);
  if(s<=0) return 'resets now';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if(h>0) return 'resets in '+h+'h '+m+'m';
  if(m>0) return 'resets in '+m+'m';
  return 'resets in <1m';
}
function spark(history){
  const pts = (history||[]).filter(p=>p.fh!=null || p.sd!=null);
  if(pts.length < 2) return '';
  const W=300, H=48, n=pts.length;
  const x = i => (i/(n-1))*W;
  const y = v => H - (Math.max(0,Math.min(100,v))/100)*(H-4) - 2;
  const line = (key,col) => {
    let d='', started=false;
    pts.forEach((p,i)=>{ const v=p[key]; if(v==null) return; d += (started?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1)+' '; started=true; });
    return d ? '<polyline fill="none" stroke="'+col+'" stroke-width="1.5" points="'+d.replace(/[ML]/g,' ').trim()+'"/>' : '';
  };
  return '<div class="spark"><h4>Usage over time</h4><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'
    + line('fh', C_BLUE) + line('sd', C_WARN)
    + '</svg><div class="legend"><span><span class="dot" style="background:'+C_BLUE+'"></span>5-hour</span>'
    + '<span><span class="dot" style="background:'+C_WARN+'"></span>7-day</span></div></div>';
}
function render(){
  const root = document.getElementById('root');
  if(!last || !last.gauges || !last.gauges.length || last.gauges.every(g=>g.pct==null)){
    root.innerHTML = '<div class="empty">Waiting for usage-limit data… (reload the window once so the status line starts reporting)</div>';
    return;
  }
  let h='';
  for(const g of last.gauges){
    const p = g.pct;
    const pctTxt = p==null ? '—' : Math.round(p)+'%';
    const w = p==null ? 0 : Math.max(2, Math.min(100, p));
    h += '<div class="gauge"><div class="grow"><span class="glabel">'+esc(g.label)+'</span>'
       + '<span class="gpct">'+pctTxt+'</span></div>'
       + '<div class="bar"><div class="fill" style="width:'+w+'%;background:'+color(p)+'"></div></div>'
       + '<div class="greset">'+fmtLeft(g.resetMs)+'</div></div>';
  }
  h += spark(last.history);
  if(last.model || last.ts){
    const age = last.ts ? Math.round(Date.now()/1000 - last.ts) : null;
    h += '<div class="foot">'+(last.model?esc(last.model)+' · ':'')+(age!=null? 'updated '+age+'s ago':'')+'</div>';
  }
  root.innerHTML = h;
}
window.addEventListener('message', e => { if(e.data && e.data.type==='update'){ last = e.data; render(); } });
setInterval(render, 1000); // keep countdowns live
</script>
</body>
</html>`;
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

  const limitsView = new LimitsView();
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionMonitor.limits", limitsView),
  );

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
        pruneLimitsHistory(3000);
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
    try {
      limitsView.update(buildLimitsPayload());
    } catch {
      /* ignore */
    }

    detectTransitions(views, lastSeen, firstPaintDone, c);
    if (firstPaintDone) checkStuck(views, stuckNotified, c);
    firstPaintDone = true;

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
          ? "Claude Sessions: this workspace only."
          : "Claude Sessions: all workspaces.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleNeedsYouOnly", () => {
      needsYouOnly = !needsYouOnly;
      vscode.window.showInformationMessage(
        needsYouOnly ? "Claude Sessions: needs-you only." : "Claude Sessions: all sessions.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.clearEnded", () => {
      const now = Date.now() / 1000;
      const removed = cleanupEndedMonitorFiles(now);
      vscode.window.showInformationMessage(`Claude Sessions: cleared ${removed} ended session(s).`);
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

  item.text = segs.length ? `$(pulse) ${segs.join("  ")}` : "$(pulse) Claude: no sessions";

  let totalCpu = 0;
  let totalRss = 0;
  for (const v of views) {
    const r = freshRes(v, cache);
    if (r) {
      totalCpu += r.cpu;
      totalRss += r.rssMb;
    }
  }
  const resLine = totalRss ? `\ntotal: CPU ${Math.round(totalCpu)}% · ${fmtMb(totalRss)}` : "";
  item.tooltip = `Claude sessions\nworking: ${counts.working}\nwaiting: ${waiting}\nyour turn: ${done}\nlimited: ${counts.limited}${resLine}\n(click to open the panel)`;

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
    ? { value: badge, tooltip: `${badge} session(s) waiting / limited` }
    : undefined;

  const filt = needsYouOnly ? "[needs-you only] " : "";
  treeView.message = totalRss
    ? `${filt}total load: CPU ${Math.round(totalCpu)}% · ${fmtMb(totalRss)}`
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
      toast("error", `🔴 Limited: "${truncate(v.title, 48)}" · ${v.sub}${reset}`, v);
      nativeNotify(c, "Claude: limited", `${truncate(v.title, 48)} · ${v.sub}${reset}`);
    } else if (g === "waiting" && notifyWaiting) {
      const msg = v.notifMessage ? ` · ${truncate(v.notifMessage, 60)}` : "";
      toast("warn", `🟡 Waiting: "${truncate(v.title, 48)}"${msg}`, v);
      nativeNotify(c, "Claude: waiting for you", `${truncate(v.title, 48)}${msg}`);
    } else if (g === "done" && notifyDone) {
      toast("info", `🔵 Your turn: "${truncate(v.title, 48)}"`, v);
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
          const msg = `${truncate(v.title, 48)} · ${Math.round(age / 60)}m silent`;
          vscode.window.showWarningMessage(`⚠️ Possibly stuck: ${msg}`, "Show").then((ch) => {
            if (ch === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
          });
          nativeNotify(c, "Claude: possibly stuck", msg);
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
  fn(message, "Show", "Transcript").then((choice) => {
    if (choice === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
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
        return;
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
    vscode.window.showWarningMessage("No transcript path for this session.");
    return;
  }
  vscode.workspace.openTextDocument(vscode.Uri.file(p)).then(
    (doc) => vscode.window.showTextDocument(doc, { preview: true }),
    () => vscode.window.showWarningMessage("Could not open transcript: " + p),
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
