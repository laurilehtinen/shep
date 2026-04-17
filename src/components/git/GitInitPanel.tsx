import { useState } from "react";
import { GitBranchPlus } from "lucide-react";
import { gitInit, gitStageAll, gitCommit } from "../../lib/tauri";
import { useGitStore } from "../../stores/useGitStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";

interface GitInitPanelProps {
  repoPath: string;
}

type Phase = "idle" | "initializing" | "staging" | "committing";

export default function GitInitPanel({ repoPath }: GitInitPanelProps) {
  const [message, setMessage] = useState("Initial commit");
  const [phase, setPhase] = useState<Phase>("idle");
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const busy = phase !== "idle";

  const finish = async () => {
    await useGitStore.getState().refreshStatus(repoPath);
  };

  const runInit = async (): Promise<boolean> => {
    setPhase("initializing");
    try {
      await gitInit(repoPath);
      return true;
    } catch (error) {
      pushNotice({
        tone: "error",
        title: "Couldn't initialize repository",
        message: getErrorMessage(error),
      });
      setPhase("idle");
      return false;
    }
  };

  const handleInitAndCommit = async () => {
    if (busy) return;
    const trimmed = message.trim();
    if (!trimmed) {
      pushNotice({ tone: "error", title: "Commit message is required" });
      return;
    }

    if (!(await runInit())) return;

    setPhase("staging");
    try {
      await gitStageAll(repoPath);
    } catch (error) {
      pushNotice({
        tone: "error",
        title: "Repository initialized, but staging failed",
        message: getErrorMessage(error),
      });
      await finish();
      setPhase("idle");
      return;
    }

    setPhase("committing");
    try {
      await gitCommit(repoPath, trimmed);
      pushNotice({ tone: "success", title: "Repository initialized" });
    } catch (error) {
      pushNotice({
        tone: "error",
        title: "Repository initialized, but first commit failed",
        message: getErrorMessage(error),
      });
    } finally {
      await finish();
      setPhase("idle");
    }
  };

  const handleInitOnly = async () => {
    if (busy) return;
    if (!(await runInit())) return;
    pushNotice({ tone: "success", title: "Repository initialized" });
    await finish();
    setPhase("idle");
  };

  const buttonLabel = (() => {
    switch (phase) {
      case "initializing": return "Initializing…";
      case "staging":      return "Staging files…";
      case "committing":   return "Creating commit…";
      default:             return "Initialize & commit";
    }
  })();

  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <div style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14, opacity: 0.6 }}>
          <GitBranchPlus size={32} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
          Not a git repository
        </div>
        <div style={{ fontSize: 12, opacity: 0.55, lineHeight: 1.5, marginBottom: 18 }}>
          Initialize git on <span style={{ opacity: 0.8 }}>{repoPath}</span> and
          create the first commit from the current files.
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleInitAndCommit();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <input
            className="branch-dropdown__input"
            type="text"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={busy}
            style={{ padding: "6px 10px", fontSize: 12 }}
          />
          <button
            type="submit"
            className="btn-primary"
            style={{ fontSize: 12, padding: "6px 0" }}
            disabled={busy || !message.trim()}
          >
            {buttonLabel}
          </button>
        </form>

        <button
          type="button"
          onClick={() => void handleInitOnly()}
          disabled={busy}
          style={{
            marginTop: 10,
            fontSize: 11,
            opacity: busy ? 0.3 : 0.55,
            background: "none",
            border: "none",
            color: "inherit",
            cursor: busy ? "default" : "pointer",
            textDecoration: "underline",
          }}
        >
          Initialize without committing
        </button>
      </div>
    </div>
  );
}
