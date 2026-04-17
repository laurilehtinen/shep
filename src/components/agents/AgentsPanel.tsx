import { useEffect, useRef, useState } from "react";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { readAgentsFile, writeAgentsFile } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/errors";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 800;

export default function AgentsPanel() {
  const activeProjectPath = useTerminalStore((s) => s.activeProjectPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const [contents, setContents] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [loading, setLoading] = useState(true);

  // lastSavedRef avoids triggering a save on the initial load (when we
  // replace state with what we just read from disk — that's not dirty).
  const lastSavedRef = useRef<string>("");
  const saveTimerRef = useRef<number | null>(null);

  // Load AGENTS.md whenever the active project changes.
  useEffect(() => {
    if (!activeProjectPath) {
      setContents("");
      lastSavedRef.current = "";
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const text = await readAgentsFile(activeProjectPath);
        if (cancelled) return;
        setContents(text);
        lastSavedRef.current = text;
        setStatus("idle");
      } catch (error) {
        if (!cancelled) {
          pushNotice({
            tone: "error",
            title: "Couldn't read AGENTS.md",
            message: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, pushNotice]);

  // Debounced auto-save. The timer is torn down on unmount OR when contents
  // change again within the window — a classic debounce pattern that needs
  // useEffect because the cleanup is what cancels the pending save.
  useEffect(() => {
    if (!activeProjectPath || loading) return;
    if (contents === lastSavedRef.current) return;

    setStatus("dirty");
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const path = activeProjectPath;
      const toSave = contents;
      setStatus("saving");
      void (async () => {
        try {
          await writeAgentsFile(path, toSave);
          // Only update the baseline if contents haven't changed since we
          // started saving — otherwise the user has already typed more and
          // the next debounce tick will pick that up.
          if (lastSavedRef.current !== toSave) {
            lastSavedRef.current = toSave;
          }
          setStatus("saved");
        } catch (error) {
          setStatus("error");
          pushNotice({
            tone: "error",
            title: "Couldn't save AGENTS.md",
            message: getErrorMessage(error),
          });
        }
      })();
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [activeProjectPath, contents, loading, pushNotice]);

  // Cmd/Ctrl+S flushes the pending save immediately.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!activeProjectPath) return;
      if (contents === lastSavedRef.current) return;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const path = activeProjectPath;
      const toSave = contents;
      setStatus("saving");
      void (async () => {
        try {
          await writeAgentsFile(path, toSave);
          lastSavedRef.current = toSave;
          setStatus("saved");
        } catch (error) {
          setStatus("error");
          pushNotice({
            tone: "error",
            title: "Couldn't save AGENTS.md",
            message: getErrorMessage(error),
          });
        }
      })();
    }
  };

  if (!activeProjectPath) {
    return (
      <div className="absolute inset-0 flex items-center justify-center opacity-50">
        Select a project to edit AGENTS.md
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", fontSize: 11, opacity: 0.7 }}
      >
        <span style={{ fontFamily: '"SF Mono", "Fira Code", monospace' }}>AGENTS.md</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span style={{ opacity: 0.55 }}>
          CLAUDE.md → AGENTS.md symlink created automatically on first save
        </span>
        <span style={{ flex: 1 }} />
        <StatusPill status={status} loading={loading} />
      </div>
      <textarea
        className="agents-editor"
        value={contents}
        onChange={(e) => setContents(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="# Project instructions for AI coding assistants&#10;&#10;Describe the project, conventions, and anything an assistant should know before making changes."
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        disabled={loading}
      />
    </div>
  );
}

function StatusPill({ status, loading }: { status: SaveStatus; loading: boolean }) {
  if (loading) {
    return <span style={{ fontSize: 11, opacity: 0.5 }}>Loading…</span>;
  }
  switch (status) {
    case "dirty":  return <span style={{ fontSize: 11, opacity: 0.55 }}>Unsaved changes…</span>;
    case "saving": return <span style={{ fontSize: 11, opacity: 0.7 }}>Saving…</span>;
    case "saved":  return <span style={{ fontSize: 11, color: "#7fd18c" }}>Saved</span>;
    case "error":  return <span style={{ fontSize: 11, color: "#f18b8b" }}>Save failed</span>;
    default:       return null;
  }
}
