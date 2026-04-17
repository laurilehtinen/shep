import { useTerminalStore } from "../../stores/useTerminalStore";
import { panelTabId } from "../../lib/types";
import tabKindMeta from "../../lib/tabKindMeta";

export default function AgentsRow() {
  const isActive = useTerminalStore((s) => {
    const path = s.activeProjectPath;
    if (!path) return false;
    return s.projectState[path]?.activeTabId === panelTabId("agents");
  });

  return (
    <button
      onClick={() => useTerminalStore.getState().togglePanelTab("agents")}
      className={`section-toggle ${isActive ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
    >
      <span className="shrink-0 w-[14px] flex items-center justify-center" style={{ color: "var(--section-icon-color)" }}>
        {tabKindMeta.agents.icon(14)}
      </span>
      <span className="truncate">AGENTS.md</span>
    </button>
  );
}
