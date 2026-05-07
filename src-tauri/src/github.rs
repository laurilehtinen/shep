//! GitHub integration via the `gh` CLI.
//!
//! Shep delegates all GitHub auth/token/credential-helper concerns to the
//! official GitHub CLI (`gh`). No tokens ever pass through Shep — `gh` stores
//! them in the platform keyring and wires git's credential helper via
//! `gh auth setup-git`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// `gh auth login --web` blocks until the user completes OAuth in a browser.
/// Give the user 5 minutes before we give up.
const AUTH_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Default timeout for `gh` calls that should return quickly (auth status,
/// remote listing, etc.). Longer operations pass an explicit timeout.
const DEFAULT_GH_TIMEOUT: Duration = Duration::from_secs(30);

// ── Types surfaced to the frontend ──────────────────────────────────

#[derive(Serialize, Clone, Default)]
pub struct GhAuthStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub hostname: Option<String>,
    pub username: Option<String>,
    pub scopes: Vec<String>,
    pub token_source: Option<String>,
    pub git_protocol: Option<String>,
}

#[derive(Deserialize)]
pub struct PublishRepoArgs {
    pub path: String,
    pub name: String,
    pub owner: Option<String>,
    pub description: Option<String>,
    pub private: bool,
    pub remote_name: String,
    pub push: bool,
}

#[derive(Serialize, Clone)]
pub struct PublishRepoResult {
    pub html_url: String,
    pub ssh_url: String,
    pub https_url: String,
    pub pushed: bool,
    pub push_error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
    pub is_github: bool,
}

// ── Internal helper: every gh call prepends Homebrew paths to PATH so the
//    subprocess can find `gh` even when Shep was launched from Finder with a
//    minimal environment.

fn gh_command() -> Command {
    let mut cmd = Command::new("gh");
    let existing = std::env::var("PATH").unwrap_or_default();
    // /usr/bin is required so gh can find `open` (macOS) when the parent's
    // PATH was minimal — otherwise gh's own browser-launch silently fails.
    let augmented = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{existing}");
    cmd.env("PATH", augmented);
    cmd
}

/// Run `gh <args>` with the default timeout. Returns stdout on success.
fn run_gh<S: AsRef<str>>(args: &[S]) -> Result<String, String> {
    run_gh_with_timeout(args, DEFAULT_GH_TIMEOUT)
}

fn run_gh_with_timeout<S: AsRef<str>>(args: &[S], timeout: Duration) -> Result<String, String> {
    if !gh_installed() {
        return Err("GitHub CLI (gh) is not installed. Install from https://cli.github.com/.".to_string());
    }

    let mut cmd = gh_command();
    for a in args {
        cmd.arg(a.as_ref());
    }
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run gh: {e}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to read gh output: {e}"))?;
                if !status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
                }
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("gh timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Error waiting for gh: {e}")),
        }
    }
}

// ── Detection ───────────────────────────────────────────────────────

pub fn gh_installed() -> bool {
    gh_command()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn gh_version() -> Option<String> {
    gh_command()
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().and_then(|s| {
                    s.lines().next().map(|l| l.trim().to_string())
                })
            } else {
                None
            }
        })
}

// ── Auth ────────────────────────────────────────────────────────────

