//! What a message says once its quotes and points are set aside.
//!
//! The composer sends a reply's quotes as markdown blockquotes and a preview point as the
//! text `pointModel.ts` writes, both in front of the developer's own words. Anything that
//! names or previews a message from its first line (a chat's title, a task's) must read the
//! developer's words, not "> …" or "In the browser at …". This is the small Rust twin of
//! `referenceModel.ts` / `pointModel.ts`; both read the same text.

use regex::Regex;
use std::sync::OnceLock;

/// The longest a description of a quote or point gets.
const DESCRIPTION_LIMIT: usize = 48;

fn browser_point() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^In the browser at \S+, I'm pointing at:$"#).unwrap())
}

fn simulator_point() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^On .+, at -?\d+, -?\d+ \(points\): (.*)$").unwrap())
}

/// The element line of a browser point: `button "Save changes" (selector)` → `button “Save changes”`.
fn browser_title(element_line: &str) -> String {
    let tag: String = element_line.chars().take_while(|c| !matches!(c, '.' | '#' | ' ')).collect();
    let name = element_line.split_once('"').and_then(|(_, rest)| rest.rsplit_once("\" (")).map(|(name, _)| name.trim()).unwrap_or("");
    describe(&tag, name)
}

/// A simulator point's element: `Button “Save” (1, 2, 3 × 4)` → `Button “Save”`.
fn simulator_title(element: &str) -> String {
    match (element.find('“'), element.rfind('”')) {
        (Some(open), Some(close)) if open < close => describe(element[..open].trim(), &element[open + '“'.len_utf8()..close]),
        _ => "a point on the screen".to_string(),
    }
}

fn describe(role: &str, name: &str) -> String {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        role.to_string()
    } else {
        format!("{role} “{}”", clip(&name))
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() <= DESCRIPTION_LIMIT {
        text.to_string()
    } else {
        let cut: String = text.chars().take(DESCRIPTION_LIMIT - 1).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Skip the collapsed blocks that follow a browser point (its details, then its HTML) from `at`.
fn skip_details(lines: &[&str], mut at: usize) -> usize {
    loop {
        let mut next = at;
        while lines.get(next).is_some_and(|l| l.trim().is_empty()) {
            next += 1;
        }
        let Some(open) = lines.get(next) else { return at };
        if !(open.starts_with("<details><summary>Element ") && open.ends_with("</summary>")) {
            return at;
        }
        // `<details>`, a blank line, a fence, the code, the fence, `</details>`.
        let Some(fence_at) = lines[next + 1..].iter().position(|l| l.starts_with("```")) else { return at };
        let fence_at = next + 1 + fence_at;
        let fence: String = lines[fence_at].chars().take_while(|c| *c == '`').collect();
        let Some(close) = lines[fence_at + 1..].iter().position(|l| l.trim_end() == fence) else { return at };
        let close = fence_at + 1 + close;
        let end = lines[close + 1..].iter().position(|l| l.trim() == "</details>").map(|i| close + 1 + i + 1);
        at = end.unwrap_or(close + 1);
    }
}

/// A message split into the developer's own words and a description of each quote and point,
/// in the order they appear.
pub struct Reading {
    pub words: String,
    pub described: Vec<String>,
}

pub fn read(text: &str) -> Reading {
    let lines: Vec<&str> = text.lines().collect();
    let mut words: Vec<&str> = Vec::new();
    let mut described: Vec<String> = Vec::new();
    let mut quoting = false;
    let mut at = 0;
    while at < lines.len() {
        let line = lines[at];
        if let Some(quoted) = line.strip_prefix('>') {
            let quoted = quoted.trim();
            if !quoting && !quoted.is_empty() {
                described.push(clip(quoted));
                quoting = true;
            }
            at += 1;
            continue;
        }
        quoting = false;
        if browser_point().is_match(line.trim_end()) && lines.len() > at + 2 {
            described.push(format!("About {}", browser_title(lines[at + 1])));
            at = skip_details(&lines, at + 3);
        } else if let Some(found) = simulator_point().captures(line) {
            described.push(format!("About {}", simulator_title(&found[1])));
            at += 1;
        } else {
            words.push(line);
            at += 1;
        }
    }
    let words = words.join("\n");
    let words = Regex::new(r"\n{3,}").unwrap().replace_all(words.trim(), "\n\n").into_owned();
    Reading { words, described }
}

/// What to name or preview a message by: the developer's own words, or, when there are none,
/// a description of its first quote or point.
pub fn readable(text: &str) -> String {
    let reading = read(text);
    if reading.words.is_empty() {
        reading.described.into_iter().next().unwrap_or_default()
    } else {
        reading.words
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BROWSER_POINT: &str = "In the browser at https://shop.test/settings, I'm pointing at:\nbutton.btn.primary \"Save changes\" (#save)\n120 × 32 at 10, 20 · color #fff\n\n<details><summary>Element details</summary>\n\n```json\n{\n  \"tag\": \"button\"\n}\n```\n</details>\n\n<details><summary>Element HTML</summary>\n\n```html\n<button>Save changes</button>\n```\n</details>\n";
    const SIMULATOR_POINT: &str = "On iPhone 17, at 120, 340 (points): Button “Continue” · value on (10, 20, 100 × 44)\n";

    #[test]
    fn the_developers_words_come_after_quotes_and_points() {
        assert_eq!(readable("> I grouped the options.\n> And added search.\n\nWhy these three?"), "Why these three?");
        assert_eq!(readable(&format!("{BROWSER_POINT}\nMake this bigger")), "Make this bigger");
        assert_eq!(readable(&format!("> a quote\n\n{SIMULATOR_POINT}\nFix the spacing\nand the colour")), "Fix the spacing\nand the colour");
        assert_eq!(readable("  just words  "), "just words");
    }

    #[test]
    fn a_message_of_only_a_quote_or_point_is_described() {
        assert_eq!(readable("> I grouped the options into Account and Payments"), "I grouped the options into Account and Payments");
        assert_eq!(readable(&format!("{BROWSER_POINT}\n")), "About button “Save changes”");
        assert_eq!(readable(SIMULATOR_POINT), "About Button “Continue”");
        let long = format!("> {}", "word ".repeat(40));
        assert!(readable(&long).chars().count() <= DESCRIPTION_LIMIT);
        assert_eq!(readable(""), "");
    }

    #[test]
    fn a_slash_command_keeps_its_line_when_references_follow_it() {
        assert_eq!(readable("/review\n\n> an excerpt\n\nthe tone"), "/review\n\nthe tone");
        assert_eq!(readable("/review"), "/review");
    }

    #[test]
    fn code_in_a_points_details_is_not_the_developers_words() {
        let tricky = "In the browser at https://a.test/, I'm pointing at:\ndiv \"x\" (div)\n1 × 2 at 3, 4\n\n<details><summary>Element HTML</summary>\n\n````html\n```\n</details>\nnot words\n````\n</details>\n\nthe real words";
        assert_eq!(readable(tricky), "the real words");
    }
}
