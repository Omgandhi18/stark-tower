//! How an agent comes across, on five dials the developer can turn: humour, sarcasm,
//! formality, enthusiasm and detail, each from 0 to [`MAX_STEP`]. The built-in agents
//! start where their characters are; the dials become a line of the system prompt.

use serde::{Deserialize, Serialize};

/// The highest step on every dial (steps run 0..=MAX_STEP).
pub const MAX_STEP: u8 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Tone {
    /// Serious (0) to playful.
    pub humour: u8,
    /// Earnest (0) to sarcastic.
    pub sarcasm: u8,
    /// Casual (0) to formal.
    pub formality: u8,
    /// Reserved (0) to upbeat.
    pub enthusiasm: u8,
    /// Brief (0) to thorough.
    pub detail: u8,
}

/// A custom agent's starting point: plain, warm, balanced.
const NEUTRAL: Tone = Tone { humour: 1, sarcasm: 1, formality: 2, enthusiasm: 2, detail: 2 };

/// Where each built-in agent starts, from how the character is with Tony Stark.
pub fn default_for(agent_id: &str) -> Tone {
    let (humour, sarcasm, formality, enthusiasm, detail) = match agent_id {
        "jarvis" => (2, 3, 4, 1, 1),
        "friday" => (3, 2, 1, 3, 1),
        "vision" => (1, 0, 3, 1, 2),
        "edith" => (1, 1, 2, 3, 1),
        "karen" => (2, 1, 1, 4, 3),
        "veronica" => (1, 2, 2, 1, 0),
        "dum-e" => (3, 0, 0, 4, 1),
        _ => return NEUTRAL,
    };
    Tone { humour, sarcasm, formality, enthusiasm, detail }
}

impl Tone {
    /// Every dial within 0..=MAX_STEP.
    pub fn clamped(self) -> Tone {
        let c = |v: u8| v.min(MAX_STEP);
        Tone { humour: c(self.humour), sarcasm: c(self.sarcasm), formality: c(self.formality), enthusiasm: c(self.enthusiasm), detail: c(self.detail) }
    }

    /// The dials as a line of the system prompt.
    pub fn describe(self) -> String {
        let t = self.clamped();
        let pick = |phrases: &[&'static str; 5], step: u8| phrases[usize::from(step)];
        format!(
            "Your tone, as the developer has set it (where it differs from the description above, this wins): \
humour: {}; sarcasm: {}; formality: {}; enthusiasm: {}; detail: {}. Whatever the tone, stay clear, accurate \
and kind, and never let a joke hide a problem.",
            pick(&HUMOUR, t.humour),
            pick(&SARCASM, t.sarcasm),
            pick(&FORMALITY, t.formality),
            pick(&ENTHUSIASM, t.enthusiasm),
            pick(&DETAIL, t.detail),
        )
    }
}

const HUMOUR: [&str; 5] = [
    "none, keep it straight",
    "a rare light touch",
    "light humour now and then",
    "playful, humour comes easily",
    "very playful, jokes are part of how you talk",
];
const SARCASM: [&str; 5] = [
    "none, say things plainly and kindly",
    "barely any",
    "a little dry wit",
    "dry, sarcastic wit is welcome",
    "freely sarcastic, though never unkind and never at the developer's expense",
];
const FORMALITY: [&str; 5] = ["very casual", "relaxed and informal", "plainly professional", "polished and formal", "very formal and courteous"];
const ENTHUSIASM: [&str; 5] = ["understated and calm", "reserved", "warm and engaged", "upbeat and glad to help", "bursting with enthusiasm"];
const DETAIL: [&str; 5] = [
    "as brief as possible",
    "brief, lead with the answer",
    "balanced",
    "thorough, explain your reasoning",
    "very thorough, walk through everything",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_built_in_agent_has_its_own_tone_and_others_start_neutral() {
        let built_in = ["jarvis", "friday", "vision", "edith", "karen", "veronica", "dum-e"];
        for id in built_in {
            assert_ne!(default_for(id), NEUTRAL, "{id}");
        }
        assert_eq!(default_for("agent-xyz"), NEUTRAL);
        assert_eq!(default_for("jarvis").formality, MAX_STEP, "JARVIS is the formal one");
    }

    #[test]
    fn the_dials_become_a_prompt_line_and_stay_in_range() {
        let wild = Tone { humour: 9, sarcasm: 0, formality: 4, enthusiasm: 2, detail: 1 };
        assert_eq!(wild.clamped().humour, MAX_STEP);
        let line = wild.describe();
        assert!(line.contains("humour: very playful"));
        assert!(line.contains("sarcasm: none"));
        assert!(line.contains("formality: very formal"));
        assert!(line.contains("detail: brief, lead with the answer"));
    }
}
