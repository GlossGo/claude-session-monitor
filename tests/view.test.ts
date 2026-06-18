import { describe, it, expect } from "vitest";
import { groupOf, normPct, normResetMs, fmtMb, normLabel, labelsMatch, parsePsOutput } from "../src/view";
import type { SessionView } from "../src/core";

const v = (bucket: SessionView["bucket"], sub: string): SessionView =>
  ({ bucket, sub } as SessionView);

describe("groupOf", () => {
  it("maps buckets and attention sub-states to display groups", () => {
    expect(groupOf(v("limited", "session limit"))).toBe("limited");
    expect(groupOf(v("working", "working"))).toBe("working");
    expect(groupOf(v("ended", "ended"))).toBe("ended");
    expect(groupOf(v("attention", "waiting for you"))).toBe("waiting");
    expect(groupOf(v("attention", "your turn"))).toBe("done");
    expect(groupOf(v("attention", "API error"))).toBe("done");
    expect(groupOf(v("unknown", "unknown"))).toBe("unknown");
  });
});

describe("normPct", () => {
  it("normalizes 0-1 fractions and 0-100 percents", () => {
    expect(normPct(0.07)).toBeCloseTo(7);
    expect(normPct(25)).toBe(25);
    expect(normPct(1)).toBe(100);
    expect(normPct(0)).toBe(0);
  });
  it("returns null for non-finite/non-number", () => {
    expect(normPct(null)).toBeNull();
    expect(normPct(undefined)).toBeNull();
    expect(normPct(NaN)).toBeNull();
    expect(normPct("7")).toBeNull();
  });
});

describe("normResetMs", () => {
  it("handles epoch seconds, epoch ms, and ISO strings", () => {
    expect(normResetMs(1781830737)).toBe(1781830737000); // seconds -> ms
    expect(normResetMs(1781830737857)).toBe(1781830737857); // already ms
    expect(normResetMs("2026-06-17T23:40:00.000Z")).toBe(Date.parse("2026-06-17T23:40:00.000Z"));
  });
  it("returns null for garbage", () => {
    expect(normResetMs("nope")).toBeNull();
    expect(normResetMs(null)).toBeNull();
    expect(normResetMs(undefined)).toBeNull();
  });
});

describe("fmtMb", () => {
  it("formats MB and GB", () => {
    expect(fmtMb(240)).toBe("240MB");
    expect(fmtMb(1024)).toBe("1.0GB");
    expect(fmtMb(1536)).toBe("1.5GB");
  });
});

describe("normLabel / labelsMatch", () => {
  it("strips trailing ellipsis/dots and lowercases", () => {
    expect(normLabel("WhatsApp neden çalışmıyor…")).toBe("whatsapp neden çalışmıyor");
    expect(normLabel("Foo.")).toBe("foo");
    expect(normLabel("  Bar  ")).toBe("bar");
  });
  it("matches exact, prefix, and truncated tab labels", () => {
    expect(labelsMatch("Refactor auth", "Refactor auth")).toBe(true);
    expect(labelsMatch("Beauty service marketpl…", "Beauty service marketplace mekan")).toBe(true);
    expect(labelsMatch("Beauty service marketplace mekan", "Beauty service marketpl…")).toBe(true);
    expect(labelsMatch("Totally different", "Refactor auth")).toBe(false);
    expect(labelsMatch("", "x")).toBe(false);
  });
});

describe("parsePsOutput", () => {
  it("parses ps rows (kB->MB) and skips junk lines", () => {
    const out = "  1234  12.5  262144\n  5678   0.0   1024\ngarbage line\n  99 not-a-num xx\n";
    const m = new Map(parsePsOutput(out).map((r) => [r.pid, r]));
    expect(m.get(1234)).toEqual({ pid: 1234, cpu: 12.5, rssMb: 256 });
    expect(m.get(5678)).toEqual({ pid: 5678, cpu: 0, rssMb: 1 });
    expect(m.get(99)).toEqual({ pid: 99, cpu: 0, rssMb: 0 }); // NaN cpu/rss coerced to 0
    expect(m.size).toBe(3); // 2-token "garbage line" skipped
  });
});
