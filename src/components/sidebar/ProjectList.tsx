import { useEffect, useMemo, useState } from "react";
import type { RepoInfo, CommandState, TerminalTabData } from "../../lib/types";
import { open } from "@tauri-apps/plugin-dialog";
import tabKindMeta from "../../lib/tabKindMeta";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useGitStore } from "../../stores/useGitStore";
import ProjectItem from "./ProjectItem";
import CollapsibleSection from "./CollapsibleSection";
import AssistantList from "./AssistantList";
import TerminalList from "./TerminalList";
import CommandsRow from "./CommandsRow";
import AgentsRow from "./AgentsRow";
import GitStatusRow from "./GitStatusRow";

interface ProjectListProps {
  repos: RepoInfo[];
  activeRepoPath: string | null;
  activeTabId: string | null;
  commands: CommandState[];
  projectActivity: Record<string, { terminalCount: number; runningCount: number; hasAttention: boolean; hasCrash: boolean }>;
  onSelectRepo: (repoPath: string) => void;
  onAddProject: (repoPath: string) => void;
  onRemoveProject: (repoPath: string) => void;
  onNewAssistant: () => void;
  onOpenInEditor: (repoPath: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewShell: () => void;
}

export default function ProjectList({
  repos,
  activeRepoPath,
  activeTabId,
  commands,
  projectActivity,
  onSelectRepo,
  onAddProject,
  onRemoveProject,
  onNewAssistant,
  onOpenInEditor,
  onSelectTab,
  onCloseTab,
  onNewShell,
}: ProjectListProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(activeRepoPath ? [activeRepoPath] : []),
  );

  useEffect(() => {
    if (!activeRepoPath) return;
    setExpandedPaths((prev) => {
      if (prev.has(activeRepoPath)) return prev;
      return new Set(prev).add(activeRepoPath);
    });
  }, [activeRepoPath]);

  const handleProjectClick = (repoPath: string) => {
    if (repoPath === activeRepoPath) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(repoPath)) next.delete(repoPath);
        else next.add(repoPath);
        return next;
      });
    } else {
      onSelectRepo(repoPath);
    }
  };

  const handleAddClick = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select project folder",
    });
    if (selected) {
      onAddProject(selected);
    }
  };

  // Get tabs for the active project (stable ref from store)
  const projectTabs = useTerminalStore(
    (s) => activeRepoPath ? s.projectState[activeRepoPath]?.tabs ?? null : null,
  );

  const assistantTabs = useMemo(() => {
    if (!projectTabs) return [];
    return projectTabs.filter((t): t is TerminalTabData => t.kind === "assistant");
  }, [projectTabs]);

  const shellTabs = useMemo(() => {
    if (!projectTabs) return [];
    return projectTabs.filter((t): t is TerminalTabData => t.kind === "terminal");
  }, [projectTabs]);

  const commandsBadge = commands.length > 0 ? String(commands.length) : null;
  const gitStatuses = useGitStore((s) => s.projectGitStatus);
  const sortedRepos = useMemo(() => {
    return [...repos].sort((a, b) => {
      const aWorktreeParent = gitStatuses[a.path]?.worktree_parent ?? null;
      const bWorktreeParent = gitStatuses[b.path]?.worktree_parent ?? null;

      const aGroup = aWorktreeParent ?? a.name;
      const bGroup = bWorktreeParent ?? b.name;
      const groupCompare = aGroup.localeCompare(bGroup);
      if (groupCompare !== 0) return groupCompare;

      if (aWorktreeParent == null && bWorktreeParent != null) return -1;
      if (aWorktreeParent != null && bWorktreeParent == null) return 1;

      return a.name.localeCompare(b.name);
    });
  }, [repos, gitStatuses]);

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-2">
      {sortedRepos.map((repo) => {
        const isActive = repo.path === activeRepoPath;
        const isExpanded = isActive && expandedPaths.has(repo.path);
        const worktreeParent = gitStatuses[repo.path]?.worktree_parent ?? null;
        return (
          <div key={repo.path}>
            <ProjectItem
              repo={repo}
              isActive={isActive}
              isExpanded={isExpanded}
              activity={projectActivity[repo.path]}
              worktreeParent={worktreeParent}
              onOpenInEditor={() => onOpenInEditor(repo.path)}
              onRemove={() => onRemoveProject(repo.path)}
              onClick={() => handleProjectClick(repo.path)}
              onAddProject={onAddProject}
            />
            {isExpanded && (
              <div className="mt-1 mb-2 flex flex-col gap-0.5 pl-2">
                <CollapsibleSection
                  label={tabKindMeta.assistant.label + "s"}
                  icon={tabKindMeta.assistant.icon(14)}
                  badge={assistantTabs.length || null}
                  hasItems={assistantTabs.length > 0}
                  onAdd={onNewAssistant}
                >
                  <AssistantList
                    assistantTabs={assistantTabs}
                    activeTabId={activeTabId}
                    onSelectTab={onSelectTab}
                    onCloseTab={onCloseTab}
                  />
                </CollapsibleSection>

                <CollapsibleSection
                  label={tabKindMeta.terminal.label + "s"}
                  icon={tabKindMeta.terminal.icon(14)}
                  badge={shellTabs.length || null}
                  hasItems={shellTabs.length > 0}
                  onAdd={onNewShell}
                >
                  <TerminalList
                    tabs={shellTabs}
                    activeTabId={activeTabId}
                    onSelectTab={onSelectTab}
                    onCloseTab={onCloseTab}
                  />
                </CollapsibleSection>

                <CommandsRow badge={commandsBadge} />
                <AgentsRow />
                <GitStatusRow repoPath={repo.path} />
              </div>
            )}
          </div>
        );
      })}
      <button className="btn-ghost w-full mt-1" onClick={handleAddClick}>
        <span>+</span>
        <span>Add Project</span>
      </button>
    </div>
  );
}
