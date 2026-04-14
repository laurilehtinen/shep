# Changelog

All notable changes in the `sun-shep` fork (hosted at
[laurilehtinen/shep](https://github.com/laurilehtinen/shep), forked from
[stumptowndoug/shep](https://github.com/stumptowndoug/shep)) are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **BBEdit editor support.** [BBEdit](https://www.barebones.com/products/bbedit/)
  joins VS Code, Zed, Cursor, and Sublime Text as a selectable editor in
  Settings. "Open in Editor" uses `open -a BBEdit <path>` on macOS. Logo is
  a typographic "BB" monogram with the `themed-mono-logo` treatment so it
  adapts to light/dark themes.

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

- **Provider API cache persisted across app restarts.** The in-memory
  `PROVIDER_CACHE` (Claude / Codex / Gemini fetch timestamps, last fetched
  windows, and error backoff state) is now written to
  `~/.shep/provider_cache.json` after every refresh and restored on startup.
  Previously every relaunch reset `fetched_at = 0`, which made `is_stale`
  return true immediately and forced a fresh API call — repeated quick
  restarts (e.g. during `pnpm tauri dev` rebuilds) could trip Anthropic's
  rate limit on the usage endpoint.
  - New `init_provider_cache_from_disk()` (called from `lib.rs` setup) and
    `save_provider_cache_to_disk()` (called at the end of
    `refresh_provider_cache_sync`) in `src-tauri/src/usage/mod.rs`.
  - Atomic write via tmp-file + rename so a crash mid-save can't corrupt
    the persisted state.
  - `UsageWindowSnapshot`, `ProviderState`, `ProviderCacheData`, and
    `ProviderCache` gain `Deserialize` derives. `last_error_logged` is
    `#[serde(skip)]` so the "did we already log this error?" flag resets on
    reload — the next encounter is logged even if the message matches a
    prior session.

### Changed

- **Force refresh now honors per-provider error backoff.**
  `force_refresh_providers()` previously bypassed the success TTL *and* the
  exponential error backoff, meaning a Refresh click during an active
  rate-limit window immediately re-hit the API and got rate-limited again.
  It now bypasses only the success TTL: providers with `consecutive_errors
  > 0` are skipped while inside their `cooldown_secs()` window, and the
  cached error keeps surfacing in the Rate Limits section.
  - New `ProviderState::should_force_refresh(now)` helper:
    `consecutive_errors == 0 || self.is_stale(now)`.
  - The single-flight `PROVIDER_REFRESH_RUNNING` guard is now only acquired
    if at least one provider actually needs a refresh, so a no-op forced
    refresh doesn't briefly block a concurrent automatic one.

- **Surfaced errors include remaining backoff time.** The Rate Limits
  section now appends `(auto-retry in 4m 12s)` to the cached error
  whenever a provider is still inside its backoff window. Without this,
  pressing Refresh during a 429 cooldown silently re-displayed the same
  Anthropic message and made it look like the click did nothing — now the
  countdown ticks down across clicks, making it obvious that the refresh
  was deliberately skipped.
  - `ProviderState::surfaced_error()` now takes `now: u64` and computes
    the remainder of `cooldown_secs()`.
  - New local `format_short_duration()` helper renders durations as
    `"45s"` / `"2m"` / `"2m 30s"`.

- **"Off" providers hidden from the New Session Launcher.** When a provider
  is toggled off in Settings (`usageSettings[provider].show === false`),
  its entry is removed entirely from the assistant picker in
  `src/components/session/SessionLauncher.tsx` — no button, no icon, no
  greyed-out slot. Running sessions for that provider keep their sidebar
  tab, but the provider logo is suppressed on that tab
  (`src/components/sidebar/AssistantButton.tsx`) so the UI doesn't advertise
  a provider the user has explicitly hidden. The "Off" state is the same
  toggle used by the Settings Panel and Sidebar Usage filtering.

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
- New on-disk file `~/.shep/provider_cache.json` for provider API cache
  persistence (alongside the existing `~/.shep/usage.sqlite3`).

[Unreleased]: https://github.com/laurilehtinen/shep/tree/sun-shep
