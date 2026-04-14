# Changelog

All notable changes in the `sun-shep` fork (hosted at
[laurilehtinen/shep](https://github.com/laurilehtinen/shep), forked from
[stumptowndoug/shep](https://github.com/stumptowndoug/shep)) are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Kilo provider support.** Kilo ([kilo.ai/cli](https://kilo.ai/cli)) is now a
  fully integrated fifth assistant alongside Claude, Codex, Gemini, and
  OpenCode. Includes session launching, a sidebar tab, a `kilo.svg` logo, a
  Settings Panel entry, and local usage ingestion.
  - Ingests messages directly from Kilo's local SQLite database at
    `~/.local/share/kilo/kilo.db`. The ingester tracks cursor via file size,
    mtime, and last rowid, and detects a db rebuild (size shrinkage) by
    clearing old `kilo` rows so counters restart clean.
  - Records input, output, reasoning, cache-read, cache-write, and total
    tokens plus recorded cost per message. Provider label pulled from
    `providerID`, model label from `modelID`, timestamp from
    `time.completed`/`time.created` (falling back to `time_created`).
  - `kilo_snapshot()` follows the local-only provider pattern (no upstream
    API), mirroring OpenCode.

- **Per-provider billing cycle cutoff day.** Each provider's monthly budget
  can now reset on a configurable day of month (1–28) instead of being locked
  to the calendar month.
  - New setting `ProviderBudgetConfig.budgetCutoffDay` (serialized
    `budgetCutoffDay`). `null` / unset defaults to the 1st. Capped at 28 so
    every month has a matching reset day.
  - Settings Panel shows a second input next to the monthly budget amount
    (visible when `budgetMode === "custom"`): day 1–28, clamped/rounded on
    entry.
  - Usage Panel's "Monthly Budgets" section heading changed from
    "Current month" to "Billing cycle". Both spend percentage and
    elapsed-time percentage now use the active cycle's start/end rather than
    the calendar month.
  - New helper `billingCycleRange(now, cutoffDay)` in `usageHelpers.ts`; new
    `ProviderCutoffs` struct in `src-tauri/src/usage/mod.rs` threads the
    per-provider cutoff day through every snapshot and query path.

- **Force provider refresh on the Usage tab refresh button.** Pressing
  Refresh now also re-fetches provider-reported usage (Claude, Codex,
  Gemini), bypassing the 5-minute success TTL that gates automatic refreshes.
  - New `force_refresh_providers()` function in `src-tauri/src/usage/mod.rs`:
    blocking provider refresh that ignores staleness but still respects the
    single-flight `PROVIDER_REFRESH_RUNNING` atomic so two API calls can't
    stack.
  - `refresh_usage_data` Tauri command now accepts an optional
    `force_providers` flag and reads workspace settings to resolve
    `EnabledProviders` before the ingest thread starts. Existing callers
    (startup and the 60-second interval in `AppShell.tsx`) keep passing no
    argument, so automatic pings still respect the TTL and avoid hammering
    provider APIs.
  - `UsagePanel` now also calls `fetchSnapshots()` inside the
    `usage-ingest-complete` listener, so the Rate Limits section updates
    after the forced refresh completes without requiring a second click.

- **Rate-limit-aware error surfacing.** When a provider API fails (including
  429s from Anthropic), the Usage Panel's Rate Limits section now renders
  an "unavailable" row with the parsed error instead of silently disappearing.
  - New `api_error_message()` helper in `providers.rs` detects
    `rate_limit_error` responses from Anthropic and formats a friendlier
    "rate-limited — try again shortly" message.
  - New `ProviderState::surfaced_error()` helper exposes the cached error to
    snapshot rendering.

### Changed

- **Provider icons hidden when a provider is "Off".** When a provider is
  toggled off in Settings (`usageSettings[provider].show === false`), its
  logo is suppressed in:
  - the New Session Launcher assistant picker
    (`src/components/session/SessionLauncher.tsx`), and
  - the sidebar assistant tabs for already-running sessions
    (`src/components/sidebar/AssistantButton.tsx`).

  The buttons/tabs themselves remain interactive — only the icon is hidden.
  The "Off" state is the same toggle used by Settings Panel and Sidebar Usage
  filtering.

- **Monthly budget calculation uses the full monthly budget regardless of the
  selected time window.** `syntheticBudgetWindow()` no longer prorates the
  budget down to the visible window (5h / 7d / 30d). `usedPercent` is now
  computed directly against the monthly budget, and the label changed from
  the window name to `"monthly"`.

- **Default settings for Kilo** seed at `show: true`, `budgetMode: "custom"`,
  `monthlyBudget: 100`, `budgetCutoffDay: null` — matching OpenCode's
  defaults.

### Fixed

- **Path traversal hardening in `git.file_contents()`.** Both the repo base
  and the requested file path are now canonicalized and verified to remain
  within the repo root for the `working` source, rejecting escape attempts
  (e.g. `../../etc/passwd`) and absolute paths outside the repo.

- **`kill_port` now validates PIDs.** The command only allows killing PIDs
  that currently appear in `list_listening_ports()`, preventing a
  compromised renderer from terminating arbitrary user processes.

- **Gemini OAuth token refresh uses proper URL-encoded form serialization.**
  Switched from string interpolation to `url::form_urlencoded::Serializer`
  so refresh tokens containing special characters can't break or inject into
  the refresh request.

### Internal / Plumbing

- `UsageProvider` type union expanded to
  `"codex" | "claude" | "gemini" | "opencode" | "kilo"`.
- `UsageSettings` struct gains a `kilo: ProviderBudgetConfig` field (Rust and
  TypeScript).
- `ProviderBudgetConfig` struct gains `budgetCutoffDay: Option<u32>` (Rust) /
  `budgetCutoffDay: number | null` (TypeScript).
- `ALL_USAGE_PROVIDERS` includes `"kilo"`; `assistantLogoSrc` includes the
  Kilo logo; `CODING_ASSISTANTS` and `ASSISTANT_INSTALL_URLS` include Kilo.
- `prune_old_messages()` excludes both `opencode` and `kilo` — local-only
  providers aren't subject to cloud-API retention windows.
- New helpers `enabled_from()` and `cutoffs_from()` in `commands.rs` pull
  enabled flags and per-provider cutoffs out of persisted settings for use
  in snapshot/ingest paths.

[Unreleased]: https://github.com/laurilehtinen/shep/tree/sun-shep
