import { useEffect, useState } from "react";
import { X, GitCommit } from "lucide-react";
import { gitStageAll, gitCommit } from "../../lib/tauri";
import { useGitStore } from "../../stores/useGitStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";
import type { GitStatus } from "../../lib/types";

interface Props {
  repoPath: string;
  status: GitStatus;
  onClose: () => void;
}

export default function CommitDialog({ repoPath, status, onClose }: Props) {
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const refreshStatus = useGitStore((s) => s.refreshStatus);

  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(status.staged === 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, submitting]);

  const willStage = stageAll && (status.unstaged > 0 || status.untracked > 0);
  const nothingToCommit = !willStage && status.staged === 0;

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmed = message.trim();
    if (!trimmed) {
      setError("Commit message is required.");
      return;
    }
    if (nothingToCommit) {
      setError("No staged changes. Enable \"Stage all changes\" to include unstaged files.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (willStage) await gitStageAll(repoPath);
      await gitCommit(repoPath, trimmed);
      await refreshStatus(repoPath);
      pushNotice({ tone: "success", title: "Committed", message: trimmed });
      onClose();
    } catch (e) {
      setError(getErrorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: 100 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="publish-dialog"
        style={{
          maxWidth: 460,
          width: "100%",
          background: "var(--surface-1, #1a1d24)",
          border: "1px solid var(--border, rgba(255,255,255,0.08))",
          borderRadius: 10,
          padding: 20,
          boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div className="flex items-center gap-2 mb-4">
          <GitCommit size={18} className="opacity-80" />
          <div style={{ fontSize: 13, fontWeight: 500 }}>Commit changes</div>
          <button
            type="button"
            className="icon-btn ml-auto"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="text-xs text-[var(--text-muted)] mb-3">
          {status.staged > 0 && `${status.staged} staged · `}
          {status.unstaged > 0 && `${status.unstaged} unstaged · `}
          {status.untracked > 0 && `${status.untracked} untracked · `}
          on <span className="opacity-80">{status.branch}</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <label className="publish-dialog__field">
            <span className="publish-dialog__label">Commit message</span>
            <input
              className="branch-dropdown__input"
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={submitting}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Describe the change…"
              style={{ padding: "6px 10px", fontSize: 12 }}
            />
          </label>

          {(status.unstaged > 0 || status.untracked > 0) && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={stageAll}
                onChange={(e) => setStageAll(e.target.checked)}
                disabled={submitting}
              />
              Stage all changes before committing
              <span className="opacity-50">
                ({status.unstaged + status.untracked} file
                {status.unstaged + status.untracked === 1 ? "" : "s"})
              </span>
            </label>
          )}

          {error && <div className="text-xs text-red-300">{error}</div>}

          <div className="flex gap-2 justify-end mt-2">
            <button
              type="button"
              className="option-card option-card--compact"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !message.trim() || nothingToCommit}
              style={{ fontSize: 12, padding: "6px 14px" }}
            >
              {submitting ? "Committing…" : "Commit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
