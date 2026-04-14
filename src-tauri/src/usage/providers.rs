use serde_json::Value;
use std::fs;
use std::collections::HashMap;

use super::helpers::{home_join, run_command};
use super::types::UsageWindowSnapshot;

/// Fetch Codex rate limit windows from ChatGPT API.
pub fn codex_provider_windows() -> Result<Vec<UsageWindowSnapshot>, String> {
    let auth_path = home_join(".codex/auth.json")?;
    let auth_text = fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read Codex auth file: {e}"))?;
    let auth_json: Value = serde_json::from_str(&auth_text)
        .map_err(|e| format!("Failed to parse Codex auth file: {e}"))?;
    let token = auth_json
        .get("tokens")
        .and_then(|v| v.get("access_token"))
        .and_then(Value::as_str)
        .or_else(|| auth_json.get("access_token").and_then(Value::as_str))
        .ok_or_else(|| "Missing Codex access token".to_string())?;

    let body = run_command(
        "curl",
        &[
            "-sS",
            "--max-time", "10",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "https://chatgpt.com/backend-api/wham/usage",
        ],
    )?;
    let json: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Codex usage response: {e}"))?;

    let primary = json
        .get("rate_limit")
        .and_then(|v| v.get("primary_window"))
        .ok_or_else(|| "Codex usage response missing primary window".to_string())?;
    let secondary = json
        .get("rate_limit")
        .and_then(|v| v.get("secondary_window"))
        .ok_or_else(|| "Codex usage response missing secondary window".to_string())?;

    Ok(vec![
        percent_window("codex", "5h", primary),
        percent_window("codex", "7d", secondary),
    ])
}

