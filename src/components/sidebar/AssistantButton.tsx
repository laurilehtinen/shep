import { useState, useCallback } from "react";
import type { TerminalTabData, TabActivity, UsageProvider } from "../../lib/types";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { handleActionKey } from "../../lib/a11y";
import { X } from "lucide-react";
import ContextMenu from "../shared/ContextMenu";
import type { ContextMenuItem } from "../shared/ContextMenu";

interface AssistantButtonProps {
  tab: TerminalTabData;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}

function dotClass(activity: TabActivity | undefined): string {
  if (!activity) return "sidebar-status-dot--idle";
  if (!activity.alive) return activity.exitCode === 0 ? "sidebar-status-dot--idle" : "sidebar-status-dot--exited";
  if (activity.active) return "sidebar-status-dot--active";
  return "sidebar-status-dot--idle";
}

export default function AssistantButton({
  tab,
  isActive,
  onClick,
  onClose,
}: AssistantButtonProps) {
  const logoUrl = tab.assistantId ? assistantLogoSrc[tab.assistantId] : null;
  const providerOff = useUsageSettingsStore(
    (s) => tab.assistantId != null && s.settings[tab.assistantId as UsageProvider]?.show === false,
  );
  const activity: TabActivity | undefined = useTerminalStore((s) => s.tabActivity[tab.ptyId]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const menuItems: ContextMenuItem[] = [
    {
      label: "Close",
      icon: <X size={14} />,
      danger: true,
      onClick: onClose,
    },
  ];

  return (
    <>
      <div
        className={`list-item w-full ${isActive ? "active" : ""}`}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => handleActionKey(event, onClick)}
        title={tab.label}
        role="button"
        tabIndex={0}
        aria-pressed={isActive}
        aria-label={`Open assistant tab ${tab.label}`}
      >
        {logoUrl && !providerOff && <img src={logoUrl} alt="" width={14} height={14} className={tab.assistantId ? getAssistantLogoClass(tab.assistantId) : undefined} />}
        <span className="truncate text-left">{tab.label}</span>
        <span className={`sidebar-status-dot ${dotClass(activity)}`} />
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
