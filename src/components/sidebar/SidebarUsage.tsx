import { useMemo } from "react";
import { useUsageStore, type TimeWindow } from "../../stores/useUsageStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUIStore } from "../../stores/useUIStore";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import {
  ALL_USAGE_PROVIDERS,
  TONE_COLORS,
  TONE_TRACK,
  barTone,
  formatPercent,
  formatTokenCount,
  formatCost,
  computePace,
  syntheticBudgetWindow,
} from "../usage/usageHelpers";
const WINDOWS: { key: TimeWindow; label: string }[] = [
  { key: "5h", label: "5h" },
  { key: "7d", label: "7d" },
];

export default function SidebarUsage() {
  const snapshots = useUsageStore((s) => s.snapshots);
  const window = useUsageStore((s) => s.window);
  const usageSettings = useUsageSettingsStore((s) => s.settings);
  const { setWindow } = useUsageStore.getState();
  const { toggleUsagePanel } = useUIStore.getState();

  const providers = useMemo(() => ALL_USAGE_PROVIDERS.filter((p) => usageSettings[p].show), [usageSettings]);

  const hasData = Object.keys(snapshots).length > 0;
  if (!hasData || providers.length === 0) return null;

  return (
    <div className="sidebar-usage">
      <div className="sidebar-usage__header">
        <div className="section-label !p-0">Usage</div>
        <div className="sidebar-usage__window-toggle">
          {WINDOWS.map((tw) => (
            <button
              key={tw.key}
              type="button"
              className={`sidebar-usage__window-btn ${window === tw.key ? "sidebar-usage__window-btn--active" : ""}`}
              onClick={() => setWindow(tw.key)}
            >
              {tw.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-usage__providers">
        {providers.map((provider) => {
          const snapshot = snapshots[provider] ?? null;
          if (!snapshot) return null;

          const local = snapshot.localDetails;
          const budgetWindow = window === "5h" || window === "7d" ? window : null;
          const providerConfig = usageSettings[provider];
          const syntheticWindow = providerConfig.budgetMode === "custom"
            && budgetWindow
            ? syntheticBudgetWindow(
                provider,
                budgetWindow,
                local?.costMonth ?? null,
                providerConfig.monthlyBudget,
              )
            : null;
          // For providers with 24h quota windows (Gemini), pick the most-used tier
          const quota24h = providerConfig.budgetMode === "subscription"
            ? snapshot.summaryWindows
                .filter((sw) => sw.window.startsWith("24h_") && sw.usedPercent != null)
                .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0] ?? null
            : null;
          const providerWindow = snapshot.summaryWindows.find((sw) => sw.window === window && sw.usedPercent != null)
            ?? quota24h;
          const w = providerWindow ?? syntheticWindow ?? snapshot.summaryWindows.find((sw) => sw.window === window) ?? null;
          const pct = w?.usedPercent;
          const hasPercent = pct != null;
          const clampedPct = hasPercent ? Math.min(pct, 100) : 0;

          const pace = computePace(w);
          const tone = barTone(pace, pct);

          const tokens = local
            ? window === "5h" ? local.tokens5h : window === "7d" ? local.tokens7d : local.tokens30d
            : w?.tokenTotal ?? null;
          const cost = local
            ? window === "5h" ? local.cost5h : window === "7d" ? local.cost7d : local.cost30d
            : null;

          const logoSrc = assistantLogoSrc[provider];

          return (
            <button
              key={provider}
              type="button"
              className="sidebar-usage__row"
              onClick={toggleUsagePanel}
            >
              {logoSrc ? (
                <img src={logoSrc} alt={provider} className={`sidebar-usage__icon ${getAssistantLogoClass(provider) ?? ""}`} />
              ) : (
                <span className="sidebar-usage__name">{provider}</span>
              )}

              <div className="sidebar-usage__bar-wrap">
                <div className="sidebar-usage__bar">
                  <div
                    className="sidebar-usage__bar-track"
                    style={{ background: TONE_TRACK[tone] }}
                  />
                  <div
                    className="sidebar-usage__bar-fill"
                    style={{
                      width: `${clampedPct}%`,
                      background: TONE_COLORS[tone],
                    }}
                  />
                  {pace && pct != null && pct > 0 && (
                    <div
                      className="sidebar-usage__bar-pace"
                      style={{ left: `${Math.min(pace.elapsedPct, 100)}%` }}
                      title={`${Math.round(pace.elapsedPct)}% of window elapsed`}
                    />
                  )}
                </div>
              </div>

              <span className="sidebar-usage__value">
                {hasPercent ? formatPercent(pct) : ""}
              </span>
              <span className="sidebar-usage__cost">
                {cost != null && cost > 0 ? formatCost(cost) : ""}
              </span>
              <span className="sidebar-usage__tokens">
                {tokens != null && tokens > 0 ? formatTokenCount(tokens) : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
