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

  return (
    <button
      onClick={() => useTerminalStore.getState().addPanelTab("git")}
      className={`section-toggle ${isActive ? "!text-[var(--text-primary)] !bg-white/6" : ""}`}
    >
      <span className="shrink-0" style={{ color: "var(--section-icon-color)" }}>{tabKindMeta.git.icon(14)}</span>
      <span className="truncate" title={label}>{label}</span>
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
      {isGitRepo && status.dirty && <span className="sidebar-status-dot sidebar-status-dot--attention" />}
    </button>
  );
}
