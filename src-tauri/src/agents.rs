use serde::{Deserialize, Serialize};

/// Live status of an agent, drives the pixel sprite animation on the floor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Offline,
    Idle,
    Thinking,
    Working,
    Blocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Orchestrator,
    Worker,
}

/// A member of the Stark Tower roster. `home_x`/`home_y` are tile coordinates
/// of the agent's desk on the pixel lab floor. `figure` selects the sprite
/// silhouette ("masc" | "fem" | "synth").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub kind: AgentKind,
    pub engine: String,
    /// Hex accent color for the pixel sprite.
    pub accent: String,
    pub figure: String,
    pub home_x: u32,
    pub home_y: u32,
    pub status: AgentStatus,
}

/// The default Iron Man themed roster. JARVIS orchestrates; everyone else is a
/// generalist worker with a specialty — any of them can be pulled into any
/// project to assist another agent.
pub fn default_roster() -> Vec<Agent> {
    vec![
        Agent {
            id: "jarvis".into(),
            name: "JARVIS".into(),
            role: "Orchestrator".into(),
            kind: AgentKind::Orchestrator,
            engine: "claude-code".into(),
            accent: "#4FD0FF".into(),
            figure: "masc".into(),
            home_x: 8,
            home_y: 4,
            status: AgentStatus::Offline,
        },
        Agent {
            id: "vision".into(),
            name: "VISION".into(),
            role: "Architecture & Strategy".into(),
            kind: AgentKind::Worker,
            engine: "claude-code".into(),
            accent: "#E86B9A".into(),
            figure: "synth".into(),
            home_x: 12,
            home_y: 3,
            status: AgentStatus::Offline,
        },
        Agent {
            id: "friday".into(),
            name: "FRIDAY".into(),
            role: "Full-stack".into(),
            kind: AgentKind::Worker,
            engine: "claude-code".into(),
            accent: "#FFD166".into(),
            figure: "fem".into(),
            home_x: 2,
            home_y: 6,
            status: AgentStatus::Offline,
        },
        Agent {
            id: "edith".into(),
            name: "EDITH".into(),
            role: "Recon & Research".into(),
            kind: AgentKind::Worker,
            engine: "claude-code".into(),
            accent: "#7CF5C4".into(),
            figure: "fem".into(),
            home_x: 5,
            home_y: 6,
            status: AgentStatus::Offline,
        },
        Agent {
            id: "karen".into(),
            name: "KAREN".into(),
            role: "Frontend & UI".into(),
            kind: AgentKind::Worker,
            engine: "claude-code".into(),
            accent: "#C08CFF".into(),
            figure: "fem".into(),
            home_x: 8,
            home_y: 6,
            status: AgentStatus::Offline,
        },
        Agent {
            id: "veronica".into(),
            name: "VERONICA".into(),
            role: "Ops & Infra".into(),
            kind: AgentKind::Worker,
            engine: "claude-code".into(),
            accent: "#FF9E64".into(),
            figure: "masc".into(),
            home_x: 11,
            home_y: 6,
            status: AgentStatus::Offline,
        },
    ]
}
