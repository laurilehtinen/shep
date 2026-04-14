import type { ProviderUsageSnapshot, UsageProvider, UsageWindowSnapshot } from "../../lib/types";

const WINDOW_PRIORITY = ["5h", "7d", "30d"];
export const ALL_USAGE_PROVIDERS: UsageProvider[] = ["claude", "codex", "gemini", "opencode", "kilo"];
export const TONE_COLORS: Record<string, string> = {
  low: "rgba(52, 211, 153, 0.75)",
  medium: "rgba(245, 158, 11, 0.75)",
  high: "rgba(251, 146, 60, 0.85)",
  critical: "rgba(248, 113, 113, 0.9)",
  local: "rgba(96, 165, 250, 0.5)",
};

export const TONE_TRACK: Record<string, string> = {
  low: "rgba(52, 211, 153, 0.1)",
  medium: "rgba(245, 158, 11, 0.1)",
  high: "rgba(251, 146, 60, 0.12)",
  critical: "rgba(248, 113, 113, 0.14)",
  local: "rgba(96, 165, 250, 0.08)",
};

export function getPrimaryWindow(snapshot: ProviderUsageSnapshot | null): UsageWindowSnapshot | null {
  if (!snapshot) return null;
  for (const window of WINDOW_PRIORITY) {
    const match = snapshot.summaryWindows.find((entry) => entry.window === window);
    if (match) return match;
  }
  return snapshot.summaryWindows[0] ?? null;
}

export function getProviderLabel(provider: UsageProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "opencode":
      return "opencode";
    case "kilo":
      return "Kilo";
  }
}

export function formatPercent(value: number | null): string {
  if (value == null) return "n/a";
  return `${Math.round(value)}%`;
}

export function formatTokenCount(value: number | null): string {
  if (value == null) return "n/a";
  if (value >= 1_000_000_000) return `${Math.round(value / 1_000_000_000)}B`;
  if (value >= 100_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${value}`;
}

export function formatCost(value: number | null): string {
  if (value == null) return "";
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value > 0) return "<$0.01";
  return "$0";
}

export function formatReset(resetAt: string | null): string {
  if (!resetAt) return "No reset";

  const millis = Number(resetAt);
  const target = Number.isFinite(millis) ? new Date(millis * 1000) : new Date(resetAt);
  if (Number.isNaN(target.getTime())) return "No reset";

  const diffMs = target.getTime() - Date.now();
  const clamped = Math.max(diffMs, 0);
  const totalMinutes = Math.floor(clamped / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function usageTone(window: UsageWindowSnapshot | null): "low" | "medium" | "high" | "critical" | "local" {
  if (!window) return "local";
  if (window.usedPercent == null) return "local";
  if (window.usedPercent >= 90) return "critical";
  if (window.usedPercent >= 75) return "high";
  if (window.usedPercent >= 50) return "medium";
  return "low";
}

// ── Pace helpers ─────────────────────────────────────────

const WINDOW_DURATIONS_MS: Record<string, number> = {
  "5h": 5 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export type PaceStatus = "under" | "on" | "over";

/**
 * Compare usage % against elapsed % of the window to determine pace.
 * Returns null if we can't compute (no reset time, no percent, or unknown window).
 */
export function computePace(w: UsageWindowSnapshot | null): { status: PaceStatus; elapsedPct: number } | null {
  if (!w || w.usedPercent == null || !w.resetAt) return null;
  const durationMs = WINDOW_DURATIONS_MS[w.window];
  if (!durationMs) return null;

  const millis = Number(w.resetAt);
  const resetTime = Number.isFinite(millis) ? millis * 1000 : new Date(w.resetAt).getTime();
  if (Number.isNaN(resetTime)) return null;

  const now = Date.now();
  const windowStart = resetTime - durationMs;
  const elapsed = now - windowStart;
  const elapsedPct = Math.min(Math.max((elapsed / durationMs) * 100, 0), 100);

  const used = w.usedPercent;
  // Give a 10% buffer around the elapsed line for "on pace"
  if (used <= elapsedPct * 0.8) return { status: "under", elapsedPct };
  if (used >= elapsedPct * 1.2) return { status: "over", elapsedPct };
  return { status: "on", elapsedPct };
}

export function paceLabel(status: PaceStatus): string {
  switch (status) {
    case "under": return "under pace";
    case "on": return "on pace";
    case "over": return "over pace";
  }
}

export function barTone(pace: ReturnType<typeof computePace>, pct: number | null | undefined): string {
  if (pct == null) return "local";
  if (pct >= 90) return "critical";
  if (pace?.status === "over") return pct >= 50 ? "high" : "medium";
  if (pct >= 75) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

/// Compute the start/end of the current billing cycle for a given cutoff day (1-28).
/// If cutoffDay is null/undefined, the cycle matches the calendar month.
export function billingCycleRange(now: Date, cutoffDay: number | null | undefined): { start: Date; end: Date } {
  const day = cutoffDay == null ? 1 : Math.min(28, Math.max(1, Math.round(cutoffDay)));
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const cycleMonthOffset = d >= day ? 0 : -1;
  const start = new Date(y, m + cycleMonthOffset, day, 0, 0, 0, 0);
  const end = new Date(y, m + cycleMonthOffset + 1, day, 0, 0, 0, 0);
  return { start, end };
}

/// Build a synthetic window showing current billing-cycle progress against the monthly budget.
/// The same percentage is used for any window (5h, 7d, 30d) — custom budgets are monthly, so
/// the bar reflects the month's spend regardless of which time window the sidebar is filtered to.
export function syntheticBudgetWindow(
  provider: UsageProvider,
  window: "5h" | "7d",
  costMonth: number | null,
  monthlyBudget: number | null,
): UsageWindowSnapshot | null {
  if (costMonth == null || monthlyBudget == null || monthlyBudget <= 0) {
    return null;
  }

  const usedPercent = (costMonth / monthlyBudget) * 100;

  return {
    provider,
    window,
    label: "monthly",
    sourceType: "local",
    confidence: "estimated",
    usedPercent,
    remainingPercent: Math.max(100 - usedPercent, 0),
    resetAt: null,
    tokenTotal: null,
    paceStatus: null,
  };
}
