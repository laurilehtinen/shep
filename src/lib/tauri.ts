import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  RepoInfo,
  RegisteredRepo,
  WorkspaceConfig,
  PtyColorTheme,
  PtyOutput,
  GitStatus,
  ChangedFile,
  CreatedWorktree,
  EditorSettings,
  KeybindingSettings,
  TerminalSettings,
  FontFamily,
  FontFaceData,
  PreferredEditor,
  ProviderUsageSnapshot,
  LocalUsageDetails,
  UsageSettings,
  UsageOverview,
  PortInfo,
  GhAuthStatus,
  GitRemote,
  PublishRepoArgs,
  PublishRepoResult,
} from "./types";

// ── Workspace commands ──────────────────────────────────────────────

export function listRepos(): Promise<RepoInfo[]> {
  return invoke("list_repos");
}

export function registerRepo(repoPath: string): Promise<RegisteredRepo> {
  return invoke("register_repo", { repoPath });
}

export function unregisterRepo(repoPath: string): Promise<void> {
  return invoke("unregister_repo", { repoPath });
}

export function loadWorkspace(repoPath: string): Promise<WorkspaceConfig> {
  return invoke("load_workspace", { repoPath });
}

export function saveWorkspace(
  repoPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  return invoke("save_workspace", { repoPath, config });
}

export function getEditorSettings(): Promise<EditorSettings> {
  return invoke("get_editor_settings");
}

export function saveEditorSettings(settings: EditorSettings): Promise<void> {
  return invoke("save_editor_settings", { settings });
}

export function getKeybindingSettings(): Promise<KeybindingSettings> {
  return invoke("get_keybinding_settings");
}

export function saveKeybindingSettings(settings: KeybindingSettings): Promise<void> {
  return invoke("save_keybinding_settings", { settings });
}

export function getTerminalSettings(): Promise<TerminalSettings> {
  return invoke("get_terminal_settings");
}

export function saveTerminalSettings(settings: TerminalSettings): Promise<void> {
  return invoke("save_terminal_settings", { settings });
}

export function listMonospaceFamilies(): Promise<FontFamily[]> {
  return invoke("list_monospace_families");
}

export function loadFontFamily(family: string): Promise<FontFaceData[]> {
  return invoke("load_font_family", { family });
}

