import { useGitStore } from "../../stores/useGitStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { panelTabId } from "../../lib/types";
import tabKindMeta from "../../lib/tabKindMeta";

interface GitStatusRowProps {
  repoPath: string;
}

export default function GitStatusRow({ repoPath }: GitStatusRowProps) {
  const status = useGitStore((s) => s.projectGitStatus[repoPath]);
  const isActive = useTerminalStore((s) => {
    const path = s.activeProjectPath;
    if (!path) return false;
    return s.projectState[path]?.activeTabId === panelTabId("git");
  });

  const isGitRepo = !!status?.is_git_repo;
  const changeCount = isGitRepo ? status.staged + status.unstaged + status.untracked : 0;
  const label = isGitRepo
    ? (status.branch && status.branch !== "(detached)" ? status.branch : "Files")
    : "Files";

  // We only flag "no git" once a status has actually loaded — before that
  // `status` is undefined and we don't want to flash a warning during initial
  // git-watcher refresh. After load, status.is_git_repo is the source of truth.
  const noGit = !!status && !status.is_git_repo;
  const tooltip = noGit
    ? "Not a git repository — click to initialize"
    : label;

  return (
    <button
      onClick={() => useTerminalStore.getState().addPanelTab("git")}
      className={`section-toggle ${isActive ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
      title={tooltip}
    >
      <span className="shrink-0" style={{ color: "var(--section-icon-color)" }}>{tabKindMeta.git.icon(14)}</span>
      <span className="truncate">{label}</span>
      {noGit && (
        <span
          className="text-[10px] uppercase tracking-wide font-medium shrink-0"
          style={{ color: "var(--status-crashed)" }}
        >
          no git
        </span>
      )}
      {changeCount > 0 && (
        <span className="badge">{changeCount}</span>
      )}
      {isGitRepo && (status.ahead > 0 || status.behind > 0) && (
        <span className="badge">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.ahead > 0 && status.behind > 0 && " "}
          {status.behind > 0 && `↓${status.behind}`}
        </span>
      )}
      {noGit && (
        <span
          className="sidebar-status-dot"
          style={{ background: "var(--status-crashed)" }}
        />
      )}
      {isGitRepo && status.dirty && <span className="sidebar-status-dot sidebar-status-dot--attention" />}
    </button>
  );
}