/// Fetch Claude rate limit windows from Anthropic API.
pub fn claude_provider_windows() -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    let token_json = run_command("security", &["find-generic-password", "-s", "Claude Code-credentials", "-w"])?;
    let credentials: Value = serde_json::from_str(&token_json)
        .map_err(|e| format!("Failed to parse Claude Keychain credentials: {e}"))?;
    let token = credentials
        .get("claudeAiOauth")
        .and_then(|v| v.get("accessToken"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing Claude OAuth access token".to_string())?;

    let body = run_command(
        "curl",
        &[
            "-sS",
            "--max-time", "10",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "-H",
            "anthropic-beta: oauth-2025-04-20",
            "https://api.anthropic.com/api/oauth/usage",
        ],
    )?;
    let json: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Claude usage response: {e}"))?;

    if let Some(msg) = api_error_message(&json) {
        return Err(msg);
    }

    let mut primary = Vec::new();
    let mut extra = Vec::new();

    if let Some(five_hour) = json.get("five_hour") {
        primary.push(claude_window("5h", five_hour));
    }
    if let Some(seven_day) = json.get("seven_day") {
        primary.push(claude_window("7d", seven_day));
    }
    if let Some(seven_day_sonnet) = json.get("seven_day_sonnet") {
        if !seven_day_sonnet.is_null() {
            extra.push(claude_window("7d_sonnet", seven_day_sonnet));
        }
    }

    if primary.is_empty() {
        Err("Claude usage response did not include expected windows".to_string())
    } else {
        Ok((primary, extra))
    }
}

fn api_error_message(json: &Value) -> Option<String> {
    let err = json.get("error")?;
    let msg = err.get("message").and_then(Value::as_str).unwrap_or("").trim();
    let kind = err.get("type").and_then(Value::as_str).unwrap_or("").trim();
    match (kind, msg) {
        ("rate_limit_error", _) => Some("Anthropic usage API is rate-limited — try again shortly".to_string()),
        (_, m) if !m.is_empty() => Some(m.to_string()),
        (k, _) if !k.is_empty() => Some(k.to_string()),
        _ => None,
    }
}

fn claude_window(window: &str, value: &Value) -> UsageWindowSnapshot {
    let used = value.get("utilization").and_then(Value::as_f64);
    UsageWindowSnapshot {
        provider: "claude".to_string(),
        window: window.to_string(),
        label: window.replace('_', " "),
        source_type: "provider".to_string(),
        confidence: "official".to_string(),
        used_percent: used,
        remaining_percent: used.map(|v| (100.0 - v).max(0.0)),
        reset_at: value.get("resets_at").and_then(Value::as_str).map(ToString::to_string),
        token_total: None,
        pace_status: None,
    }
}

fn percent_window(provider: &str, label: &str, value: &Value) -> UsageWindowSnapshot {
    let used = value.get("used_percent").and_then(Value::as_f64);
    UsageWindowSnapshot {
        provider: provider.to_string(),
        window: label.to_string(),
        label: label.to_string(),
        source_type: "provider".to_string(),
        confidence: "official".to_string(),
        used_percent: used,
        remaining_percent: used.map(|v| (100.0 - v).max(0.0)),
        reset_at: value.get("reset_at").map(|v| v.to_string()),
        token_total: None,
        pace_status: None,
    }
}

// ── Gemini ────────────────────────────────────────────────

// OAuth client credentials from the Gemini CLI bundle.
// These are public values embedded in the open-source CLI.
const GEMINI_OAUTH_CLIENT_ID: &str = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_OAUTH_CLIENT_SECRET: &str = "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";

/// Fetch Gemini quota windows from Google's internal API.
pub fn gemini_provider_windows() -> Result<Vec<UsageWindowSnapshot>, String> {
    let settings_path = home_join(".gemini/settings.json")?;
    if settings_path.exists() {
        let settings_text = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read Gemini settings: {e}"))?;
        let settings: Value = serde_json::from_str(&settings_text).unwrap_or(Value::Null);
        let auth_type = settings
            .pointer("/security/auth/selectedType")
            .and_then(Value::as_str)
            .unwrap_or("oauth-personal");
        match auth_type {
            "api-key" | "vertex-ai" => return Err(format!("Gemini auth type '{auth_type}' not supported for quota")),
            _ => {} // oauth-personal or unknown — proceed
        }
    }

    let token = gemini_get_access_token()?;
    let project_id = gemini_load_project(&token)?;
    let buckets = gemini_retrieve_quota(&token, &project_id)?;
    gemini_buckets_to_windows(&buckets)
}

/// Read the access token from ~/.gemini/oauth_creds.json, refreshing if expired.
fn gemini_get_access_token() -> Result<String, String> {
    let creds_path = home_join(".gemini/oauth_creds.json")?;
    let creds_text = fs::read_to_string(&creds_path)
        .map_err(|e| format!("Failed to read Gemini OAuth creds: {e}"))?;
    let creds: Value = serde_json::from_str(&creds_text)
        .map_err(|e| format!("Failed to parse Gemini OAuth creds: {e}"))?;

    let expiry = creds.get("expiry_date").and_then(Value::as_u64).unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    if now_ms < expiry.saturating_sub(60_000) {
        // Token still valid (with 60s buffer)
        return creds.get("access_token")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .ok_or_else(|| "Missing access_token in Gemini OAuth creds".to_string());
    }

    // Refresh the token
    let refresh_token = creds.get("refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing refresh_token in Gemini OAuth creds".to_string())?;

    // Use the form serializer so refresh_token (and any future field)
    // is properly URL-encoded — never interpolated raw into the body.
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", GEMINI_OAUTH_CLIENT_ID)
        .append_pair("client_secret", GEMINI_OAUTH_CLIENT_SECRET)
        .append_pair("refresh_token", refresh_token)
        .append_pair("grant_type", "refresh_token")
        .finish();

    let response = run_command("curl", &[
        "-sS", "--max-time", "10",
        "-X", "POST",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-d", &body,
        "https://oauth2.googleapis.com/token",
    ])?;

    let resp: Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse token refresh response: {e}"))?;

    let new_token = resp.get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let error = resp.get("error_description")
                .or_else(|| resp.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            format!("Token refresh failed: {error}")
        })?;

    let expires_in = resp.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);

    // Write updated creds back
    let mut updated = creds.clone();
    if let Some(obj) = updated.as_object_mut() {
        obj.insert("access_token".to_string(), Value::String(new_token.to_string()));
        obj.insert("expiry_date".to_string(), Value::Number((now_ms + expires_in * 1000).into()));
        if let Some(new_id_token) = resp.get("id_token") {
            obj.insert("id_token".to_string(), new_id_token.clone());
        }
    }
    let _ = fs::write(&creds_path, serde_json::to_string_pretty(&updated).unwrap_or_default());

    Ok(new_token.to_string())
}

