use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};

use super::types::{
    LocalUsageDetails, UsageBreakdownItem, UsageNamedTokens, UsageOverview,
    UsageOverviewProvider, UsageProject, UsageTask, UsageTrendBucket,
    UsageTrendProviderValue,
};
use super::helpers::now_epoch_seconds;

/// Pricing rates per million tokens for a model.
struct ModelPricing {
    input_per_m: f64,
    output_per_m: f64,
    cache_read_per_m: f64,
    cache_write_per_m: f64,
    thoughts_per_m: f64,
}

type PricingMap = HashMap<(String, String), ModelPricing>;

/// Load all pricing patterns from the DB.
fn load_pricing(conn: &Connection) -> PricingMap {
    let mut map = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT provider, model_pattern, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, thoughts_per_m FROM model_pricing"
    ) {
        Ok(s) => s,
        Err(_) => return map,
    };

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            ModelPricing {
                input_per_m: row.get(2)?,
                output_per_m: row.get(3)?,
                cache_read_per_m: row.get(4)?,
                cache_write_per_m: row.get(5)?,
                thoughts_per_m: row.get(6)?,
            },
        ))
    });

    if let Ok(rows) = rows {
        for row in rows.flatten() {
            map.insert((row.0, row.1), row.2);
        }
    }
    map
}

/// Match a model name to a pricing pattern (prefix match).
fn find_pricing<'a>(provider: &str, model: &str, pricing: &'a PricingMap) -> Option<&'a ModelPricing> {
    if let Some(p) = pricing.get(&(provider.to_string(), model.to_string())) {
        return Some(p);
    }
    let mut best_match: Option<(&str, &ModelPricing)> = None;
    for ((pricing_provider, pattern), p) in pricing {
        if pricing_provider == provider && model.starts_with(pattern.as_str()) {
            match best_match {
                Some((prev, _)) if pattern.len() > prev.len() => best_match = Some((pattern, p)),
                None => best_match = Some((pattern, p)),
                _ => {}
            }
        }
    }
    best_match.map(|(_, p)| p)
}

/// Calculate cost in USD for a set of token counts.
fn calculate_cost(pricing: &ModelPricing, input: i64, output: i64, cache_read: i64, cache_write: i64, thoughts: i64) -> f64 {
    (input as f64 * pricing.input_per_m
        + output as f64 * pricing.output_per_m
        + cache_read as f64 * pricing.cache_read_per_m
        + cache_write as f64 * pricing.cache_write_per_m
        + thoughts as f64 * pricing.thoughts_per_m)
        / 1_000_000.0
}

fn resolved_cost(
    pricing_provider: &str,
    model: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    thoughts: i64,
    recorded_cost: f64,
    has_recorded_cost: bool,
    pricing: &PricingMap,
) -> Option<f64> {
    if has_recorded_cost {
        return Some(recorded_cost);
    }

    find_pricing(pricing_provider, model, pricing)
        .map(|p| calculate_cost(p, input, output, cache_read, cache_write, thoughts))
}

/// Epoch seconds for the start of the current billing cycle.
/// `cutoff_day` is clamped to 1..=28 so every month has a matching day.
/// If today's day-of-month >= cutoff_day, the cycle started this month on `cutoff_day`;
/// otherwise it started last month on `cutoff_day`.
fn local_month_cutoff(conn: &Connection, cutoff_day: u32) -> i64 {
    let day = cutoff_day.clamp(1, 28);
    let offset_days = (day - 1) as i32;
    conn.query_row(
        "SELECT CAST(strftime('%s',
            CASE
              WHEN CAST(strftime('%d', 'now', 'localtime') AS INTEGER) >= ?1
              THEN date('now', 'localtime', 'start of month', '+' || ?2 || ' days')
              ELSE date('now', 'localtime', 'start of month', '-1 months', '+' || ?2 || ' days')
            END,
            'utc'
         ) AS INTEGER)",
        params![day as i64, offset_days as i64],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(0)
}