export function openInEditor(
  repoPath: string,
  editorOverride?: PreferredEditor | null,
): Promise<void> {
  return invoke("open_in_editor", {
    repoPath,
    editorOverride: editorOverride ?? null,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

// ── PTY commands ────────────────────────────────────────────────────

export function spawnPty(
  command: string,
  cwd: string,
  env: Record<string, string>,
  cols: number,
  rows: number,
  colorTheme: PtyColorTheme,
  onMessage: (msg: PtyOutput) => void,
): Promise<number> {
  const channel = new Channel<PtyOutput>();
  channel.onmessage = onMessage;
  return invoke("spawn_pty", {
    command,
    cwd,
    env,
    cols,
    rows,
    colorTheme,
    onData: channel,
  });
}

export function writePty(ptyId: number, data: string): Promise<void> {
  return invoke("write_pty", { ptyId, data });
}

export function updatePtyColorTheme(colorTheme: PtyColorTheme): Promise<void> {
  return invoke("update_pty_color_theme", { colorTheme });
}

export function resizePty(
  ptyId: number,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_pty", { ptyId, cols, rows });
}

export function killPty(ptyId: number): Promise<void> {
  return invoke("kill_pty", { ptyId });
}

// ── App lifecycle commands ────────────────────────────────────────

export function shutdownAndQuit(): Promise<void> {
  return invoke("shutdown_and_quit");
}

// ── File watcher commands ─────────────────────────────────────────

export function watchRepo(path: string): Promise<void> {
  return invoke("watch_repo", { path });
}

export function unwatchRepo(path: string): Promise<void> {
  return invoke("unwatch_repo", { path });
}

// ── Git commands ──────────────────────────────────────────────────

export function isGitRepo(path: string): Promise<boolean> {
  return invoke("is_git_repo", { path });
}

export function gitInit(path: string): Promise<void> {
  return invoke("git_init", { path });
}

export function gitCurrentBranch(path: string): Promise<string> {
  return invoke("git_current_branch", { path });
}

export function gitListBranches(path: string): Promise<string[]> {
  return invoke("git_list_branches", { path });
}

export function gitCreateWorktree(path: string, branchName: string): Promise<CreatedWorktree> {
  return invoke("git_create_worktree", { path, branchName });
}

export function gitStatus(path: string): Promise<GitStatus> {
  return invoke("git_status", { path });
}

export function gitChangedFiles(path: string): Promise<ChangedFile[]> {
  return invoke("git_changed_files", { path });
}

export function gitFileDiff(path: string, filePath: string, staged: boolean): Promise<string> {
  return invoke("git_file_diff", { path, filePath, staged });
}

/** Read a file's contents for preview in file-viewer mode. `source` is one
 *  of: "working" (from disk), "staged" (from git index), "head" (from HEAD). */
export function gitFileContents(
  path: string,
  filePath: string,
  source: "working" | "staged" | "head",
): Promise<string> {
  return invoke("git_file_contents", { path, filePath, source });
}

/** List all files known to git — tracked + untracked-but-not-ignored.
 *  Returns repo-relative paths, same set a user would consider "files in
 *  this project" (build artifacts and node_modules are excluded). */
export function gitListFiles(path: string): Promise<string[]> {
  return invoke("git_list_files", { path });
}

export function gitStageAll(path: string): Promise<void> {
  return invoke("git_stage_all", { path });
}

export function gitCommit(path: string, message: string): Promise<void> {
  return invoke("git_commit", { path, message });
}

export function gitSwitchBranch(path: string, branchName: string): Promise<void> {
  return invoke("git_switch_branch", { path, branchName });
}

export function gitCreateBranch(path: string, branchName: string): Promise<void> {
  return invoke("git_create_branch", { path, branchName });
}

export function gitPushBranch(path: string, branch: string): Promise<void> {
  return invoke("git_push_branch", { path, branch });
}

export function gitFetch(path: string): Promise<void> {
  return invoke("git_fetch", { path });
}

export function gitPull(path: string, branch: string): Promise<void> {
  return invoke("git_pull", { path, branch });
}

export function gitHasHeadCommit(path: string): Promise<boolean> {
  return invoke("git_has_head_commit", { path });
}

// ── GitHub commands ───────────────────────────────────────────────

export function githubAuthStatus(): Promise<GhAuthStatus> {
  return invoke("github_auth_status");
}

export function githubAuthLogin(): Promise<void> {
  return invoke("github_auth_login");
}

export function githubAuthLogout(hostname: string): Promise<void> {
  return invoke("github_auth_logout", { hostname });
}

export function githubSetupGit(hostname: string): Promise<void> {
  return invoke("github_setup_git", { hostname });
}

export function githubListOrgs(): Promise<string[]> {
  return invoke("github_list_orgs");
}

export function githubListRemotes(path: string): Promise<GitRemote[]> {
  return invoke("github_list_remotes", { path });
}

export function githubPublishRepo(args: PublishRepoArgs): Promise<PublishRepoResult> {
  return invoke("github_publish_repo", { args });
}

// ── AGENTS.md editor ──────────────────────────────────────────────

/** Read AGENTS.md from a project. Returns "" if the file doesn't exist. */
export function readAgentsFile(repoPath: string): Promise<string> {
  return invoke("read_agents_file", { repoPath });
}

/** Write AGENTS.md for a project. Also creates a CLAUDE.md -> AGENTS.md
 *  symlink if CLAUDE.md doesn't already exist. An existing CLAUDE.md
 *  (file or symlink) is left untouched. */
export function writeAgentsFile(repoPath: string, contents: string): Promise<void> {
  return invoke("write_agents_file", { repoPath, contents });
}

// ── System commands ────────────────────────────────────────────────

export function getUsername(): Promise<string> {
  return invoke("get_username");
}

export function getHomeDirectory(): Promise<string> {
  return invoke("get_home_directory");
}

export function getDefaultShell(): Promise<string> {
  return invoke("get_default_shell");
}

export function getComputerName(): Promise<string> {
  return invoke("get_computer_name");
}

export function checkCommandExists(command: string): Promise<boolean> {
  return invoke("check_command_exists", { command });
}

export function getUsageSettings(): Promise<UsageSettings> {
  return invoke("get_usage_settings");
}

export function saveUsageSettings(settings: UsageSettings): Promise<void> {
  return invoke("save_usage_settings", { settings });
}

export function getAllUsageSnapshots(): Promise<ProviderUsageSnapshot[]> {
  return invoke("get_all_usage_snapshots");
}

export function getUsageSnapshot(provider: string): Promise<ProviderUsageSnapshot> {
  return invoke("get_usage_snapshot", { provider });
}

export function getUsageDetails(provider: string, window: string): Promise<LocalUsageDetails> {
  return invoke("get_usage_details", { provider, window });
}

export function getUsageOverview(window: string): Promise<UsageOverview> {
  return invoke("get_usage_overview", { window });
}

export function refreshUsageData(forceProviders?: boolean): Promise<void> {
  return invoke("refresh_usage_data", { forceProviders });
}

export interface MemoryStats {
  app_rss: number;
  children_rss: number;
}

export function getMemoryStats(): Promise<MemoryStats> {
  return invoke("get_memory_stats");
}

// ── Port commands ─────────────────────────────────────────────────

export function listListeningPorts(): Promise<PortInfo[]> {
  return invoke("list_listening_ports");
}

export function killPort(pid: number): Promise<void> {
  return invoke("kill_port", { pid });
}
