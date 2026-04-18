import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw, ExternalLink, Github, GitCommit } from "lucide-react";
import {
  githubListRemotes,
  gitPushBranch,
  gitFetch,
  gitPull,
  openUrl,
} from "../../lib/tauri";
import { useGitStore } from "../../stores/useGitStore";
import { useGithubStore } from "../../stores/useGithubStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";
import type { GitRemote, GitStatus } from "../../lib/types";

interface Props {
  repoPath: string;
  status: GitStatus;
  onOpenPublish: () => void;
  onOpenCommit: () => void;
}

function githubWebUrl(remote: GitRemote): string {
  if (remote.url.startsWith("git@github.com:")) {
    const tail = remote.url.replace("git@github.com:", "").replace(/\.git$/, "");
    return `https://github.com/${tail}`;
  }
  return remote.url.replace(/\.git$/, "");
}

export default function GitPanelGithubBar({ repoPath, status, onOpenPublish, onOpenCommit }: Props) {
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const refreshStatus = useGitStore((s) => s.refreshStatus);
  const ghStatus = useGithubStore((s) => s.status);
  const ghRefresh = useGithubStore((s) => s.refresh);

  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [busy, setBusy] = useState<null | "push" | "pull" | "fetch">(null);

  useEffect(() => {
    if (!ghStatus) void ghRefresh();
  }, [ghStatus, ghRefresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await githubListRemotes(repoPath);
        if (!cancelled) setRemotes(list);
      } catch {
        if (!cancelled) setRemotes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when branch changes (new upstream) or worktree switch.
  }, [repoPath, status.branch]);

  const githubRemote = remotes.find((r) => r.is_github) ?? null;
  const hasAnyRemote = remotes.length > 0;
  const loggedIn = ghStatus?.logged_in ?? false;
  const ghInstalled = ghStatus?.installed ?? false;

  const handlePush = async () => {
    if (!status.branch) return;
    setBusy("push");
    try {
      await gitPushBranch(repoPath, status.branch);
      await refreshStatus(repoPath);
      pushNotice({ tone: "success", title: "Pushed", message: status.branch });
    } catch (e) {
      pushNotice({ tone: "error", title: "Push failed", message: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    if (!status.branch) return;
    setBusy("pull");
    try {
      await gitPull(repoPath, status.branch);
      await refreshStatus(repoPath);
      pushNotice({ tone: "success", title: "Pulled", message: status.branch });
    } catch (e) {
      pushNotice({ tone: "error", title: "Pull failed", message: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const handleFetch = async () => {
    setBusy("fetch");
    try {
      await gitFetch(repoPath);
      await refreshStatus(repoPath);
      pushNotice({ tone: "success", title: "Fetched", message: "Remote state refreshed" });
    } catch (e) {
      pushNotice({ tone: "error", title: "Fetch failed", message: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const publishDisabledReason = (() => {
    if (!ghInstalled) return "Install GitHub CLI first (see Settings)";
    if (!loggedIn) return "Sign in to GitHub first (see Settings)";
    return null;
  })();

  return (
    <div className="git-panel__github-bar">
      <div className="git-panel__github-bar-left">
        {githubRemote ? (
          <>
            <Github size={14} className="opacity-70" />
            <span className="text-xs text-[var(--text-secondary)] truncate">
              {githubRemote.name}: {githubRemote.url.replace(/\.git$/, "").replace("git@github.com:", "").replace("https://github.com/", "")}
            </span>
            <button
              className="icon-btn"
              title="Open on GitHub"
              onClick={() => void openUrl(githubWebUrl(githubRemote))}
            >
              <ExternalLink size={13} />
            </button>
          </>
        ) : (
          <button
            className="option-card option-card--compact"
            onClick={onOpenPublish}
            disabled={publishDisabledReason !== null}
            title={publishDisabledReason ?? "Publish this repo to GitHub"}
          >
            <Github size={13} className="mr-1" />
            Publish to GitHub
          </button>
        )}
      </div>

      <div className="git-panel__github-bar-right">
        {status.dirty && (
          <button
            className="option-card option-card--compact"
            onClick={onOpenCommit}
            title={`Commit ${status.staged + status.unstaged + status.untracked} change${status.staged + status.unstaged + status.untracked === 1 ? "" : "s"}`}
          >
            <GitCommit size={13} />
            <span className="ml-1">
              Commit ({status.staged + status.unstaged + status.untracked})
            </span>
          </button>
        )}

        <button
          className="option-card option-card--compact"
          disabled={!hasAnyRemote || busy !== null}
          onClick={() => void handleFetch()}
          title="git fetch --all --prune"
        >
          <RefreshCw size={13} className={busy === "fetch" ? "animate-spin" : ""} />
          <span className="ml-1">Fetch</span>
        </button>

        <button
          className="option-card option-card--compact"
          disabled={!hasAnyRemote || status.behind === 0 || busy !== null || !status.branch}
          onClick={() => void handlePull()}
          title={status.behind > 0 ? `git pull (${status.behind} behind)` : "Up to date"}
        >
          <ArrowDown size={13} />
          <span className="ml-1">Pull{status.behind > 0 ? ` (${status.behind})` : ""}</span>
        </button>

        <button
          className="option-card option-card--compact"
          disabled={!hasAnyRemote || busy !== null || !status.branch}
          onClick={() => void handlePush()}
          title={status.ahead > 0 ? `git push (${status.ahead} ahead)` : "Nothing to push"}
        >
          <ArrowUp size={13} />
          <span className="ml-1">Push{status.ahead > 0 ? ` (${status.ahead})` : ""}</span>
        </button>
      </div>
    </div>
  );
}