/// Calculate cost for a windowed query (total tokens by type for a given provider/cutoff).
fn windowed_cost(conn: &Connection, provider: &str, cutoff: i64, pricing: &PricingMap) -> Option<f64> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
         FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
         GROUP BY COALESCE(pricing_provider, provider), model"
    ).ok()?;

    let mut total_cost = 0.0;
    let mut has_any = false;

    let rows = stmt.query_map(params![provider, cutoff], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    }).ok()?;

    for row in rows.flatten() {
        let (pricing_provider, model, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if let Some(cost) = resolved_cost(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ) {
            total_cost += cost;
            has_any = true;
        }
    }

    if has_any { Some(total_cost) } else { None }
}

/// Query the DB for local usage details for a given provider.
/// `month_cutoff_day` is the billing cycle start day (1-28). 1 matches the calendar month.
pub fn local_details(conn: &Connection, provider: &str, month_cutoff_day: u32) -> Option<LocalUsageDetails> {
    let now = now_epoch_seconds() as i64;
    let t5h = now - 18_000;
    let t7d = now - 604_800;
    let t30d = now - 2_592_000;

    let pricing = load_pricing(conn);
    let month_cutoff = local_month_cutoff(conn, month_cutoff_day);

    // Time-windowed totals
    let (tokens_5h, tokens_7d, tokens_30d, tokens_total) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN timestamp >= ?2 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?3 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?4 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(tokens_total), 0)
             FROM usage_messages WHERE provider = ?1",
            params![provider, t5h, t7d, t30d],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
        )
        .ok()?;

    // Token type totals
    let (input, output, cache_write, cache_read, thoughts) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(tokens_input), 0),
                COALESCE(SUM(tokens_output), 0),
                COALESCE(SUM(tokens_cache_write), 0),
                COALESCE(SUM(tokens_cache_read), 0),
                COALESCE(SUM(tokens_thoughts), 0)
             FROM usage_messages WHERE provider = ?1",
            params![provider],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            )),
        )
        .unwrap_or((0, 0, 0, 0, 0));

    let has_type_breakdown = input > 0 || output > 0;

    // Costs per window
    let cost_5h = windowed_cost(conn, provider, t5h, &pricing);
    let cost_7d = windowed_cost(conn, provider, t7d, &pricing);
    let cost_30d = windowed_cost(conn, provider, t30d, &pricing);
    let cost_total = windowed_cost(conn, provider, 0, &pricing);
    let cost_month = windowed_cost(conn, provider, month_cutoff, &pricing);

    let top_models = query_top_models(conn, provider, &pricing);
    let top_tasks = query_top_tasks(conn, provider, &pricing);
    let top_projects = query_top_projects(conn, provider, &pricing);

    Some(LocalUsageDetails {
        source_type: "local".to_string(),
        confidence: "observed".to_string(),
        tokens_total: tokens_total as u64,
        tokens_input: if has_type_breakdown { Some(input as u64) } else { None },
        tokens_output: if has_type_breakdown { Some(output as u64) } else { None },
        tokens_cached: if has_type_breakdown { Some((cache_write + cache_read) as u64) } else { None },
        tokens_thoughts: if thoughts > 0 { Some(thoughts as u64) } else { None },
        tokens_5h: tokens_5h as u64,
        tokens_7d: tokens_7d as u64,
        tokens_30d: tokens_30d as u64,
        cost_total,
        cost_month,
        cost_5h,
        cost_7d,
        cost_30d,
        top_models,
        top_tasks,
        top_projects,
    })
}

