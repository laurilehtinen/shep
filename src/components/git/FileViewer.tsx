import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { useThemeStore } from "../../stores/useThemeStore";
import {
  highlightSource,
  langForFile,
  shikiThemeFor,
  type ThemedToken,
} from "../../lib/shikiHighlighter";
import MarkdownViewer from "./MarkdownViewer";
import { isMarkdownFile } from "../../lib/markdownRenderer";
import { gitWriteFileText } from "../../lib/tauri";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";

interface FileViewerProps {
  contents: string;
  filePath: string;
  loading?: boolean;
  error?: string | null;
  /** Find-in-file term from the right-panel search. When non-empty, lines
   *  whose content contains the term (case-insensitive) get a highlight
   *  class, and the first match is scrolled into view. */
  findTerm?: string;
  /** Repo root. When present, the viewer exposes an Edit toggle that
   *  writes directly to the working tree via `git_write_file_text`. */
  repoPath?: string;
  /** Fired after a successful save so the caller can refresh git status —
   *  the file may have just flipped from clean to modified. */
  onSaved?: () => void;
}

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const SHIKI_MAX_BYTES = 200 * 1024; // 200 KB — soft cap matches backend preview limit
const SAVE_DEBOUNCE_MS = 800;

export default function FileViewer({
  contents,
  filePath,
  loading,
  error,
  findTerm = "",
  repoPath,
  onSaved,
}: FileViewerProps) {
  const theme = useThemeStore((s) => s.theme);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const lang = useMemo(() => langForFile(filePath), [filePath]);
  const markdownFile = useMemo(() => isMarkdownFile(filePath), [filePath]);
  const oversized = contents.length > SHIKI_MAX_BYTES;

  // Editor state. `editing=true` turns the view into a textarea and ignores
  // incoming `contents` updates (so the user's draft isn't clobbered by
  // watcher-driven refreshes, including those triggered by our own save).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(contents);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const lastSavedRef = useRef<string>(contents);
  const saveTimerRef = useRef<number | null>(null);

  // When the file or external contents change (file switch or FS watcher),
  // drop edit mode and re-baseline. This is a legitimate useEffect — we're
  // syncing internal state to a prop that can change from outside.
  useEffect(() => {
    if (!editing) {
      setDraft(contents);
      lastSavedRef.current = contents;
      setSaveStatus("idle");
    }
    // If editing: keep the user's draft. They exit edit mode to pick up
    // external changes, which is a rare case and the safer default.
  }, [contents, filePath, editing]);

  // Pre-compute the set of line indices that match the find term. Empty
  // term returns an empty set (no highlights). Match on raw line content
  // (not Shiki tokens) since tokens don't exist for plain text fallback.
  const matchSet = useMemo(() => {
    const s = new Set<number>();
    const needle = findTerm.trim().toLowerCase();
    if (!needle) return s;
    const lines = contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) s.add(i);
    }
    return s;
  }, [contents, findTerm]);

  // Scroll to the first match whenever the find term changes. Uses the
  // line's index-based attribute so we can find it in the DOM after a
  // token render pass. useEffect + imperative scroll is appropriate here
  // because we're integrating with the DOM (a legitimate effect use).
  useEffect(() => {
    if (matchSet.size === 0 || !scrollRef.current) return;
    const firstIdx = Math.min(...matchSet);
    const el = scrollRef.current.querySelector<HTMLDivElement>(
      `[data-line-idx="${firstIdx}"]`,
    );
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchSet]);

  // Tokenize once per (contents, file, theme) triple. Same Shiki effect
  // pattern used by DiffViewer — async external library, cancelled flag
  // guards against stale writes during rapid file/mode switches.
  useEffect(() => {
    if (!lang || !contents || oversized) {
      setTokens(null);
      return;
    }
    const shikiTheme = shikiThemeFor(theme);
    let cancelled = false;
    void (async () => {
      try {
        const result = await highlightSource(contents, lang, shikiTheme);
        if (!cancelled) setTokens(result);
      } catch {
        if (!cancelled) setTokens(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contents, lang, theme, oversized]);

  // Debounced autosave mirrors AgentsPanel's pattern. Tears down on unmount
  // OR when draft changes again within the window.
  useEffect(() => {
    if (!editing || !repoPath) return;
    if (draft === lastSavedRef.current) return;

    setSaveStatus("dirty");
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const toSave = draft;
      setSaveStatus("saving");
      void (async () => {
        try {
          await gitWriteFileText(repoPath, filePath, toSave);
          lastSavedRef.current = toSave;
          setSaveStatus("saved");
          onSaved?.();
        } catch (err) {
          setSaveStatus("error");
          pushNotice({
            tone: "error",
            title: `Couldn't save ${filePath}`,
            message: getErrorMessage(err),
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
  }, [draft, editing, repoPath, filePath, onSaved, pushNotice]);

  const flushSave = () => {
    if (!editing || !repoPath) return;
    if (draft === lastSavedRef.current) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const toSave = draft;
    setSaveStatus("saving");
    void (async () => {
      try {
        await gitWriteFileText(repoPath, filePath, toSave);
        lastSavedRef.current = toSave;
        setSaveStatus("saved");
        onSaved?.();
      } catch (err) {
        setSaveStatus("error");
        pushNotice({
          tone: "error",
          title: `Couldn't save ${filePath}`,
          message: getErrorMessage(err),
        });
      }
    })();
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      flushSave();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleExitEdit();
    }
  };

  const handleEnterEdit = () => {
    setDraft(contents);
    lastSavedRef.current = contents;
    setSaveStatus("idle");
    setEditing(true);
  };

  const handleExitEdit = () => {
    flushSave();
    setEditing(false);
  };

  if (error) {
    return (
      <div className="git-panel__diff">
        <div style={{ padding: 24, opacity: 0.55, fontSize: 12 }}>{error}</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="git-panel__diff">
        <div style={{ padding: 24, opacity: 0.45, fontSize: 12 }}>Loading…</div>
      </div>
    );
  }

  const canEdit = Boolean(repoPath) && !oversized;

  const header = canEdit ? (
    <div
      className="file-viewer__header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        fontSize: 11,
        opacity: 0.85,
      }}
    >
      <span
        style={{ fontFamily: '"SF Mono", "Fira Code", monospace', opacity: 0.75 }}
      >
        {filePath}
      </span>
      <span style={{ flex: 1 }} />
      <StatusPill status={saveStatus} />
      {editing ? (
        <button
          className="icon-btn"
          title="Done editing (Esc)"
          onClick={handleExitEdit}
        >
          <Check size={13} />
        </button>
      ) : (
        <button
          className="icon-btn"
          title="Edit this file"
          onClick={handleEnterEdit}
        >
          <Pencil size={13} />
        </button>
      )}
      {editing && (
        <button
          className="icon-btn"
          title="Discard changes since last save (Esc)"
          onClick={() => {
            setDraft(lastSavedRef.current);
            setSaveStatus("idle");
            setEditing(false);
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  ) : null;

  if (editing && canEdit) {
    return (
      <div className="file-viewer">
        {header}
        <textarea
          className="agents-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleEditorKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoFocus
        />
      </div>
    );
  }

  if (!contents) {
    return (
      <div className="file-viewer">
        {header}
        <div className="git-panel__diff">
          <div style={{ padding: 24, opacity: 0.45, fontSize: 12 }}>
            (empty file)
          </div>
        </div>
      </div>
    );
  }

  if (markdownFile) {
    return (
      <div className="file-viewer">
        {header}
        <MarkdownViewer contents={contents} />
      </div>
    );
  }

  const lines = contents.split("\n");

  return (
    <div className="file-viewer">
      {header}
      <div className="git-panel__diff" ref={scrollRef}>
        <div className="diff-content file-view">
          {lines.map((line, i) => {
            const lineTokens = tokens?.[i];
            const isMatch = matchSet.has(i);
            return (
              <div
                key={i}
                data-line-idx={i}
                className={`diff-line diff-line--context${isMatch ? " diff-line--find-match" : ""}`}
              >
                <span className="file-view__line-no">{i + 1}</span>
                {lineTokens && lineTokens.length > 0 ? (
                  lineTokens.map((t, ti) => (
                    <span key={ti} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))
                ) : (
                  <span>{line || "\u00A0"}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: SaveStatus }) {
  switch (status) {
    case "dirty":
      return <span style={{ fontSize: 11, opacity: 0.55 }}>Unsaved…</span>;
    case "saving":
      return <span style={{ fontSize: 11, opacity: 0.7 }}>Saving…</span>;
    case "saved":
      return <span style={{ fontSize: 11, color: "#7fd18c" }}>Saved</span>;
    case "error":
      return <span style={{ fontSize: 11, color: "#f18b8b" }}>Save failed</span>;
    default:
      return null;
  }
}
