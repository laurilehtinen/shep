import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, X, PanelLeft, PanelLeftOpen } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useGitStore } from "../../stores/useGitStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitPanelStore } from "../../stores/useGitPanelStore";
import {
  gitChangedFiles, gitFileDiff, gitFileContents, gitListFiles,
} from "../../lib/tauri";
import type { ChangedFile } from "../../lib/types";
import FileList from "./FileList";
import FileTree from "./FileTree";
import DiffViewer from "./DiffViewer";
import FileViewer from "./FileViewer";
import GitInitPanel from "./GitInitPanel";
import GitPanelGithubBar from "./GitPanelGithubBar";
import PublishToGitHubDialog from "./PublishToGitHubDialog";
import CommitDialog from "./CommitDialog";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";

type PanelMode = "diffs" | "files";
const PANEL_MODE_KEY = "shep:gitPanelMode";

export default function GitPanel() {
  const activeProjectPath = useTerminalStore((s) => s.activeProjectPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const gitStatus = useGitStore(
    (s) => activeProjectPath ? s.projectGitStatus[activeProjectPath] ?? null : null,
  );
  const refreshStatus = useGitStore((s) => s.refreshStatus);

  // Persistent per-repo UI state lives in useGitPanelStore so it survives
  // GitPanel unmounts (switching tabs or navigating away and back).
  const panelState = useGitPanelStore((s) =>
    activeProjectPath ? s.perRepo[activeProjectPath] ?? null : null,
  );
  const selectedPath = panelState?.diffsSelectedPath ?? null;
  const selectedArea = panelState?.diffsSelectedArea ?? null;
  const repoSelectedPath = panelState?.repoSelectedPath ?? null;
  const repoExpanded = panelState?.repoExpanded ?? [];
  const leftSearch = panelState?.leftSearch ?? "";
  const sidebarCollapsed = panelState?.sidebarCollapsed ?? false;

  // Transient local state — reset on every mount, no need to persist.
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [diffContent, setDiffContent] = useState<string>("");
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [repoFileContent, setRepoFileContent] = useState<string>("");
  const [repoFileError, setRepoFileError] = useState<string | null>(null);
  const [repoFileLoading, setRepoFileLoading] = useState<boolean>(false);

  // Panel mode persists via localStorage, with backwards compat for the
  // old "repo" value (renamed to "files" in the UI).
  const [panelMode, setPanelMode] = useState<PanelMode>(() => {
    const stored = localStorage.getItem(PANEL_MODE_KEY);
    return stored === "files" || stored === "repo" ? "files" : "diffs";
  });

  const [publishOpen, setPublishOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);

  // A single unified search term (`leftSearch`, persisted in the panel
  // store) drives both the sidebar file filter AND the in-viewer
  // find-in-file highlight. The header control can collapse visually,
  // but the underlying term stays unified.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(() => leftSearch.trim().length > 0);

  const canLoadGitFiles = !!activeProjectPath && !!gitStatus?.is_git_repo;

  // ── Diffs mode: fetch changed files ───────────────────────────────
  const fetchFiles = useCallback(async () => {
    if (!canLoadGitFiles || !activeProjectPath) {
      setFiles([]);
      return;
    }
    try {
      const result = await gitChangedFiles(activeProjectPath);
      setFiles(result);
    } catch (error) {
      setFiles([]);
      pushNotice({ tone: "error", title: "Couldn't load changed files", message: getErrorMessage(error) });
    }
  }, [canLoadGitFiles, activeProjectPath, pushNotice]);

  const statusKey = gitStatus
    ? `${gitStatus.staged}:${gitStatus.unstaged}:${gitStatus.untracked}`
    : "";
  useEffect(() => { fetchFiles(); }, [fetchFiles, statusKey]);

  // ── Diffs mode: fetch diff content on selection change ─────────────
  useEffect(() => {
    if (!activeProjectPath || !selectedPath || !selectedArea) {
      setDiffContent("");
      return;
    }
    const repo = activeProjectPath;
    const path = selectedPath;
    const staged = selectedArea === "staged";

    let cancelled = false;
    setDiffContent("");
    void (async () => {
      try {
        const diff = await gitFileDiff(repo, path, staged);
        if (!cancelled) setDiffContent(diff);
      } catch (error) {
        if (!cancelled) {
          pushNotice({
            tone: "error",
            title: "Couldn't load diff",
            message: getErrorMessage(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, selectedPath, selectedArea, pushNotice]);

  // ── Diffs mode: watcher refresh for the open diff ──────────────────
  useEffect(() => {
    if (!activeProjectPath || !selectedPath || !selectedArea) return;
    const repo = activeProjectPath;
    const path = selectedPath;
    const staged = selectedArea === "staged";

    const unlistenPromise = listen<{ paths: string[] }>("git-fs-changed", async (event) => {
      if (!event.payload.paths.includes(repo)) return;
      try {
        const diff = await gitFileDiff(repo, path, staged);
        setDiffContent(diff);
      } catch {
        // File may have been committed away — silent ignore.
      }
    });
    return () => {
      unlistenPromise.then((f) => f());
    };
  }, [activeProjectPath, selectedPath, selectedArea]);

  // ── Files mode: fetch repo file list ───────────────────────────────
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath) {
      setRepoFiles([]);
      return;
    }
    const repo = activeProjectPath;
    let cancelled = false;
    void (async () => {
      try {
        const result = await gitListFiles(repo);
        if (!cancelled) setRepoFiles(result);
      } catch (error) {
        if (!cancelled) {
          setRepoFiles([]);
          pushNotice({
            tone: "error",
            title: "Couldn't list repo files",
            message: getErrorMessage(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canLoadGitFiles, activeProjectPath, pushNotice]);

  // ── Files mode: watcher refresh for the repo file list ────────────
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath) return;
    const repo = activeProjectPath;
    const unlistenPromise = listen<{ paths: string[] }>("git-fs-changed", async (event) => {
      if (!event.payload.paths.includes(repo)) return;
      try {
        const result = await gitListFiles(repo);
        setRepoFiles(result);
      } catch {
        // Silent — initial fetch already pushed an error notice if needed.
      }
    });
    return () => {
      unlistenPromise.then((f) => f());
    };
  }, [canLoadGitFiles, activeProjectPath]);

  // ── Files mode: fetch file contents on selection change ────────────
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath || !repoSelectedPath) {
      setRepoFileContent("");
      setRepoFileError(null);
      setRepoFileLoading(false);
      return;
    }
    const repo = activeProjectPath;
    const path = repoSelectedPath;
    let cancelled = false;
    setRepoFileContent("");
    setRepoFileError(null);
    setRepoFileLoading(true);
    void (async () => {
      try {
        const content = await gitFileContents(repo, path, "working");
        if (!cancelled) setRepoFileContent(content);
      } catch (error) {
        if (!cancelled) setRepoFileError(getErrorMessage(error));
      } finally {
        if (!cancelled) setRepoFileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canLoadGitFiles, activeProjectPath, repoSelectedPath]);

  // ── Files mode: watcher refresh for the open file contents ────────
  useEffect(() => {
    if (!canLoadGitFiles || !activeProjectPath || !repoSelectedPath) return;
    const repo = activeProjectPath;
    const path = repoSelectedPath;
    const unlistenPromise = listen<{ paths: string[] }>("git-fs-changed", async (event) => {
      if (!event.payload.paths.includes(repo)) return;
      try {
        const content = await gitFileContents(repo, path, "working");
        setRepoFileContent(content);
        setRepoFileError(null);
      } catch (error) {
        setRepoFileError(getErrorMessage(error));
      }
    });
    return () => {
      unlistenPromise.then((f) => f());
    };
  }, [canLoadGitFiles, activeProjectPath, repoSelectedPath]);

  // Cmd+F (or Ctrl+F) focuses the always-visible unified search input.
  // Listener is only bound while GitPanel is mounted.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (leftSearch.trim()) setSearchOpen(true);
  }, [leftSearch]);

  useEffect(() => {
    if (!searchOpen) return;
    const id = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [searchOpen]);

  const handleSelect = useCallback(
    (file: ChangedFile) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setDiffsSelection(
        activeProjectPath,
        file.path,
        file.area,
        file.status,
      );
    },
    [activeProjectPath],
  );

  const handleSetPanelMode = useCallback((mode: PanelMode) => {
    setPanelMode(mode);
    localStorage.setItem(PANEL_MODE_KEY, mode);
  }, []);

  const handleSetLeftSearch = useCallback(
    (value: string) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setLeftSearch(activeProjectPath, value);
    },
    [activeProjectPath],
  );

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback(() => {
    handleSetLeftSearch("");
    setSearchOpen(false);
  }, [handleSetLeftSearch]);

  const handleRepoSelect = useCallback(
    (path: string) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setRepoSelection(activeProjectPath, path);
    },
    [activeProjectPath],
  );

  const handleRepoExpandedChange = useCallback(
    (expanded: string[]) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setRepoExpanded(activeProjectPath, expanded);
    },
    [activeProjectPath],
  );

  const handleSetSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      if (!activeProjectPath) return;
      useGitPanelStore.getState().setSidebarCollapsed(activeProjectPath, collapsed);
    },
    [activeProjectPath],
  );

  // Classify each changed file into "added" (new: status A or ?) or
  // "modified" (everything else) for the repo-browser tree coloring.
  // Also build a set of untracked paths (status ?) so the tree can dim
  // their names to signal "not tracked by git yet".
  const changedPathsMap = useMemo(() => {
    const m = new Map<string, "added" | "modified">();
    for (const f of files) {
      const kind: "added" | "modified" =
        f.status === "A" || f.status === "?" ? "added" : "modified";
      m.set(f.path, kind);
    }
    return m;
  }, [files]);

  const untrackedPaths = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      if (f.status === "?") s.add(f.path);
    }
    return s;
  }, [files]);

  // Filter the changed files list for FileList based on the same lifted
  // leftSearch term. Empty search returns all files.
  const filteredFiles = useMemo(() => {
    if (!leftSearch.trim()) return files;
    const needle = leftSearch.trim().toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(needle));
  }, [files, leftSearch]);

  const preferredDiffFiles = useMemo(() => {
    const priority = (area: string) => {
      if (area === "unstaged" || area === "untracked") return 2;
      if (area === "staged") return 1;
      return 0;
    };

    const byPath = new Map<string, ChangedFile>();
    for (const file of filteredFiles) {
      const current = byPath.get(file.path);
      if (!current || priority(file.area) > priority(current.area)) {
        byPath.set(file.path, file);
      }
    }

    return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [filteredFiles]);

  useEffect(() => {
    if (!activeProjectPath || panelMode !== "diffs") return;

    const currentValid = preferredDiffFiles.some(
      (file) => file.path === selectedPath && file.area === selectedArea,
    );

    if (currentValid) return;

    const fallback =
      preferredDiffFiles.find((file) => file.path === selectedPath)
      ?? preferredDiffFiles[0]
      ?? null;
    if (!fallback) return;

    useGitPanelStore.getState().setDiffsSelection(
      activeProjectPath,
      fallback.path,
      fallback.area,
      fallback.status,
    );
  }, [activeProjectPath, panelMode, preferredDiffFiles, selectedArea, selectedPath]);

  useEffect(() => {
    if (!activeProjectPath || panelMode !== "files") return;
    if (!repoSelectedPath) return;

    const currentValid = repoFiles.includes(repoSelectedPath);
    if (currentValid) return;

    useGitPanelStore.getState().setRepoSelection(activeProjectPath, null);
  }, [activeProjectPath, panelMode, repoFiles, repoSelectedPath]);

  if (!activeProjectPath) {
    return (
      <div className="absolute inset-0 flex items-center justify-center opacity-50">
        Select a project to view git status
      </div>
    );
  }

  if (!gitStatus?.is_git_repo) {
    return <GitInitPanel repoPath={activeProjectPath} />;
  }

  return (
    <div className="git-panel">
      <GitPanelGithubBar
        repoPath={activeProjectPath}
        status={gitStatus}
        onOpenPublish={() => setPublishOpen(true)}
        onOpenCommit={() => setCommitOpen(true)}
      />
      {publishOpen && (
        <PublishToGitHubDialog
          repoPath={activeProjectPath}
          onClose={() => setPublishOpen(false)}
        />
      )}
      {commitOpen && (
        <CommitDialog
          repoPath={activeProjectPath}
          status={gitStatus}
          onClose={() => setCommitOpen(false)}
        />
      )}
      <div className="git-panel__body">
        {!sidebarCollapsed && (
          <div className="git-panel__sidebar">
            {panelMode === "files" ? (
              <FileTree
                files={repoFiles}
                changedPaths={changedPathsMap}
                untrackedPaths={untrackedPaths}
                search={leftSearch}
                selectedPath={repoSelectedPath}
                onSelect={handleRepoSelect}
                expandedPaths={repoExpanded}
                onExpandedChange={handleRepoExpandedChange}
              />
            ) : (
              <FileList
                files={preferredDiffFiles}
                search={leftSearch}
                selectedPath={selectedPath}
                onSelect={handleSelect}
              />
            )}
          </div>
        )}

        <div className={`git-panel__viewer-area${sidebarCollapsed ? " git-panel__viewer-area--wide" : ""}`}>
          <div className="git-panel__viewer-controls">
            <div className={`git-panel__header-search-shell${searchOpen ? " git-panel__header-search-shell--open" : ""}`}>
              {searchOpen ? (
                <div className="git-panel__header-search">
                  <Search size={12} className="git-panel__search-icon" />
                  <input
                    ref={searchInputRef}
                    className="git-panel__search-input"
                    type="text"
                    placeholder="Search files, filter diffs…"
                    value={leftSearch}
                    onChange={(e) => handleSetLeftSearch(e.target.value)}
                    onBlur={() => {
                      if (!leftSearch.trim()) setSearchOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        if (leftSearch) handleSetLeftSearch("");
                        else setSearchOpen(false);
                      }
                    }}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  {(leftSearch || searchOpen) && (
                    <button
                      className="icon-btn git-panel__search-clear"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (leftSearch) {
                          handleSetLeftSearch("");
                          searchInputRef.current?.focus();
                        } else {
                          handleCloseSearch();
                        }
                      }}
                      title={leftSearch ? "Clear (Esc)" : "Close search"}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  className="git-panel__search-trigger"
                  onClick={handleOpenSearch}
                  title="Search (Cmd/Ctrl+F)"
                  aria-label="Search"
                >
                  <Search size={15} className="git-panel__search-trigger-icon" />
                </button>
              )}
            </div>
            <button
              className="git-panel__pane-toggle"
              onClick={() => handleSetSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? "Show files panel" : "Hide files panel"}
              aria-label={sidebarCollapsed ? "Show files panel" : "Hide files panel"}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeft size={16} />}
            </button>
            <div className="view-toggle" role="tablist" aria-label="Panel mode">
              <button
                role="tab"
                aria-selected={panelMode === "files"}
                className={`view-toggle__btn${panelMode === "files" ? " view-toggle__btn--active" : ""}`}
                onClick={() => handleSetPanelMode("files")}
              >
                Files
              </button>
              <button
                role="tab"
                aria-selected={panelMode === "diffs"}
                className={`view-toggle__btn${panelMode === "diffs" ? " view-toggle__btn--active" : ""}`}
                onClick={() => handleSetPanelMode("diffs")}
              >
                Diffs
              </button>
            </div>
          </div>
          {/* Viewer content — mode-switched. */}
          {panelMode === "files" ? (
            repoSelectedPath ? (
              <FileViewer
                key={repoSelectedPath}
                contents={repoFileContent}
                filePath={repoSelectedPath}
                loading={repoFileLoading}
                error={repoFileError}
                findTerm={leftSearch}
                repoPath={activeProjectPath ?? undefined}
                onSaved={() => {
                  if (activeProjectPath) void refreshStatus(activeProjectPath);
                }}
              />
            ) : (
              <div className="git-panel__diff">
                <div style={{ padding: 24, opacity: 0.35, fontSize: 12 }}>
                  Select a file to view
                </div>
              </div>
            )
          ) : selectedPath ? (
            <DiffViewer
              key={selectedPath}
              diff={diffContent}
              filePath={selectedPath}
              findTerm={leftSearch}
            />
          ) : (
            <div className="git-panel__diff">
              <div style={{ padding: 24, opacity: 0.35, fontSize: 12 }}>
                Select a file to view
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