/// Query local details scoped to a specific time window.
pub fn windowed_details(conn: &Connection, provider: &str, window: &str, month_cutoff_day: u32) -> Option<LocalUsageDetails> {
    let now = now_epoch_seconds() as i64;
    let cutoff = match window {
        "5h" => now - 18_000,
        "7d" => now - 604_800,
        "30d" => now - 2_592_000,
        _ => return None,
    };

    let pricing = load_pricing(conn);
    let month_cutoff = local_month_cutoff(conn, month_cutoff_day);

    let tokens_total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(tokens_total), 0) FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2",
            params![provider, cutoff],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let (input, output, cache_write, cache_read, thoughts) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(tokens_input), 0),
                COALESCE(SUM(tokens_output), 0),
                COALESCE(SUM(tokens_cache_write), 0),
                COALESCE(SUM(tokens_cache_read), 0),
                COALESCE(SUM(tokens_thoughts), 0)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2",
            params![provider, cutoff],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            )),
        )
        .unwrap_or((0, 0, 0, 0, 0));

    let has_type_breakdown = input > 0 || output > 0;

    let cost_window = windowed_cost(conn, provider, cutoff, &pricing);

    let t5h = now - 18_000;
    let t7d = now - 604_800;
    let t30d = now - 2_592_000;
    let (tokens_5h, tokens_7d, tokens_30d) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN timestamp >= ?2 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?3 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?4 THEN tokens_total ELSE 0 END), 0)
             FROM usage_messages WHERE provider = ?1",
            params![provider, t5h, t7d, t30d],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        )
        .unwrap_or((0, 0, 0));

    let cost_5h = windowed_cost(conn, provider, t5h, &pricing);
    let cost_7d = windowed_cost(conn, provider, t7d, &pricing);
    let cost_30d = windowed_cost(conn, provider, t30d, &pricing);
    let cost_month = windowed_cost(conn, provider, month_cutoff, &pricing);

    let top_models = query_top_models_since(conn, provider, cutoff, &pricing);
    let top_tasks = query_top_tasks_since(conn, provider, cutoff, &pricing);
    let top_projects = query_top_projects_since(conn, provider, cutoff, &pricing);

    Some(LocalUsageDetails {
        source_type: "local".to_string(),
        confidence: "observed".to_string(),
        tokens_total: tokens_total as u64,
        tokens_input: if has_type_breakdown { Some(input as u64) } else { None },
        tokens_output: if has_type_breakdown { Some(output as u64) } else { None },
        tokens_cached: if has_type_breakdown { Some((cache_write + cache_read) as u64) } else { None },
        tokens_thoughts: if thoughts > 0 { Some(thoughts as u64) } else { None },
        tokens_5h: tokens_5h as u64,
        tokens_7d: tokens_7d as u64,
        tokens_30d: tokens_30d as u64,
        cost_total: cost_window,
        cost_month,
        cost_5h,
        cost_7d,
        cost_30d,
        top_models,
        top_tasks,
        top_projects,
    })
}

fn query_top_models(conn: &Connection, provider: &str, pricing: &PricingMap) -> Vec<UsageNamedTokens> {
    query_top_models_since(conn, provider, 0, pricing)
}

