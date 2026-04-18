import { useEffect, useMemo, useState } from "react";
import { X, Github, Lock, Globe } from "lucide-react";
import {
  githubPublishRepo,
  githubListOrgs,
  githubListRemotes,
  gitHasHeadCommit,
} from "../../lib/tauri";
import { useGitStore } from "../../stores/useGitStore";
import { useGithubStore } from "../../stores/useGithubStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";

interface Props {
  repoPath: string;
  onClose: () => void;
}

function pathBasename(p: string): string {
  const trimmed = p.replace(/[\/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function sanitizeRepoName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export default function PublishToGitHubDialog({ repoPath, onClose }: Props) {
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const refreshStatus = useGitStore((s) => s.refreshStatus);
  const ghStatus = useGithubStore((s) => s.status);

  const defaultName = useMemo(() => sanitizeRepoName(pathBasename(repoPath)), [repoPath]);

  const [name, setName] = useState(defaultName);
  const [owner, setOwner] = useState<string>(""); // empty = default user
  const [orgs, setOrgs] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [remoteName, setRemoteName] = useState("origin");
  const [push, setPush] = useState(true);
  const [existingRemotes, setExistingRemotes] = useState<string[]>([]);
  const [hasHead, setHasHead] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load orgs + existing remotes + head-commit check. A single mount-time
  // effect — no state synchronization, just initial data fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [orgList, remotes, head] = await Promise.all([
          githubListOrgs().catch(() => [] as string[]),
          githubListRemotes(repoPath).catch(() => []),
          gitHasHeadCommit(repoPath).catch(() => false),
        ]);
        if (cancelled) return;
        setOrgs(orgList);
        const names = remotes.map((r) => r.name);
        setExistingRemotes(names);
        if (names.includes("origin")) {
          setRemoteName(names.includes("github") ? "upstream" : "github");
        }
        setHasHead(head);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // Escape-to-close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, submitting]);

  const preflightBlock: string | null = (() => {
    if (!ghStatus?.installed) return "GitHub CLI is not installed. Install gh and try again.";
    if (!ghStatus?.logged_in) return "Sign in to GitHub from Settings before publishing.";
    if (hasHead === false) return "Create at least one commit before publishing.";
    if (!name.trim()) return "Repository name is required.";
    if (existingRemotes.includes(remoteName)) {
      return `Remote "${remoteName}" already exists — choose another name.`;
    }
    return null;
  })();

  const handleSubmit = async () => {
    if (preflightBlock || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await githubPublishRepo({
        path: repoPath,
        name: name.trim(),
        owner: owner || null,
        description: description.trim() || null,
        private: visibility === "private",
        remote_name: remoteName,
        push,
      });
      await refreshStatus(repoPath);
      if (result.push_error) {
        pushNotice({
          tone: "error",
          title: "Repo created, but push failed",
          message: result.push_error,
        });
      } else {
        pushNotice({
          tone: "success",
          title: "Repository published",
          message: result.html_url,
        });
      }
      onClose();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
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
          <Github size={18} className="opacity-80" />
          <div style={{ fontSize: 13, fontWeight: 500 }}>Publish to GitHub</div>
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <label className="publish-dialog__field">
            <span className="publish-dialog__label">Owner</span>
            <select
              className="branch-dropdown__input"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              disabled={submitting}
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              <option value="">
                {ghStatus?.username ? `${ghStatus.username} (you)` : "Your account"}
              </option>
              {orgs.map((org) => (
                <option key={org} value={org}>
                  {org}
                </option>
              ))}
            </select>
          </label>

          <label className="publish-dialog__field">
            <span className="publish-dialog__label">Repository name</span>
            <input
              className="branch-dropdown__input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              autoFocus
              autoComplete="off"
              style={{ padding: "6px 10px", fontSize: 12 }}
            />
          </label>

          <label className="publish-dialog__field">
            <span className="publish-dialog__label">Description (optional)</span>
            <input
              className="branch-dropdown__input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              style={{ padding: "6px 10px", fontSize: 12 }}
            />
          </label>

          <div className="publish-dialog__field">
            <span className="publish-dialog__label">Visibility</span>
            <div className="flex gap-2">
              <button
                type="button"
                className={`option-card option-card--compact ${visibility === "private" ? "selected" : ""}`}
                onClick={() => setVisibility("private")}
                disabled={submitting}
              >
                <Lock size={13} className="mr-1" />
                Private
              </button>
              <button
                type="button"
                className={`option-card option-card--compact ${visibility === "public" ? "selected" : ""}`}
                onClick={() => setVisibility("public")}
                disabled={submitting}
              >
                <Globe size={13} className="mr-1" />
                Public
              </button>
            </div>
          </div>

          <label className="publish-dialog__field">
            <span className="publish-dialog__label">
              Remote name
              {existingRemotes.includes("origin") && remoteName !== "origin" && (
                <span className="text-xs opacity-60 ml-1">(origin already exists)</span>
              )}
            </span>
            <input
              className="branch-dropdown__input"
              type="text"
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              style={{ padding: "6px 10px", fontSize: 12 }}
            />
          </label>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={push}
              onChange={(e) => setPush(e.target.checked)}
              disabled={submitting}
            />
            Push current branch after creating
          </label>

          {(preflightBlock || error) && (
            <div className="text-xs text-red-300">{error ?? preflightBlock}</div>
          )}

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
              disabled={submitting || preflightBlock !== null}
              style={{ fontSize: 12, padding: "6px 14px" }}
            >
              {submitting ? "Publishing…" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
