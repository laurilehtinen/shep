use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageNamedTokens {
    pub name: String,
    pub tokens: u64,
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTask {
    pub id: String,
    pub label: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub model: Option<String>,
    pub project: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProject {
    pub name: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub sessions: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendProviderValue {
    pub provider: String,
    pub tokens: u64,
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendBucket {
    pub start: i64,
    pub end: i64,
    pub label: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub providers: Vec<UsageTrendProviderValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverviewProvider {
    pub provider: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub share_percent: f64,
    pub trend: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdownItem {
    pub provider: String,
    pub label: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub sessions: Option<u64>,
    pub trend: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub window: String,
    pub total_tokens: u64,
    pub total_cost: Option<f64>,
    pub active_projects: u64,
    pub active_sessions: u64,
    pub providers: Vec<UsageOverviewProvider>,
    pub trend: Vec<UsageTrendBucket>,
    pub top_models: Vec<UsageBreakdownItem>,
    pub top_projects: Vec<UsageBreakdownItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowSnapshot {
    pub provider: String,
    pub window: String,
    pub label: String,
    pub source_type: String,
    pub confidence: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub token_total: Option<u64>,
    pub pace_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageDetails {
    pub source_type: String,
    pub confidence: String,
    pub tokens_total: u64,
    pub tokens_input: Option<u64>,
    pub tokens_output: Option<u64>,
    pub tokens_cached: Option<u64>,
    pub tokens_thoughts: Option<u64>,
    pub tokens_5h: u64,
    pub tokens_7d: u64,
    pub tokens_30d: u64,
    pub cost_total: Option<f64>,
    pub cost_month: Option<f64>,
    pub cost_5h: Option<f64>,
    pub cost_7d: Option<f64>,
    pub cost_30d: Option<f64>,
    pub top_models: Vec<UsageNamedTokens>,
    pub top_tasks: Vec<UsageTask>,
    pub top_projects: Vec<UsageProject>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSnapshot {
    pub provider: String,
    pub status: String,
    pub fetched_at: String,
    pub summary_windows: Vec<UsageWindowSnapshot>,
    pub extra_windows: Vec<UsageWindowSnapshot>,
    pub local_details: Option<LocalUsageDetails>,
    pub error: Option<String>,
}