fn query_top_models_since(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Vec<UsageNamedTokens> {
    let mut stmt = match conn
        .prepare(
            "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'), SUM(tokens_total),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
             GROUP BY COALESCE(pricing_provider, provider), model ORDER BY 3 DESC LIMIT 5",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![provider, since], |row| {
        let pricing_provider: String = row.get(0)?;
        let name: String = row.get(1)?;
        let tokens = row.get::<_, i64>(2)? as u64;
        let input: i64 = row.get(3)?;
        let output: i64 = row.get(4)?;
        let cache_read: i64 = row.get(5)?;
        let cache_write: i64 = row.get(6)?;
        let thoughts: i64 = row.get(7)?;
        let recorded_cost: f64 = row.get(8)?;
        let has_recorded_cost: i64 = row.get(9)?;
        Ok((pricing_provider, name, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(pricing_provider, name, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost)| {
        let cost = resolved_cost(
            &pricing_provider,
            &name,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        );
        UsageNamedTokens { name, tokens, cost }
    })
    .collect()
}

fn query_top_tasks(conn: &Connection, provider: &str, pricing: &PricingMap) -> Vec<UsageTask> {
    query_top_tasks_since(conn, provider, 0, pricing)
}

fn query_top_tasks_since(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Vec<UsageTask> {
    let mut stmt = match conn
        .prepare(
            "SELECT session_id, COALESCE(project, ''), SUM(tokens_total), MAX(model), MAX(timestamp),
                    COALESCE(MAX(pricing_provider), provider),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
             GROUP BY session_id ORDER BY 3 DESC LIMIT 5",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![provider, since], |row| {
        let session_id: String = row.get(0)?;
        let project: String = row.get(1)?;
        let tokens: i64 = row.get(2)?;
        let model: Option<String> = row.get(3)?;
        let updated_at: Option<i64> = row.get(4)?;
        let pricing_provider: String = row.get(5)?;
        let input: i64 = row.get(6)?;
        let output: i64 = row.get(7)?;
        let cache_read: i64 = row.get(8)?;
        let cache_write: i64 = row.get(9)?;
        let thoughts: i64 = row.get(10)?;
        let recorded_cost: f64 = row.get(11)?;
        let has_recorded_cost: i64 = row.get(12)?;
        Ok((session_id, project, tokens, model, updated_at, pricing_provider, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(session_id, project, tokens, model, updated_at, pricing_provider, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost)| {
        let cost = model.as_deref().and_then(|name| resolved_cost(
            &pricing_provider,
            name,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
        UsageTask {
            id: session_id.clone(),
            label: session_id,
            tokens: tokens as u64,
            cost,
            model,
            project: if project.is_empty() { None } else { Some(project) },
            updated_at: updated_at.map(|t| t.to_string()),
        }
    })
    .collect()
}

fn query_top_projects(conn: &Connection, provider: &str, pricing: &PricingMap) -> Vec<UsageProject> {
    query_top_projects_since(conn, provider, 0, pricing)
}

fn query_top_projects_since(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Vec<UsageProject> {
    let mut stmt = match conn
        .prepare(
            "SELECT COALESCE(project, 'unknown'), SUM(tokens_total), COUNT(DISTINCT session_id),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
             GROUP BY project ORDER BY 2 DESC LIMIT 5",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![provider, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(name, tokens, sessions, _input, _output, _cache_read, _cache_write, _thoughts)| {
        let cost = windowed_cost_for_project(conn, provider, since, &name, pricing);
        UsageProject {
            name,
            tokens: tokens as u64,
            cost,
            sessions: Some(sessions as u64),
        }
    })
    .collect()
}

/// Calculate cost for a specific project by summing per-model costs.
fn windowed_cost_for_project(conn: &Connection, provider: &str, since: i64, project: &str, pricing: &PricingMap) -> Option<f64> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
         FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2 AND COALESCE(project, 'unknown') = ?3
         GROUP BY COALESCE(pricing_provider, provider), model"
    ).ok()?;

    let mut total_cost = 0.0;
    let mut has_any = false;

    let rows = stmt.query_map(params![provider, since, project], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    }).ok()?;

    for row in rows.flatten() {
        let (pricing_provider, model, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if let Some(cost) = resolved_cost(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ) {
            total_cost += cost;
            has_any = true;
        }
    }

    if has_any { Some(total_cost) } else { None }
}

pub fn usage_overview(conn: &Connection, window: &str) -> Option<UsageOverview> {
    let now = now_epoch_seconds() as i64;
    let (cutoff, bucket_count, mode) = match window {
        "5h" => (now - 18_000, 5_i64, BucketMode::Hourly),
        "7d" => (now - 604_800, 7_i64, BucketMode::Daily),
        "30d" => (now - 2_592_000, 30_i64, BucketMode::Daily),
        "365d" => (now - 31_536_000, 365_i64, BucketMode::Daily),
        _ => return None,
    };

    let pricing = load_pricing(conn);
    let trend = query_trend(conn, cutoff, bucket_count, mode, &pricing);
    let providers = query_provider_summaries(conn, cutoff, &pricing, &trend);
    let total_tokens: u64 = providers.iter().map(|p| p.tokens).sum();
    let total_cost_value: f64 = providers.iter().filter_map(|p| p.cost).sum();
    let total_cost = providers.iter().any(|p| p.cost.is_some()).then_some(total_cost_value);
    let top_models = query_top_models_all(conn, cutoff, &pricing, bucket_count, mode);
    let top_projects = query_top_projects_all(conn, cutoff, &pricing, bucket_count, mode);
    let active_projects = count_distinct(conn, cutoff, "COALESCE(project, '')", true, mode);
    let active_sessions = count_sessions(conn, cutoff, mode);

    Some(UsageOverview {
        window: window.to_string(),
        total_tokens,
        total_cost,
        active_projects,
        active_sessions,
        providers,
        trend,
        top_models,
        top_projects,
    })
}

fn query_provider_summaries(
    conn: &Connection,
    since: i64,
    pricing: &PricingMap,
    trend: &[UsageTrendBucket],
) -> Vec<UsageOverviewProvider> {
    let mut stmt = match conn
        .prepare(
            "SELECT provider, SUM(tokens_total), SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts)
             FROM usage_messages
             WHERE timestamp >= ?1
             GROUP BY provider
             ORDER BY 2 DESC",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let raw: Vec<(String, u64, Option<f64>)> = match stmt
        .query_map(params![since], |row| {
            let provider: String = row.get(0)?;
            let tokens = row.get::<_, i64>(1)? as u64;
            let cost = windowed_cost_for_provider(conn, &provider, since, pricing);
            Ok((provider, tokens, cost))
        }) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return Vec::new(),
    };

    let total_tokens: u64 = raw.iter().map(|(_, tokens, _)| *tokens).sum();

    raw.into_iter()
        .map(|(provider, tokens, cost)| UsageOverviewProvider {
            trend: trend
                .iter()
                .map(|bucket| {
                    bucket
                        .providers
                        .iter()
                        .find(|entry| entry.provider == provider)
                        .map(|entry| entry.tokens)
                        .unwrap_or(0)
                })
                .collect(),
            provider,
            tokens,
            cost,
            share_percent: if total_tokens > 0 {
                tokens as f64 / total_tokens as f64 * 100.0
            } else {
                0.0
            },
        })
        .collect()
}

fn query_trend(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    mode: BucketMode,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    match mode {
        BucketMode::Hourly => query_trend_hourly(conn, since, bucket_count, pricing),
        BucketMode::Daily => query_trend_daily(conn, since, bucket_count, pricing),
    }
}

fn query_top_models_all(
    conn: &Connection,
    since: i64,
    pricing: &PricingMap,
    bucket_count: i64,
    mode: BucketMode,
) -> Vec<UsageBreakdownItem> {
    let mut stmt = match conn
        .prepare(
            "SELECT provider, COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'), SUM(tokens_total),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages
             WHERE timestamp >= ?1
             GROUP BY provider, COALESCE(pricing_provider, provider), model
             ORDER BY 4 DESC
             LIMIT 6",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, f64>(9)?,
            row.get::<_, i64>(10)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(provider, pricing_provider, label, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost)| {
        let cost = resolved_cost(
            &pricing_provider,
            &label,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        );
        let trend = query_named_trend(conn, since, bucket_count, mode, "model", &provider, &label);
        UsageBreakdownItem {
            provider,
            label,
            tokens: tokens as u64,
            cost,
            sessions: None,
            trend,
        }
    })
    .collect()
}

fn query_top_projects_all(
    conn: &Connection,
    since: i64,
    pricing: &PricingMap,
    bucket_count: i64,
    mode: BucketMode,
) -> Vec<UsageBreakdownItem> {
    let mut stmt = match conn
        .prepare(
            "SELECT provider, COALESCE(project, 'unknown'), SUM(tokens_total), COUNT(DISTINCT session_id)
             FROM usage_messages
             WHERE timestamp >= ?1
             GROUP BY provider, project
             ORDER BY 3 DESC
             LIMIT 6",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(provider, label, tokens, sessions)| {
        let cost = windowed_cost_for_project(conn, &provider, since, &label, pricing);
        let trend = query_named_trend(conn, since, bucket_count, mode, "project", &provider, &label);
        UsageBreakdownItem {
            cost,
            provider,
            label,
            tokens: tokens as u64,
            sessions: Some(sessions as u64),
            trend,
        }
    })
    .collect()
}

fn query_named_trend(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    mode: BucketMode,
    dimension: &str,
    provider: &str,
    label: &str,
) -> Vec<u64> {
    match mode {
        BucketMode::Hourly => query_named_trend_hourly(conn, since, bucket_count, dimension, provider, label),
        BucketMode::Daily => query_named_trend_daily(conn, since, bucket_count, dimension, provider, label),
    }
}

fn windowed_cost_for_provider(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Option<f64> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
         FROM usage_messages
         WHERE provider = ?1 AND timestamp >= ?2
         GROUP BY COALESCE(pricing_provider, provider), model"
    ).ok()?;

    let mut total_cost = 0.0;
    let mut has_any = false;

    let rows = stmt.query_map(params![provider, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    }).ok()?;

    for row in rows.flatten() {
        let (pricing_provider, model, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if let Some(cost) = resolved_cost(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ) {
            total_cost += cost;
            has_any = true;
        }
    }

    if has_any { Some(total_cost) } else { None }
}

fn count_distinct(conn: &Connection, since: i64, field: &str, skip_empty: bool, mode: BucketMode) -> u64 {
    match mode {
        BucketMode::Hourly => {
            let query = if skip_empty {
                format!(
                    "SELECT COUNT(DISTINCT {field}) FROM usage_messages WHERE timestamp >= ?1 AND {field} != ''"
                )
            } else {
                format!("SELECT COUNT(DISTINCT {field}) FROM usage_messages WHERE timestamp >= ?1")
            };
            conn.query_row(query.as_str(), params![since], |row| row.get::<_, i64>(0))
                .unwrap_or(0) as u64
        }
        BucketMode::Daily => {
            let cutoff_date = cutoff_local_date(conn, since);
            let query = if skip_empty {
                format!(
                    "SELECT COUNT(DISTINCT {field}) FROM (
                        SELECT {field} AS value FROM usage_messages WHERE timestamp >= ?1 AND {field} != ''
                        UNION
                        SELECT {field} AS value FROM usage_daily WHERE date >= ?2 AND {field} != ''
                    )"
                )
            } else {
                format!(
                    "SELECT COUNT(DISTINCT {field}) FROM (
                        SELECT {field} AS value FROM usage_messages WHERE timestamp >= ?1
                        UNION
                        SELECT {field} AS value FROM usage_daily WHERE date >= ?2
                    )"
                )
            };
            conn.query_row(query.as_str(), params![since, cutoff_date], |row| row.get::<_, i64>(0))
                .unwrap_or(0) as u64
        }
    }
}

fn count_sessions(conn: &Connection, since: i64, mode: BucketMode) -> u64 {
    match mode {
        BucketMode::Hourly => conn
            .query_row(
                "SELECT COUNT(DISTINCT session_id) FROM usage_messages WHERE timestamp >= ?1",
                params![since],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) as u64,
        BucketMode::Daily => {
            let cutoff_date = cutoff_local_date(conn, since);
            let detailed: u64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT session_id) FROM usage_messages WHERE timestamp >= ?1",
                    params![since],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as u64;
            let rolled: u64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(message_count), 0) FROM usage_daily WHERE date >= ?1",
                    params![cutoff_date],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as u64;
            detailed.max(rolled)
        }
    }
}

#[derive(Clone, Copy)]
enum BucketMode {
    Hourly,
    Daily,
}

fn query_trend_hourly(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    let hour_start = align_to_local_hour(conn, since);
    let mut bucket_map: BTreeMap<i64, BTreeMap<String, (u64, f64, bool)>> = BTreeMap::new();
    let mut stmt = match conn
        .prepare(
            "SELECT provider,
                    CAST((strftime('%s', strftime('%Y-%m-%d %H:00:00', timestamp, 'unixepoch', 'localtime')) - ?1) / 3600 AS INTEGER) as bucket_idx,
                    COALESCE(pricing_provider, provider),
                    COALESCE(model, 'unknown'),
                    SUM(tokens_total),
                    SUM(tokens_input),
                    SUM(tokens_output),
                    SUM(tokens_cache_read),
                    SUM(tokens_cache_write),
                    SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0),
                    MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages
             WHERE timestamp >= ?2
             GROUP BY provider, bucket_idx, COALESCE(pricing_provider, provider), model",
        ) {
        Ok(s) => s,
        Err(_) => return build_trend_buckets(bucket_count, hour_start, 3600, bucket_map),
    };

    let rows = match stmt.query_map(params![hour_start, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, f64>(10)?,
            row.get::<_, i64>(11)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return build_trend_buckets(bucket_count, hour_start, 3600, bucket_map),
    };

    for row in rows.flatten() {
        let (provider, bucket_idx, pricing_provider, model, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if bucket_idx < 0 || bucket_idx >= bucket_count {
            continue;
        }
        let provider_map = bucket_map.entry(bucket_idx).or_default();
        let entry = provider_map.entry(provider).or_insert((0, 0.0, false));
        entry.0 += tokens as u64;
        if let Some(cost) = resolved_cost(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ) {
            entry.1 += cost;
            entry.2 = true;
        }
    }

    build_trend_buckets(bucket_count, hour_start, 3600, bucket_map)
}

fn query_trend_daily(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    let day_start = cutoff_local_date(conn, since);
    let cutoff_date = day_start.clone();
    let mut bucket_map: BTreeMap<i64, BTreeMap<String, (u64, f64, bool)>> = BTreeMap::new();
    let mut stmt = match conn
        .prepare(
            "SELECT provider,
                    CAST(julianday(bucket_day) - julianday(?1) AS INTEGER) as bucket_idx,
                    pricing_provider,
                    COALESCE(model, 'unknown'),
                    SUM(tokens_total),
                    SUM(tokens_input),
                    SUM(tokens_output),
                    SUM(tokens_cache_read),
                    SUM(tokens_cache_write),
                    SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0),
                    MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM (
                SELECT provider, date(timestamp, 'unixepoch', 'localtime') as bucket_day, COALESCE(pricing_provider, provider) as pricing_provider, model,
                       tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
                FROM usage_messages
                WHERE timestamp >= ?2
                UNION ALL
                SELECT provider, date as bucket_day, COALESCE(pricing_provider, provider) as pricing_provider, model,
                       tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
                FROM usage_daily
                WHERE date >= ?1
             )
             GROUP BY provider, bucket_idx, pricing_provider, model",
        ) {
        Ok(s) => s,
        Err(_) => {
            let start_epoch = day_start_epoch(conn, &day_start);
            return build_trend_buckets(bucket_count, start_epoch, 86_400, bucket_map);
        }
    };

    let rows = match stmt.query_map(params![cutoff_date, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, f64>(10)?,
            row.get::<_, i64>(11)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => {
            let start_epoch = day_start_epoch(conn, &day_start);
            return build_trend_buckets(bucket_count, start_epoch, 86_400, bucket_map);
        }
    };

    for row in rows.flatten() {
        let (provider, bucket_idx, pricing_provider, model, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if bucket_idx < 0 || bucket_idx >= bucket_count {
            continue;
        }
        let provider_map = bucket_map.entry(bucket_idx).or_default();
        let entry = provider_map.entry(provider).or_insert((0, 0.0, false));
        entry.0 += tokens as u64;
        if let Some(cost) = resolved_cost(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ) {
            entry.1 += cost;
            entry.2 = true;
        }
    }

    let start_epoch = day_start_epoch(conn, &day_start);
    build_trend_buckets(bucket_count, start_epoch, 86_400, bucket_map)
}

fn build_trend_buckets(
    bucket_count: i64,
    start_epoch: i64,
    bucket_span_secs: i64,
    bucket_map: BTreeMap<i64, BTreeMap<String, (u64, f64, bool)>>,
) -> Vec<UsageTrendBucket> {
    (0..bucket_count)
        .map(|bucket_idx| {
            let start = start_epoch + bucket_idx * bucket_span_secs;
            let end = start + bucket_span_secs;
            let providers = bucket_map
                .get(&bucket_idx)
                .map(|items| items.iter().map(|(provider, (tokens, cost, has_cost))| UsageTrendProviderValue {
                    provider: provider.clone(),
                    tokens: *tokens,
                    cost: (*has_cost).then_some(*cost),
                }).collect::<Vec<_>>())
                .unwrap_or_default();
            let tokens = providers.iter().map(|p| p.tokens).sum();
            let cost_sum: f64 = providers.iter().filter_map(|p| p.cost).sum();
            let has_cost = providers.iter().any(|p| p.cost.is_some());
            UsageTrendBucket {
                start,
                end,
                label: String::new(),
                tokens,
                cost: has_cost.then_some(cost_sum),
                providers,
            }
        })
        .collect()
}

fn query_named_trend_hourly(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    dimension: &str,
    provider: &str,
    label: &str,
) -> Vec<u64> {
    let hour_start = align_to_local_hour(conn, since);
    let column = match dimension {
        "model" => "COALESCE(model, 'unknown')",
        "project" => "COALESCE(project, 'unknown')",
        _ => return vec![0; bucket_count as usize],
    };
    let query = format!(
        "SELECT CAST((strftime('%s', strftime('%Y-%m-%d %H:00:00', timestamp, 'unixepoch', 'localtime')) - ?1) / 3600 AS INTEGER) as bucket_idx,
                SUM(tokens_total)
         FROM usage_messages
         WHERE timestamp >= ?2 AND provider = ?3 AND {column} = ?4
         GROUP BY bucket_idx
         ORDER BY bucket_idx"
    );
    fill_named_trend(conn, query.as_str(), params![hour_start, since, provider, label], bucket_count)
}

fn query_named_trend_daily(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    dimension: &str,
    provider: &str,
    label: &str,
) -> Vec<u64> {
    let cutoff_date = cutoff_local_date(conn, since);
    let column = match dimension {
        "model" => "COALESCE(model, 'unknown')",
        "project" => "COALESCE(project, 'unknown')",
        _ => return vec![0; bucket_count as usize],
    };
    let query = format!(
        "SELECT CAST(julianday(bucket_day) - julianday(?1) AS INTEGER) as bucket_idx, SUM(tokens_total)
         FROM (
            SELECT date(timestamp, 'unixepoch', 'localtime') as bucket_day, provider, model, project, tokens_total
            FROM usage_messages
            WHERE timestamp >= ?2
            UNION ALL
            SELECT date as bucket_day, provider, model, project, tokens_total
            FROM usage_daily
            WHERE date >= ?1
         )
         WHERE provider = ?3 AND {column} = ?4
         GROUP BY bucket_idx
         ORDER BY bucket_idx"
    );
    fill_named_trend(conn, query.as_str(), params![cutoff_date, since, provider, label], bucket_count)
}

fn fill_named_trend<P: rusqlite::Params>(
    conn: &Connection,
    query: &str,
    params: P,
    bucket_count: i64,
) -> Vec<u64> {
    let mut values = vec![0; bucket_count as usize];
    let mut stmt = match conn.prepare(query) {
        Ok(stmt) => stmt,
        Err(_) => return values,
    };
    let rows = match stmt.query_map(params, |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    }) {
        Ok(rows) => rows,
        Err(_) => return values,
    };
    for row in rows.flatten() {
        let (bucket_idx, tokens) = row;
        if bucket_idx >= 0 && bucket_idx < bucket_count {
            values[bucket_idx as usize] = tokens as u64;
        }
    }
    values
}

fn cutoff_local_date(conn: &Connection, since: i64) -> String {
    conn.query_row(
        "SELECT date(?1, 'unixepoch', 'localtime')",
        params![since],
        |row| row.get::<_, String>(0),
    ).unwrap_or_else(|_| "1970-01-01".to_string())
}

fn day_start_epoch(conn: &Connection, date: &str) -> i64 {
    conn.query_row(
        "SELECT CAST(strftime('%s', ?1 || ' 00:00:00') AS INTEGER)",
        params![date],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(0)
}

fn align_to_local_hour(conn: &Connection, since: i64) -> i64 {
    conn.query_row(
        "SELECT CAST(strftime('%s', strftime('%Y-%m-%d %H:00:00', ?1, 'unixepoch', 'localtime')) AS INTEGER)",
        params![since],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(since)
}
