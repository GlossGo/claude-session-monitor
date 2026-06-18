/**
 * view.ts — pure (vscode-free) presentation helpers shared by the extension UI.
 * Kept separate from extension.ts so the grouping / formatting / matching logic
 * is unit-testable without a VS Code host.
 */
import type { SessionView } from "./core";

export type GroupKey = "limited" | "waiting" | "done" | "working" | "ended" | "unknown";

export interface GroupMeta {
  key: GroupKey;
  label: string;
  icon: string; // codicon id
  color: string; // ThemeColor id
}

export const GROUPS: GroupMeta[] = [
  { key: "limited", label: "Limited", icon: "error", color: "charts.red" },
  { key: "waiting", label: "Waiting for you", icon: "bell-dot", color: "charts.yellow" },
  { key: "done", label: "Your turn", icon: "comment", color: "charts.blue" },
  { key: "working", label: "Working", icon: "sync", color: "charts.green" },
  { key: "ended", label: "Ended", icon: "circle-slash", color: "disabledForeground" },
  { key: "unknown", label: "Unknown", icon: "question", color: "disabledForeground" },
];

export const GROUP_INDEX: Record<GroupKey, number> = {
  limited: 0,
  waiting: 1,
  done: 2,
  working: 3,
  ended: 4,
  unknown: 5,
};

export const NEEDS_YOU: GroupKey[] = ["limited", "waiting", "done"];

export function groupOf(v: SessionView): GroupKey {
  if (v.bucket === "limited") return "limited";
  if (v.bucket === "working") return "working";
  if (v.bucket === "ended") return "ended";
  if (v.bucket === "attention") return v.sub === "waiting for you" ? "waiting" : "done";
  return "unknown";
}

/** Utilization may arrive as a fraction (0-1) or a percent (0-100). Normalize to percent. */
export function normPct(u: unknown): number | null {
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  return u <= 1 ? u * 100 : u;
}

/** A reset timestamp may be epoch seconds, epoch ms, or an ISO string. Normalize to ms. */
export function normResetMs(r: unknown): number | null {
  if (typeof r === "number" && Number.isFinite(r)) return r < 1e12 ? r * 1000 : r;
  if (typeof r === "string") {
    const ms = Date.parse(r);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}

/** Strip trailing ellipsis/dots and lowercase, for tolerant tab-label matching. */
export function normLabel(s: string): string {
  return s.replace(/[….]+$/, "").trim().toLowerCase();
}

export function labelsMatch(tabLabel: string, title: string): boolean {
  const a = normLabel(tabLabel);
  const b = normLabel(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export interface PsRow {
  pid: number;
  cpu: number;
  rssMb: number;
}

/** Parse `ps -o pid=,pcpu=,rss=` output into rows (rss kB -> MB), skipping junk lines. */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) continue;
    const pid = parseInt(p[0], 10);
    if (!Number.isFinite(pid)) continue;
    const cpu = parseFloat(p[1]);
    const rssKb = parseInt(p[2], 10);
    rows.push({
      pid,
      cpu: Number.isFinite(cpu) ? cpu : 0,
      rssMb: Math.round((Number.isFinite(rssKb) ? rssKb : 0) / 1024),
    });
  }
  return rows;
}
