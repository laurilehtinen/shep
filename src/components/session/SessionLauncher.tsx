import { useState, useEffect } from "react";
import type { CodingAssistant, SessionMode, UsageProvider } from "../../lib/types";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import { checkCommandExists } from "../../lib/tauri";
import { useRepoStore } from "../../stores/useRepoStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { HandMetal } from "lucide-react";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { ASSISTANT_INSTALL_URLS } from "../sidebar/constants";

interface SessionLauncherProps {
  onStartSession: (
    assistantId: string,
    mode: SessionMode,
  ) => Promise<boolean>;
}

export default function SessionLauncher({ onStartSession }: SessionLauncherProps) {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const usageSettings = useUsageSettingsStore((s) => s.settings);

  const [selectedAssistant, setSelectedAssistant] = useState<CodingAssistant | null>(null);
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [installPopover, setInstallPopover] = useState<string | null>(null);
  const [mode, setMode] = useState<SessionMode>("standard");
  const [launching, setLaunching] = useState(false);

  // Check which assistants are installed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results: Record<string, boolean> = {};
      await Promise.all(
        CODING_ASSISTANTS.map(async (a) => {
          results[a.id] = await checkCommandExists(a.command).catch(() => false);
        }),
      );
      if (!cancelled) setAvailable(results);
    })();
    return () => { cancelled = true; };
  }, []);

  // Close install popover on outside click
  useEffect(() => {
    if (!installPopover) return;
    const handleClick = () => setInstallPopover(null);
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [installPopover]);

  const handleStart = async () => {
    if (!selectedAssistant || !activeRepoPath || launching) return;
    setLaunching(true);

    const started = await onStartSession(selectedAssistant.id, mode);
    if (!started) {
      setLaunching(false);
    }
  };

  const supportsYolo = selectedAssistant?.yoloFlag != null;

  return (
    <div className="absolute inset-0 overflow-y-auto px-1 py-4">
      <h2 className="section-label !p-0 mb-6">New AI Assistant Session</h2>

      {/* Assistant Picker */}
      <div className="mb-6">
        <label className="section-label !p-0 mb-3 block text-xs opacity-50">Assistant</label>
        <div className="flex flex-wrap gap-2">
          {CODING_ASSISTANTS
            .filter((assistant) => usageSettings[assistant.id as UsageProvider]?.show !== false)
            .map((assistant) => {
            const logoUrl = assistantLogoSrc[assistant.id];
            const isAvailable = available[assistant.id] !== false;
            const logoClassName = [getAssistantLogoClass(assistant.id), !isAvailable ? "logo-unavailable" : null]
              .filter(Boolean)
              .join(" ");
            const isSelected = selectedAssistant?.id === assistant.id;
            const installUrl = ASSISTANT_INSTALL_URLS[assistant.id];
            const showPopover = installPopover === assistant.id;
            return (
              <div key={assistant.id} className="relative">
                <button
                  className={`option-card ${isSelected ? "selected" : ""} ${!isAvailable ? "opacity-40" : ""}`}
                  onClick={() => {
                    if (isAvailable) {
                      setSelectedAssistant(assistant);
                      setInstallPopover(null);
                    } else {
                      setInstallPopover(showPopover ? null : assistant.id);
                    }
                  }}
                >
                  {logoUrl && <img src={logoUrl} alt="" width={18} height={18} className={logoClassName || undefined} />}
                  <span>{assistant.name}</span>
                </button>
                {showPopover && installUrl && (
                  <div
                    className="absolute left-0 top-full mt-2 z-50 rounded-lg p-3"
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      background: "var(--glass-panel-strong)",
                      border: "1px solid var(--glass-border-strong)",
                      backdropFilter: "blur(24px) saturate(155%)",
                      WebkitBackdropFilter: "blur(24px) saturate(155%)",
                      boxShadow: "0 14px 36px rgba(0, 0, 0, 0.28)",
                      minWidth: 200,
                    }}
                  >
                    <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
                      <strong>{assistant.name}</strong> is not installed on this system.
                    </p>
                    <code
                      className="block text-xs mt-1 px-2 py-1 rounded select-all cursor-text"
                      style={{ background: "rgba(255,255,255,0.06)", color: "rgb(122, 162, 247)" }}
                    >
                      {installUrl}
                    </code>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Mode picker */}
      {selectedAssistant && (
        <div className="mb-6">
          <label className="section-label !p-0 mb-3 block text-xs opacity-50">Mode</label>
          <div className="flex flex-wrap gap-2">
            <button
              className={`option-card ${mode === "standard" ? "selected" : ""}`}
              onClick={() => setMode("standard")}
            >
              Standard
            </button>
            <button
              className={`option-card ${mode === "yolo" ? "selected" : ""} ${!supportsYolo ? "opacity-40" : ""}`}
              onClick={() => { if (supportsYolo) setMode("yolo"); }}
              title={supportsYolo ? "Auto-accept mode" : `${selectedAssistant.name} does not support auto-accept`}
            >
              <HandMetal size={14} />
              YOLO
            </button>
          </div>
        </div>
      )}

      {/* Start Button */}
      {selectedAssistant && (
        <div>
          <label className="section-label !p-0 mb-3 block text-xs opacity-50">Start</label>
          <button
            className="btn-cta"
            disabled={launching || (mode === "yolo" && !supportsYolo)}
            aria-busy={launching}
            onClick={handleStart}
          >
            {launching ? "Starting..." : "Start Session"}
          </button>
        </div>
      )}
    </div>
  );
}