/// Discover the Google Cloud project ID via loadCodeAssist.
fn gemini_load_project(token: &str) -> Result<String, String> {
    let body = r#"{"metadata":{"ideType":"GEMINI_CLI","pluginType":"GEMINI"}}"#;

    let response = run_command("curl", &[
        "-sS", "--max-time", "10",
        "-X", "POST",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "Content-Type: application/json",
        "-d", body,
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    ])?;

    let resp: Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse loadCodeAssist response: {e}"))?;

    // Try cloudaicompanionProject first
    if let Some(project) = resp.get("cloudaicompanionProject").and_then(Value::as_str) {
        if !project.is_empty() {
            return Ok(project.to_string());
        }
    }

    // Fallback: empty project — retrieveUserQuota may still work
    Ok(String::new())
}

/// Fetch quota buckets from retrieveUserQuota.
fn gemini_retrieve_quota(token: &str, project_id: &str) -> Result<Vec<GeminiQuotaBucket>, String> {
    let body = if project_id.is_empty() {
        "{}".to_string()
    } else {
        format!(r#"{{"project":"{}"}}"#, project_id)
    };

    let response = run_command("curl", &[
        "-sS", "--max-time", "10",
        "-X", "POST",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "Content-Type: application/json",
        "-d", &body,
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ])?;

    let resp: Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse retrieveUserQuota response: {e}"))?;

    let buckets = resp.get("buckets")
        .and_then(Value::as_array)
        .ok_or_else(|| "retrieveUserQuota response missing buckets".to_string())?;

    let mut result = Vec::new();
    for bucket in buckets {
        let remaining = bucket.get("remainingFraction").and_then(Value::as_f64);
        let reset = bucket.get("resetTime").and_then(Value::as_str).map(ToString::to_string);
        let model = bucket.get("modelId").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let token_type = bucket.get("tokenType").and_then(Value::as_str).unwrap_or("").to_string();

        if let Some(frac) = remaining {
            result.push(GeminiQuotaBucket {
                model_id: model,
                token_type,
                remaining_fraction: frac,
                reset_time: reset,
            });
        }
    }

    if result.is_empty() {
        return Err("No quota buckets returned".to_string());
    }

    Ok(result)
}

struct GeminiQuotaBucket {
    model_id: String,
    #[allow(dead_code)]
    token_type: String,
    remaining_fraction: f64,
    reset_time: Option<String>,
}

/// Classify a model ID into a display tier.
fn gemini_model_tier(model: &str) -> &'static str {
    if model.contains("pro") && !model.contains("flash") {
        "pro"
    } else if model.contains("flash") && !model.contains("lite") {
        "flash"
    } else if model.contains("lite") {
        "lite"
    } else {
        "other"
    }
}

/// Convert quota buckets to UsageWindowSnapshot entries.
/// Groups by tier (pro/flash/lite), takes the lowest remaining fraction per
/// tier (worst case across all models and token types in that tier).
fn gemini_buckets_to_windows(buckets: &[GeminiQuotaBucket]) -> Result<Vec<UsageWindowSnapshot>, String> {
    // Group by tier — keep lowest remaining fraction and earliest reset
    let mut by_tier: HashMap<&str, (f64, Option<String>)> = HashMap::new();
    for bucket in buckets {
        let tier = gemini_model_tier(&bucket.model_id);
        let entry = by_tier.entry(tier).or_insert((1.0, None));
        if bucket.remaining_fraction < entry.0 {
            entry.0 = bucket.remaining_fraction;
        }
        if entry.1.is_none() {
            entry.1.clone_from(&bucket.reset_time);
        }
    }

    let mut windows: Vec<UsageWindowSnapshot> = by_tier.iter().map(|(tier, (remaining, reset))| {
        let used_pct = ((1.0 - remaining) * 100.0).max(0.0);
        UsageWindowSnapshot {
            provider: "gemini".to_string(),
            window: format!("24h_{tier}"),
            label: format!("24h {tier}"),
            source_type: "provider".to_string(),
            confidence: "official".to_string(),
            used_percent: Some(used_pct),
            remaining_percent: Some((remaining * 100.0).max(0.0)),
            reset_at: reset.clone(),
            token_total: None,
            pace_status: None,
        }
    }).collect();

    // Sort so pro comes first, then flash, then lite
    windows.sort_by_key(|w| {
        if w.window.contains("pro") { 0 }
        else if w.window.contains("flash") && !w.window.contains("lite") { 1 }
        else if w.window.contains("lite") { 2 }
        else { 3 }
    });

    if windows.is_empty() {
        return Err("No quota windows could be derived".to_string());
    }

    Ok(windows)
}