/// Parse `gh auth status --json hosts` into a GhAuthStatus. Always returns a
/// value — absence of login is represented by `logged_in = false`.
pub fn auth_status() -> GhAuthStatus {
    let mut status = GhAuthStatus {
        installed: gh_installed(),
        version: gh_version(),
        ..GhAuthStatus::default()
    };

    if !status.installed {
        return status;
    }

    // `gh auth status --json` only accepts the field name `hosts`. The shape
    // is `{ "hosts": { "<hostname>": [ { state, active, host, login,
    // tokenSource, scopes, gitProtocol } ] } }`. Keys use camelCase, so we
    // read `tokenSource` / `gitProtocol` here (the struct itself is
    // snake_case for serde defaults — that only matters for the frontend
    // payload, not the gh JSON we parse).
    let Ok(raw) = run_gh(&["auth", "status", "--json", "hosts"]) else {
        return status;
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return status,
    };

    let Some(hosts) = parsed.get("hosts").and_then(Value::as_object) else {
        return status;
    };

    // Prefer github.com; fall back to whatever single host is configured.
    let entries = hosts
        .get("github.com")
        .or_else(|| hosts.values().next())
        .and_then(Value::as_array);

    let entry = entries.and_then(|arr| {
        arr.iter()
            .find(|e| e.get("active").and_then(Value::as_bool) == Some(true))
            .or_else(|| arr.first())
    });

    if let Some(entry) = entry {
        // gh reports state="success" for a working token; anything else
        // (e.g. expired, missing scopes) means the user must re-auth.
        if entry.get("state").and_then(Value::as_str) != Some("success") {
            return status;
        }

        status.logged_in = true;
        status.hostname = entry.get("host").and_then(Value::as_str).map(str::to_string);
        status.username = entry.get("login").and_then(Value::as_str).map(str::to_string);
        status.token_source = entry.get("tokenSource").and_then(Value::as_str).map(str::to_string);
        status.git_protocol = entry.get("gitProtocol").and_then(Value::as_str).map(str::to_string);
        if let Some(scopes) = entry.get("scopes").and_then(Value::as_str) {
            status.scopes = scopes
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    status
}

/// Run `gh auth login --web` and stream its output to the frontend via Tauri
/// events. We pipe `\n` to stdin so gh auto-opens the browser (skipping the
/// "Press Enter" prompt), then parse each output line looking for the
/// one-time code and the verification URL. Because gh's own browser-launch
/// can silently fail when Shep is started from Finder with a minimal env,
/// we also open the URL ourselves as soon as we see it. Events:
///
/// - `gh-auth-line` — every stdout/stderr line (plain string)
/// - `gh-auth-code` — the one-time device code (e.g. "ABCD-1234")
/// - `gh-auth-url`  — the device-flow verification URL (e.g.
///                    "https://github.com/login/device"). The UI shows this
///                    as a clickable fallback in case the browser didn't open.
///
/// The function blocks until `gh` exits or [`AUTH_LOGIN_TIMEOUT`] elapses.
pub fn auth_login(app: &AppHandle) -> Result<(), String> {
    if !gh_installed() {
        return Err("GitHub CLI (gh) is not installed. Install from https://cli.github.com/.".to_string());
    }

    let mut child = gh_command()
        .args([
            "auth", "login",
            "--hostname", "github.com",
            "--git-protocol", "https",
            "--web",
            "--skip-ssh-key",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start gh auth login: {e}"))?;

    // Press Enter for the user — gh prints the one-time code, copies it to
    // the clipboard, then blocks on "Press Enter to open github.com...". We
    // skip that wait so the browser opens immediately.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"\n");
        drop(stdin);
    }

    // Bridge stdout and stderr to Tauri events. gh mixes informational output
    // across both streams, so we watch both.
    if let Some(stdout) = child.stdout.take() {
        spawn_line_forwarder(app.clone(), stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_line_forwarder(app.clone(), stderr);
    }

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(format!(
                    "gh auth login exited with status {}.",
                    status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())
                ));
            }
            Ok(None) => {
                if start.elapsed() > AUTH_LOGIN_TIMEOUT {
                    let _ = child.kill();
                    return Err(format!(
                        "Sign-in timed out after {}s. Complete the browser flow and try again.",
                        AUTH_LOGIN_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Error waiting for gh: {e}")),
        }
    }
}

fn spawn_line_forwarder<R: std::io::Read + Send + 'static>(app: AppHandle, reader: R) {
    std::thread::spawn(move || {
        let reader = BufReader::new(reader);
        // Track whether we've already kicked off our own browser launch — gh
        // mixes the URL across stdout/stderr, and the line may reappear, so
        // we only fire once.
        let mut opened = false;
        for line in reader.lines().map_while(Result::ok) {
            let _ = app.emit("gh-auth-line", &line);
            if let Some(code) = extract_one_time_code(&line) {
                let _ = app.emit("gh-auth-code", &code);
            }
            if !opened {
                if let Some(url) = extract_verification_url(&line) {
                    let _ = app.emit("gh-auth-url", &url);
                    let _ = open_browser(&url);
                    opened = true;
                }
            }
        }
    });
}

/// gh prints "! First copy your one-time code: ABCD-1234". The code is
/// always 4 alphanumerics + `-` + 4 alphanumerics, uppercase. Returned
/// without the surrounding text so the UI can render it prominently.
fn extract_one_time_code(line: &str) -> Option<String> {
    for token in line.split_whitespace().rev() {
        let t = token.trim_end_matches('.').trim_end_matches(',');
        if t.len() == 9
            && t.as_bytes()[4] == b'-'
            && t.chars().enumerate().all(|(i, c)| {
                if i == 4 { c == '-' } else { c.is_ascii_alphanumeric() && !c.is_ascii_lowercase() }
            })
        {
            return Some(t.to_string());
        }
    }
    None
}

/// gh prints "Press Enter to open https://github.com/login/device in your
/// browser..." (and similar variants on browser-launch failure). We pull
/// the first https://github.com/login/... URL out of the line.
fn extract_verification_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let t = token.trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | ']' | '"' | '\''));
        if t.starts_with("https://github.com/login/") {
            return Some(t.to_string());
        }
    }
    None
}

