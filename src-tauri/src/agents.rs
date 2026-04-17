use std::path::Path;

const AGENTS_FILE: &str = "AGENTS.md";
const CLAUDE_FILE: &str = "CLAUDE.md";

/// Read the project's AGENTS.md contents. Returns an empty string if the
/// file doesn't exist yet — the editor treats that as a blank document.
pub fn read_agents(repo_path: &str) -> Result<String, String> {
    let path = Path::new(repo_path);
    if !path.is_dir() {
        return Err(format!("Project directory does not exist: {repo_path}"));
    }
    let agents = path.join(AGENTS_FILE);
    match std::fs::read_to_string(&agents) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Cannot read AGENTS.md: {e}")),
    }
}

/// Write AGENTS.md and, if CLAUDE.md doesn't already exist, create a
/// symlink CLAUDE.md -> AGENTS.md so Claude Code picks up the same file.
/// An existing CLAUDE.md (regular file or any symlink) is never touched —
/// we don't want to clobber user-owned content.
pub fn write_agents(repo_path: &str, contents: &str) -> Result<(), String> {
    let path = Path::new(repo_path);
    if !path.is_dir() {
        return Err(format!("Project directory does not exist: {repo_path}"));
    }

    let agents = path.join(AGENTS_FILE);
    std::fs::write(&agents, contents).map_err(|e| format!("Cannot write AGENTS.md: {e}"))?;

    ensure_claude_symlink(path);
    Ok(())
}

/// Best-effort symlink creation. Failure is non-fatal — the save already
/// succeeded, and a missing symlink just means Claude Code won't find its
/// config. We surface failures via the return-void contract rather than
/// erroring the whole save.
fn ensure_claude_symlink(repo_path: &Path) {
    let claude = repo_path.join(CLAUDE_FILE);
    // symlink_metadata does NOT follow symlinks — so an existing (even broken)
    // CLAUDE.md symlink is detected and left alone.
    if claude.symlink_metadata().is_ok() {
        return;
    }

    #[cfg(unix)]
    {
        // Relative target keeps the repo portable if the user moves it.
        let _ = std::os::unix::fs::symlink(AGENTS_FILE, &claude);
    }
    #[cfg(windows)]
    {
        // symlink_file on Windows requires Developer Mode or admin; if it
        // fails, fall back to a file copy so Claude Code still has something.
        let _ = std::os::windows::fs::symlink_file(AGENTS_FILE, &claude);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = repo_path;
    }
}
