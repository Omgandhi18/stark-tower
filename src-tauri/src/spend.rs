//! Turn costs stay on this machine, alongside the conversations they belong to.
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{Emitter, Manager};

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS turn_usage (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, agent_id TEXT NOT NULL,
    conversation_id INTEGER, task_id TEXT, project TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, cost_usd REAL, running_total REAL, session_id TEXT,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, context_tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_time ON turn_usage(ts);
CREATE INDEX IF NOT EXISTS usage_conversation ON turn_usage(conversation_id);
CREATE INDEX IF NOT EXISTS usage_session ON turn_usage(provider, session_id, id);
CREATE TABLE IF NOT EXISTS budget_notices (
    period TEXT NOT NULL, start_date TEXT NOT NULL, level INTEGER NOT NULL, limit_usd REAL NOT NULL,
    PRIMARY KEY(period, start_date, level, limit_usd)
);";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum BudgetPeriod {
    Day,
    Week,
    #[default]
    Month,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct Budget {
    pub period: BudgetPeriod,
    pub limit_usd: f64,
    pub warn_percent: u8,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            period: BudgetPeriod::Month,
            limit_usd: 0.0,
            warn_percent: 80,
        }
    }
}
impl Budget {
    pub fn validate(&self) -> Result<(), String> {
        if !self.limit_usd.is_finite() || self.limit_usd < 0.0 {
            return Err("Use a dollar amount of zero or more.".into());
        }
        if !(50..=95).contains(&self.warn_percent) {
            return Err("Choose a warning between 50% and 95%.".into());
        }
        Ok(())
    }
    fn key(&self) -> &'static str {
        match self.period {
            BudgetPeriod::Day => "day",
            BudgetPeriod::Week => "week",
            BudgetPeriod::Month => "month",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Session {
    pub project: String,
    pub provider: String,
    pub model: String,
    pub session_id: Option<String>,
}
impl Session {
    pub fn launched(launch: &crate::chat::Launch) -> Self {
        Self {
            project: launch.cwd.clone(),
            provider: match launch.engine.kind.as_str() {
                "claude-code" => "claude".into(),
                other => other.into(),
            },
            model: launch.model.clone(),
            session_id: launch.resume.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, specta::Type, PartialEq)]
pub struct SpendTotal {
    pub cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub context_tokens: i64,
    pub turns: i64,
    pub unpriced_turns: i64,
}
impl SpendTotal {
    fn add(&mut self, other: &Self) {
        self.cost_usd += other.cost_usd;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.context_tokens += other.context_tokens;
        self.turns += other.turns;
        self.unpriced_turns += other.unpriced_turns;
    }
}
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SpendGroup {
    pub key: String,
    pub total: SpendTotal,
}
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SpendDay {
    pub date: String,
    pub total: SpendTotal,
}
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SpendSummary {
    pub today: SpendTotal,
    pub week: SpendTotal,
    pub month: SpendTotal,
    pub budget: Budget,
    pub budget_spend: f64,
    pub days: Vec<SpendDay>,
    pub agents: Vec<SpendGroup>,
    pub projects: Vec<SpendGroup>,
    pub models: Vec<SpendGroup>,
    pub first_date: Option<String>,
    pub has_spend: bool,
}
#[derive(Debug, Clone, Default, Serialize, specta::Type)]
pub struct ConversationSpend {
    pub total: SpendTotal,
    pub context_tokens: i64,
}

pub(crate) fn cost_delta(reading: f64, previous: f64) -> f64 {
    if reading >= previous {
        reading - previous
    } else {
        reading
    }
}
fn starts(date: NaiveDate) -> [NaiveDate; 3] {
    [
        date,
        date - Duration::days(date.weekday().num_days_from_monday().into()),
        date.with_day(1).unwrap(),
    ]
}
fn midnight<T: TimeZone>(zone: &T, date: NaiveDate) -> i64 {
    // Some time zones move their clocks at midnight. Use the first valid instant.
    let start = date.and_hms_opt(0, 0, 0).unwrap();
    for minute in 0..=180 {
        if let Some(time) = zone
            .from_local_datetime(&(start + Duration::minutes(minute)))
            .earliest()
        {
            return time.timestamp_millis();
        }
    }
    zone.from_utc_datetime(&start).timestamp_millis()
}
fn group_rows(groups: BTreeMap<String, SpendTotal>) -> Vec<SpendGroup> {
    let mut rows: Vec<_> = groups
        .into_iter()
        .map(|(key, total)| SpendGroup { key, total })
        .collect();
    rows.sort_by(|a, b| {
        b.total
            .cost_usd
            .total_cmp(&a.total.cost_usd)
            .then_with(|| {
                (b.total.input_tokens + b.total.output_tokens)
                    .cmp(&(a.total.input_tokens + a.total.output_tokens))
            })
            .then_with(|| a.key.cmp(&b.key))
    });
    rows
}

impl crate::ledger::Ledger {
    pub(crate) fn record_usage(
        &self,
        row: &UsageRow,
        budget: &Budget,
    ) -> Result<(Option<f64>, Vec<u8>), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let previous = if row.usage.running_total.is_some() {
            if let Some(id) = &row.session.session_id {
                tx.query_row("SELECT running_total FROM turn_usage WHERE provider = ?2 AND session_id = ?1 AND running_total IS NOT NULL ORDER BY id DESC LIMIT 1", params![id, row.session.provider], |r| r.get::<_, f64>(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0.0)
            } else {
                0.0
            }
        } else {
            0.0
        };
        let valid_cost = |v: f64| v.is_finite() && v >= 0.0;
        let running = row.usage.running_total.filter(|v| valid_cost(*v));
        let cost = running
            .map(|r| cost_delta(r, previous))
            .or_else(|| row.usage.cost_usd.filter(|v| valid_cost(*v)));
        tx.execute("INSERT INTO turn_usage (ts, agent_id, conversation_id, task_id, project, provider, model, cost_usd, running_total, session_id, input_tokens, output_tokens, context_tokens) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)", params![row.ts, row.agent_id, row.conversation_id, row.task_id, row.session.project, row.session.provider, row.session.model, cost, running, row.session.session_id, row.usage.input_tokens as i64, row.usage.output_tokens as i64, row.usage.context_tokens as i64]).map_err(|e| e.to_string())?;
        let mut notices = vec![];
        if budget.limit_usd > 0.0 && cost.is_some_and(|c| c > 0.0) {
            let date = Local
                .timestamp_millis_opt(row.ts)
                .single()
                .ok_or("The turn's time couldn't be read.")?
                .date_naive();
            let start = starts(date)[match budget.period {
                BudgetPeriod::Day => 0,
                BudgetPeriod::Week => 1,
                BudgetPeriod::Month => 2,
            }];
            let total: f64 = tx
                .query_row(
                    "SELECT COALESCE(SUM(cost_usd), 0) FROM turn_usage WHERE ts >= ?1 AND ts < ?2",
                    params![
                        midnight(&Local, start),
                        midnight(&Local, date + Duration::days(1))
                    ],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            for level in [budget.warn_percent, 100] {
                let threshold = budget.limit_usd * f64::from(level) / 100.0;
                if total >= threshold && total - cost.unwrap_or(0.0) < threshold {
                    // Once per period and limit: a budget raised mid-period can warn again.
                    let added = tx.execute("INSERT OR IGNORE INTO budget_notices (period, start_date, level, limit_usd) VALUES (?1, ?2, ?3, ?4)", params![budget.key(), start.to_string(), if level == 100 { 100 } else { 0 }, budget.limit_usd]).map_err(|e| e.to_string())?;
                    if added > 0 {
                        notices.push(level);
                    }
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok((cost, notices))
    }

    pub fn spend_summary(&self, budget: Budget) -> Result<SpendSummary, String> {
        self.summary_at(budget, Local::now())
    }
    fn summary_at(&self, budget: Budget, now: DateTime<Local>) -> Result<SpendSummary, String> {
        let date = now.date_naive();
        let [today, week, month] = starts(date);
        let first_day = date - Duration::days(29);
        let conn = self.conn.lock().unwrap();
        let (first, has_spend): (Option<i64>, bool) = conn.query_row("SELECT MIN(ts), EXISTS(SELECT 1 FROM turn_usage WHERE cost_usd > 0) FROM turn_usage", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        let mut summary = SpendSummary {
            today: SpendTotal::default(),
            week: SpendTotal::default(),
            month: SpendTotal::default(),
            budget,
            budget_spend: 0.0,
            days: (0..30)
                .map(|n| SpendDay {
                    date: (first_day + Duration::days(n)).to_string(),
                    total: SpendTotal::default(),
                })
                .collect(),
            agents: vec![],
            projects: vec![],
            models: vec![],
            has_spend,
            first_date: first
                .and_then(|ts| Local.timestamp_millis_opt(ts).single())
                .map(|d| d.date_naive().to_string()),
        };
        let mut agents: BTreeMap<String, SpendTotal> = BTreeMap::new();
        let mut projects: BTreeMap<String, SpendTotal> = BTreeMap::new();
        let mut models: BTreeMap<String, SpendTotal> = BTreeMap::new();
        let mut stmt = conn.prepare("SELECT ts, agent_id, project, model, cost_usd, input_tokens, output_tokens, context_tokens FROM turn_usage WHERE ts >= ?1 AND ts < ?2").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    midnight(&Local, first_day.min(month)),
                    midnight(&Local, date + Duration::days(1))
                ],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<f64>>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (ts, agent, project, model, cost, input_tokens, output_tokens, context_tokens) =
                row.map_err(|e| e.to_string())?;
            let day = Local
                .timestamp_millis_opt(ts)
                .single()
                .ok_or("A recorded time couldn't be read.")?
                .date_naive();
            let total = SpendTotal {
                cost_usd: cost.unwrap_or(0.0),
                input_tokens,
                output_tokens,
                context_tokens,
                turns: 1,
                unpriced_turns: i64::from(cost.is_none()),
            };
            if day >= today {
                summary.today.add(&total);
            }
            if day >= week {
                summary.week.add(&total);
            }
            if day >= first_day {
                summary.days[(day - first_day).num_days() as usize]
                    .total
                    .add(&total);
            }
            if day >= month {
                summary.month.add(&total);
                agents.entry(agent).or_default().add(&total);
                projects.entry(project).or_default().add(&total);
                models.entry(model).or_default().add(&total);
            }
        }
        summary.budget_spend = match summary.budget.period {
            BudgetPeriod::Day => summary.today.cost_usd,
            BudgetPeriod::Week => summary.week.cost_usd,
            BudgetPeriod::Month => summary.month.cost_usd,
        };
        summary.agents = group_rows(agents);
        summary.projects = group_rows(projects);
        summary.models = group_rows(models);
        Ok(summary)
    }
    pub(crate) fn settle_budget_notices(&self) -> usize {
        self.conn.lock().unwrap().execute(
            "UPDATE notifications SET handled = ?1, outcome = 'Budget reviewed', read = 1 WHERE kind = 'budget' AND handled IS NULL",
            [Local::now().timestamp_millis()],
        ).unwrap_or(0)
    }

    pub fn conversation_spend(&self, id: i64) -> Result<ConversationSpend, String> {
        let conn = self.conn.lock().unwrap();
        let total = conn.query_row("SELECT COALESCE(SUM(cost_usd),0), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(context_tokens),0), COUNT(*), COALESCE(SUM(cost_usd IS NULL),0) FROM turn_usage WHERE conversation_id = ?1", [id], |r| Ok(SpendTotal { cost_usd: r.get(0)?, input_tokens: r.get(1)?, output_tokens: r.get(2)?, context_tokens: r.get(3)?, turns: r.get(4)?, unpriced_turns: r.get(5)? })).map_err(|e| e.to_string())?;
        let context_tokens = conn.query_row("SELECT context_tokens FROM turn_usage WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ConversationSpend {
            total,
            context_tokens,
        })
    }
}

pub(crate) struct UsageRow {
    pub ts: i64,
    pub agent_id: String,
    pub conversation_id: Option<i64>,
    pub task_id: Option<String>,
    pub session: Session,
    pub usage: crate::chat::TurnUsage,
}

pub(crate) fn record(
    app: &tauri::AppHandle,
    sink: &crate::chat::Sink,
    agent_id: &str,
    mut usage: crate::chat::TurnUsage,
) -> crate::chat::TurnUsage {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return usage;
    };
    let Some(session) = sink.usage_session.clone() else {
        return usage;
    };
    let budget = state.config.lock().unwrap().budget.clone();
    let row = UsageRow {
        ts: Local::now().timestamp_millis(),
        agent_id: agent_id.into(),
        conversation_id: sink.conversation_for(app, agent_id),
        task_id: sink.task_for(app, agent_id),
        session,
        usage,
    };
    match state.ledger.record_usage(&row, &budget) {
        Ok((cost, notices)) => {
            usage.cost_usd = cost;
            for level in notices {
                if let Ok(summary) = state.ledger.spend_summary(budget.clone()) {
                    let (period, headline_period) = match budget.period {
                        BudgetPeriod::Day => ("today's", "Today's"),
                        BudgetPeriod::Week => ("this week's", "This week's"),
                        BudgetPeriod::Month => ("this month's", "This month's"),
                    };
                    let title = if level == 100 {
                        format!(
                            "{} ${:.2} budget is used up: ${:.2} so far",
                            headline_period, budget.limit_usd, summary.budget_spend
                        )
                    } else {
                        format!(
                            "You've used {}% of {} ${:.2} budget",
                            level, period, budget.limit_usd
                        )
                    };
                    crate::notify::budget(app, agent_id, level == 100, &title);
                }
            }
            let _ = app.emit("spend://changed", ());
        }
        Err(e) => eprintln!("[spend] couldn't record this turn: {e}"),
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chat::TurnUsage, ledger::Ledger};

    fn row(cost: Option<f64>, running: Option<f64>, day: NaiveDate) -> UsageRow {
        UsageRow {
            ts: midnight(&Local, day) + 3_600_000,
            agent_id: "friday".into(),
            conversation_id: Some(42),
            task_id: Some("task-1".into()),
            session: Session {
                project: "/projects/app".into(),
                provider: if running.is_some() { "claude" } else { "codex" }.into(),
                model: "sonnet".into(),
                session_id: Some("saved-session".into()),
            },
            usage: TurnUsage {
                cost_usd: cost,
                running_total: running,
                input_tokens: 120,
                output_tokens: 30,
                context_tokens: 180,
            },
        }
    }
    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn ledger() -> Ledger {
        Ledger::open(std::path::Path::new(":memory:")).unwrap()
    }

    #[test]
    fn claude_deltas_include_clear_and_both_kinds_of_restart() {
        assert_eq!(cost_delta(2.0, 0.0), 2.0);
        assert_eq!(cost_delta(3.5, 2.0), 1.5);
        assert_eq!(cost_delta(3.5, 3.5), 0.0); // A resumed session carries its total.
        assert_eq!(cost_delta(0.5, 3.5), 0.5); // A restart resets it.
        assert_eq!(cost_delta(0.0, 0.5), 0.0); // /clear.
        assert_eq!(cost_delta(0.2, 0.0), 0.2);
    }

    #[test]
    fn periods_use_local_days_monday_weeks_and_calendar_months() {
        let sunday = date("2026-11-01");
        assert_eq!(starts(sunday), [sunday, date("2026-10-26"), sunday]);
        let monday = date("2026-11-02");
        assert_eq!(starts(monday), [monday, monday, sunday]);
        let east = chrono::FixedOffset::east_opt(19_800).unwrap();
        assert_eq!(
            midnight(&east, sunday),
            chrono::Utc
                .with_ymd_and_hms(2026, 10, 31, 18, 30, 0)
                .unwrap()
                .timestamp_millis()
        );
        let west = chrono::FixedOffset::west_opt(25_200).unwrap();
        assert_eq!(
            midnight(&west, sunday),
            chrono::Utc
                .with_ymd_and_hms(2026, 11, 1, 7, 0, 0)
                .unwrap()
                .timestamp_millis()
        );
        assert_eq!(starts(date("2027-01-01"))[1], date("2026-12-28"));
        assert_eq!(starts(date("2024-02-29"))[2], date("2024-02-01"));
    }

    #[test]
    fn ledger_round_trip_and_summary_keep_unpriced_turns() {
        let ledger = ledger();
        let day = Local::now().date_naive();
        let turn = row(None, Some(1.25), day);
        assert_eq!(
            ledger.record_usage(&turn, &Budget::default()).unwrap().0,
            Some(1.25)
        );
        ledger
            .record_usage(&row(None, None, day), &Budget::default())
            .unwrap();
        let saved: (String, String, String, String, String, f64, i64) = ledger.conn.lock().unwrap().query_row("SELECT agent_id, task_id, project, provider, session_id, running_total, conversation_id FROM turn_usage WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))).unwrap();
        assert_eq!(
            saved,
            (
                "friday".into(),
                "task-1".into(),
                "/projects/app".into(),
                "claude".into(),
                "saved-session".into(),
                1.25,
                42
            )
        );
        let chat = ledger.conversation_spend(42).unwrap();
        assert_eq!(
            chat.total,
            SpendTotal {
                cost_usd: 1.25,
                input_tokens: 240,
                output_tokens: 60,
                context_tokens: 360,
                turns: 2,
                unpriced_turns: 1
            }
        );
        assert_eq!(chat.context_tokens, 180);
        let summary = ledger.spend_summary(Budget::default()).unwrap();
        assert_eq!(summary.today, chat.total);
        assert_eq!(summary.days.len(), 30);
        assert_eq!(summary.days.last().unwrap().total, chat.total);
        assert_eq!(summary.agents[0].total, chat.total);
        assert_eq!(summary.projects[0].key, "/projects/app");
        assert_eq!(summary.models[0].key, "sonnet");
        assert_eq!(summary.first_date, Some(day.to_string()));
    }

    #[test]
    fn totals_respect_period_boundaries_and_include_zero_days() {
        let ledger = ledger();
        for (day, cost) in [
            ("2026-09-30", 10.0),
            ("2026-10-01", 3.0),
            ("2026-10-05", 2.0),
            ("2026-10-06", 1.0),
        ] {
            ledger
                .record_usage(&row(Some(cost), None, date(day)), &Budget::default())
                .unwrap();
        }
        let now = Local.with_ymd_and_hms(2026, 10, 6, 12, 0, 0).unwrap();
        let summary = ledger
            .summary_at(
                Budget {
                    period: BudgetPeriod::Week,
                    ..Budget::default()
                },
                now,
            )
            .unwrap();
        assert_eq!(summary.today.cost_usd, 1.0);
        assert_eq!(summary.week.cost_usd, 3.0);
        assert_eq!(summary.month.cost_usd, 6.0);
        assert_eq!(summary.budget_spend, 3.0);
        assert_eq!(summary.days[0].total.turns, 0);
        assert_eq!(summary.first_date, Some("2026-09-30".into()));
    }

    #[test]
    fn persisted_totals_and_notices_survive_reopening() {
        let path = std::env::current_dir()
            .unwrap()
            .join(format!(".spend-test-{}.sqlite", std::process::id()));
        let budget = Budget {
            period: BudgetPeriod::Day,
            limit_usd: 10.0,
            warn_percent: 80,
        };
        let day = date("2026-10-06");
        {
            let ledger = Ledger::open(&path).unwrap();
            assert!(ledger
                .record_usage(&row(None, Some(7.0), day), &budget)
                .unwrap()
                .1
                .is_empty());
            assert_eq!(
                ledger
                    .record_usage(&row(None, Some(8.0), day), &budget)
                    .unwrap()
                    .1,
                vec![80]
            );
        }
        {
            let ledger = Ledger::open(&path).unwrap();
            assert_eq!(
                ledger
                    .record_usage(&row(None, Some(9.0), day), &budget)
                    .unwrap(),
                (Some(1.0), vec![])
            );
            assert_eq!(
                ledger
                    .record_usage(&row(None, Some(10.0), day), &budget)
                    .unwrap()
                    .1,
                vec![100]
            );
            assert!(ledger
                .record_usage(&row(None, Some(11.0), day), &budget)
                .unwrap()
                .1
                .is_empty());
            assert_eq!(
                ledger
                    .record_usage(&row(Some(11.0), None, day + Duration::days(1)), &budget)
                    .unwrap()
                    .1,
                vec![80, 100]
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn warnings_reset_on_monday_and_the_first_of_the_month() {
        for (period, old, new) in [
            (BudgetPeriod::Week, "2026-10-04", "2026-10-05"),
            (BudgetPeriod::Month, "2026-10-31", "2026-11-01"),
        ] {
            let ledger = ledger();
            let budget = Budget {
                period,
                limit_usd: 10.0,
                warn_percent: 80,
            };
            assert_eq!(
                ledger
                    .record_usage(&row(Some(11.0), None, date(old)), &budget)
                    .unwrap()
                    .1,
                vec![80, 100]
            );
            assert!(ledger
                .record_usage(&row(Some(1.0), None, date(old)), &budget)
                .unwrap()
                .1
                .is_empty());
            assert_eq!(
                ledger
                    .record_usage(&row(Some(11.0), None, date(new)), &budget)
                    .unwrap()
                    .1,
                vec![80, 100]
            );
        }
    }

    #[test]
    fn a_changed_warning_does_not_repeat_and_unpriced_turns_do_not_cross() {
        let ledger = ledger();
        let day = date("2026-10-06");
        let budget = Budget {
            period: BudgetPeriod::Day,
            limit_usd: 10.0,
            warn_percent: 80,
        };
        assert_eq!(ledger.record_usage(&row(Some(8.0), None, day), &budget).unwrap().1, vec![80]);
        // Moving the warning line for the same limit doesn't warn twice.
        let changed = Budget { warn_percent: 90, ..budget };
        assert!(ledger.record_usage(&row(None, None, day), &changed).unwrap().1.is_empty());
        assert!(ledger.record_usage(&row(Some(1.0), None, day), &changed).unwrap().1.is_empty());
        assert_eq!(ledger.record_usage(&row(Some(1.0), None, day), &changed).unwrap().1, vec![100]);
    }

    #[test]
    fn running_totals_are_scoped_to_the_provider_and_session() {
        let ledger = ledger();
        let mut turn = row(None, Some(2.0), date("2026-10-06"));
        let budget = Budget::default();
        ledger.record_usage(&turn, &budget).unwrap();
        turn.usage.running_total = Some(0.5);
        assert_eq!(ledger.record_usage(&turn, &budget).unwrap().0, Some(0.5));
        turn.usage.running_total = Some(0.0);
        assert_eq!(ledger.record_usage(&turn, &budget).unwrap().0, Some(0.0));
        turn.usage.running_total = Some(1.0);
        assert_eq!(ledger.record_usage(&turn, &budget).unwrap().0, Some(1.0));
        turn.session.session_id = Some("new-session".into());
        assert_eq!(ledger.record_usage(&turn, &budget).unwrap().0, Some(1.0));
        turn.session.provider = "opencode".into();
        assert_eq!(ledger.record_usage(&turn, &budget).unwrap().0, Some(1.0));
        assert_eq!(ledger.record_usage(&turn, &budget).unwrap().0, Some(0.0));
    }

    #[test]
    fn groups_sort_by_cost_then_tokens_and_old_spending_keeps_the_chip_available() {
        let rows = group_rows(BTreeMap::from([
            (
                "priced".into(),
                SpendTotal {
                    cost_usd: 1.0,
                    ..SpendTotal::default()
                },
            ),
            (
                "few tokens".into(),
                SpendTotal {
                    input_tokens: 2,
                    ..SpendTotal::default()
                },
            ),
            (
                "many tokens".into(),
                SpendTotal {
                    input_tokens: 4,
                    ..SpendTotal::default()
                },
            ),
        ]));
        assert_eq!(
            rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            vec!["priced", "many tokens", "few tokens"]
        );
        let ledger = ledger();
        ledger
            .record_usage(
                &row(Some(1.0), None, date("2026-08-01")),
                &Budget::default(),
            )
            .unwrap();
        let summary = ledger
            .summary_at(
                Budget::default(),
                Local.with_ymd_and_hms(2026, 10, 6, 12, 0, 0).unwrap(),
            )
            .unwrap();
        assert_eq!(summary.month.turns, 0);
        assert!(summary.has_spend);
    }

    #[test]
    fn reviewing_the_budget_settles_alerts_without_resetting_crossing_markers() {
        let ledger = ledger();
        let budget = Budget {
            period: BudgetPeriod::Day,
            limit_usd: 10.0,
            warn_percent: 80,
        };
        let day = date("2026-10-06");
        ledger
            .record_usage(&row(Some(11.0), None, day), &budget)
            .unwrap();
        ledger
            .add_notification(&crate::ledger::NewNotification {
                kind: "budget",
                urgency: "needs_you",
                agent_id: "friday",
                title: "Budget used up",
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ledger.settle_budget_notices(), 1);
        assert_eq!(ledger.settle_budget_notices(), 0);
        assert!(ledger
            .record_usage(&row(Some(1.0), None, day), &budget)
            .unwrap()
            .1
            .is_empty());
        assert!(ledger.notifications(10)[0].handled.is_some());
        // Raising the limit mid-period lets the new limit warn when it's reached.
        let raised = Budget { limit_usd: 20.0, ..budget };
        assert_eq!(ledger.record_usage(&row(Some(4.0), None, day), &raised).unwrap().1, vec![80]);
        assert_eq!(ledger.record_usage(&row(Some(4.0), None, day), &raised).unwrap().1, vec![100]);
    }

    #[test]
    fn budget_defaults_off_and_validates_inputs() {
        assert_eq!(crate::config::default_config().budget, Budget::default());
        let mut config = serde_json::to_value(crate::config::default_config()).unwrap();
        config.as_object_mut().unwrap().remove("budget");
        assert_eq!(
            serde_json::from_value::<crate::config::AppConfig>(config)
                .unwrap()
                .budget,
            Budget::default()
        );
        assert!(Budget {
            limit_usd: f64::NAN,
            ..Budget::default()
        }
        .validate()
        .is_err());
        assert!(Budget {
            limit_usd: -1.0,
            ..Budget::default()
        }
        .validate()
        .is_err());
        assert!(Budget {
            warn_percent: 96,
            ..Budget::default()
        }
        .validate()
        .is_err());
    }
}