/// Best-effort browser launch. Uses absolute paths so it works even when the
/// parent's PATH is minimal (Finder-launched apps on macOS). Failure is not
/// reported back — the UI always shows the URL as a fallback button.
fn open_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open").arg(url).status()
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).status()
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", url]).status()
    }
}

pub fn auth_logout(hostname: &str) -> Result<(), String> {
    run_gh(&["auth", "logout", "--hostname", hostname])?;
    Ok(())
}

/// Wire git's credential helper to use `gh` for the given hostname. Safe to
/// call repeatedly — idempotent.
pub fn setup_git_credential_helper(hostname: &str) -> Result<(), String> {
    run_gh(&["auth", "setup-git", "--hostname", hostname])?;
    Ok(())
}

// ── Orgs ────────────────────────────────────────────────────────────

pub fn list_orgs() -> Result<Vec<String>, String> {
    let out = run_gh(&["api", "user/orgs", "--jq", ".[].login"])?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

// ── Remotes ─────────────────────────────────────────────────────────

pub fn list_remotes(path: &str) -> Result<Vec<GitRemote>, String> {
    let output = Command::new("git")
        .args(["-C", path, "remote", "-v"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // git remote -v prints each remote twice (fetch + push). De-dupe by name.
    let mut seen = std::collections::BTreeMap::<String, String>::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        seen.entry(name.to_string()).or_insert_with(|| url.to_string());
    }

    Ok(seen
        .into_iter()
        .map(|(name, url)| {
            let is_github = url.contains("github.com");
            GitRemote { name, url, is_github }
        })
        .collect())
}

// ── Publish ─────────────────────────────────────────────────────────

pub fn publish_repo(args: &PublishRepoArgs) -> Result<PublishRepoResult, String> {
    // Preflight
    if !crate::git::is_git_repo(&args.path) {
        return Err("Not a git repository. Initialize git first.".to_string());
    }
    if !crate::git::has_head_commit(&args.path) {
        return Err("No commits yet. Create at least one commit before publishing.".to_string());
    }

    // Build the full repo target: either "<owner>/<name>" or just "<name>".
    let full_name = match args.owner.as_ref().filter(|o| !o.is_empty()) {
        Some(owner) => format!("{}/{}", owner, args.name),
        None => args.name.clone(),
    };

    let visibility = if args.private { "--private" } else { "--public" };

    let mut cli_args: Vec<String> = vec![
        "repo".to_string(),
        "create".to_string(),
        full_name.clone(),
        visibility.to_string(),
        "--source".to_string(),
        args.path.clone(),
        "--remote".to_string(),
        args.remote_name.clone(),
    ];

    if let Some(desc) = args.description.as_ref().filter(|d| !d.is_empty()) {
        cli_args.push("--description".to_string());
        cli_args.push(desc.clone());
    }

    if args.push {
        cli_args.push("--push".to_string());
    }

    let stdout = run_gh_with_timeout(&cli_args, Duration::from_secs(120))?;

    // The html URL is the first https://github.com/... on stdout.
    let html_url = stdout
        .lines()
        .find(|l| l.contains("github.com/"))
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| format!("https://github.com/{}", full_name));

    // Derive ssh/https forms — more reliable than parsing `gh repo view`.
    let owner_and_name = html_url
        .trim_start_matches("https://github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();
    let https_url = format!("https://github.com/{owner_and_name}.git");
    let ssh_url = format!("git@github.com:{owner_and_name}.git");

    // gh's --push flag already does the push; if it succeeded we're done.
    // If the user opted out of --push, pushed=false and it's their turn to
    // run Push from the GitPanel toolbar.
    Ok(PublishRepoResult {
        html_url,
        ssh_url,
        https_url,
        pushed: args.push,
        push_error: None,
    })
}
