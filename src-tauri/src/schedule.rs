//! When an automation runs: every day, every weekday or one day a week at a
//! local time, or every few hours. Pure date math, generic over the time zone so
//! it can be tested anywhere.

use chrono::{DateTime, Datelike, Days, Duration, LocalResult, NaiveTime, TimeZone, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    /// Every day at a local time ("HH:MM").
    Daily { time: String },
    /// Monday to Friday at a local time.
    Weekdays { time: String },
    /// One day a week (0 = Monday … 6 = Sunday) at a local time.
    Weekly { day: u8, time: String },
    /// Every so many hours after the previous run.
    EveryHours { hours: u8 },
}

const MAX_HOURS: u8 = 24;
/// Far enough ahead to find the next weekday or weekly slot in any week.
const SEARCH_DAYS: u64 = 8;

/// "HH:MM" as a time of day.
pub fn parse_time(text: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(text.trim(), "%H:%M").ok()
}

/// Why a schedule can't be used, if it can't.
pub fn problem(schedule: &Schedule) -> Option<&'static str> {
    match schedule {
        Schedule::Daily { time } | Schedule::Weekdays { time } | Schedule::Weekly { time, .. } if parse_time(time).is_none() => {
            Some("Use a time like 09:30.")
        }
        Schedule::Weekly { day, .. } if *day > 6 => Some("Pick a day of the week."),
        Schedule::EveryHours { hours } if *hours == 0 || *hours > MAX_HOURS => Some("Run every 1 to 24 hours."),
        _ => None,
    }
}

fn weekday_index(day: Weekday) -> u8 {
    day.num_days_from_monday() as u8
}

/// The local instant for `date` at `time`; in a daylight-saving gap, the first
/// valid moment after it.
fn at<Tz: TimeZone>(tz: &Tz, date: chrono::NaiveDate, time: NaiveTime) -> Option<DateTime<Tz>> {
    let naive = date.and_time(time);
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(t) => Some(t),
        LocalResult::Ambiguous(first, _) => Some(first),
        LocalResult::None => tz.from_local_datetime(&(naive + Duration::hours(1))).earliest(),
    }
}

/// The first run strictly after `after`.
pub fn next_after<Tz: TimeZone>(schedule: &Schedule, after: &DateTime<Tz>) -> Option<DateTime<Tz>> {
    if problem(schedule).is_some() {
        return None;
    }
    let tz = after.timezone();
    let today = after.date_naive();
    let matches_day = |date: chrono::NaiveDate| match schedule {
        Schedule::Daily { .. } => true,
        Schedule::Weekdays { .. } => weekday_index(date.weekday()) < 5,
        Schedule::Weekly { day, .. } => weekday_index(date.weekday()) == *day,
        Schedule::EveryHours { .. } => true,
    };
    match schedule {
        Schedule::EveryHours { hours } => Some(after.clone() + Duration::hours(i64::from(*hours))),
        Schedule::Daily { time } | Schedule::Weekdays { time } | Schedule::Weekly { time, .. } => {
            let time = parse_time(time)?;
            (0..=SEARCH_DAYS)
                .filter_map(|offset| today.checked_add_days(Days::new(offset)))
                .filter(|date| matches_day(*date))
                .filter_map(|date| at(&tz, date, time))
                .find(|candidate| candidate > after)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn ist() -> FixedOffset {
        FixedOffset::east_opt(5 * 3600 + 1800).unwrap()
    }

    /// 2026-10-05 is a Monday.
    fn local(day: u32, hour: u32, minute: u32) -> DateTime<FixedOffset> {
        ist().with_ymd_and_hms(2026, 10, day, hour, minute, 0).unwrap()
    }

    #[test]
    fn daily_runs_later_today_or_tomorrow() {
        let daily = Schedule::Daily { time: "09:30".into() };
        assert_eq!(next_after(&daily, &local(5, 8, 0)), Some(local(5, 9, 30)));
        assert_eq!(next_after(&daily, &local(5, 9, 30)), Some(local(6, 9, 30)), "strictly after");
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let weekdays = Schedule::Weekdays { time: "02:00".into() };
        // Friday evening → Monday.
        assert_eq!(next_after(&weekdays, &local(9, 20, 0)), Some(local(12, 2, 0)));
        assert_eq!(next_after(&weekdays, &local(6, 1, 0)), Some(local(6, 2, 0)));
    }

    #[test]
    fn weekly_waits_for_its_day() {
        let thursday = Schedule::Weekly { day: 3, time: "17:00".into() };
        assert_eq!(next_after(&thursday, &local(5, 12, 0)), Some(local(8, 17, 0)));
        assert_eq!(next_after(&thursday, &local(8, 17, 1)), Some(local(15, 17, 0)));
    }

    #[test]
    fn every_few_hours_counts_from_the_last_run() {
        let every = Schedule::EveryHours { hours: 4 };
        assert_eq!(next_after(&every, &local(5, 22, 15)), Some(local(6, 2, 15)));
    }

    #[test]
    fn rejects_schedules_it_cannot_follow() {
        assert!(problem(&Schedule::Daily { time: "25:00".into() }).is_some());
        assert!(problem(&Schedule::Weekly { day: 7, time: "10:00".into() }).is_some());
        assert!(problem(&Schedule::EveryHours { hours: 0 }).is_some());
        assert!(next_after(&Schedule::Daily { time: "nope".into() }, &local(5, 1, 0)).is_none());
        assert!(problem(&Schedule::Weekdays { time: "07:05".into() }).is_none());
    }
}
