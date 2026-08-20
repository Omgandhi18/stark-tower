import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Sunrise,
  Sunset,
} from "lucide-react";
import "./App.css";
import type {
  Agent,
  AppConfig,
  AssistLink,
  LightPhase,
  ProjectInfo,
  ReviewRequest,
} from "./lib/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getConfig,
  listAgents,
  listProjects,
  onAgentStatus,
  onAssistLink,
  onConfigChanged,
  onReviewRequest,
  reviewRespond,
  setLighting,
} from "./lib/api";
import { LIGHT_LABEL, LIGHT_MODES, resolvePhase } from "./lib/lighting";
import StarkFloor from "./components/StarkFloor";
import Roster from "./components/Roster";
import Chat from "./components/Chat";
import ProjectsBar from "./components/ProjectsBar";
import ReviewPanel from "./components/ReviewPanel";
import TasksBoard from "./components/TasksBoard";
import CostHud from "./components/CostHud";
import UpdateBadge from "./components/UpdateBadge";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";

function lightIcon(mode: string, size = 16) {
  const p = { size, strokeWidth: 2 };
  switch (mode) {
    case "morning":
      return <Sunrise {...p} />;
    case "day":
      return <Sun {...p} />;
    case "evening":
      return <Sunset {...p} />;
    case "night":
      return <Moon {...p} />;
    case "system":
      return <Monitor {...p} />;
    default:
      return <Clock {...p} />;
  }
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openAgents, setOpenAgents] = useState<string[]>([]);
  const [assistLinks, setAssistLinks] = useState<AssistLink[]>([]);
  const linkCounter = useRef(0);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<string>("");
  const [rosterOpen, setRosterOpen] = useState(false);
  const [reviews, setReviews] = useState<ReviewRequest[]>([]);
  const [questions, setQuestions] = useState<Record<string, ReviewRequest>>({});
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [phase, setPhase] = useState<LightPhase>("day");
  const [closePrompt, setClosePrompt] = useState(false);
  const [booting, setBooting] = useState(true);
  const agentsRef = useRef<Agent[]>([]);
  agentsRef.current = agents;

  // Boot-in: a brief "coming online" caption while the crew walks to their desks.
  useEffect(() => {
    const t = window.setTimeout(() => setBooting(false), 3200);
    return () => window.clearTimeout(t);
  }, []);

  // Apply a new config: keep it, and refresh the derived roster/floor.
  const applyConfig = useCallback((c: AppConfig) => {
    setConfig(c);
    listAgents().then(setAgents).catch(() => {});
  }, []);

  // Resolve the lighting mode into a phase, re-checking periodically so "auto"
  // (clock) and "system" follow the time of day / OS theme.
  const lightMode = config?.lighting ?? "auto";
  useEffect(() => {
    const update = () => setPhase(resolvePhase(lightMode));
    update();
    const iv = window.setInterval(update, 60000);
    return () => window.clearInterval(iv);
  }, [lightMode]);

  const cycleLight = useCallback(() => {
    const modes = LIGHT_MODES as readonly string[];
    const next = modes[(modes.indexOf(lightMode) + 1) % modes.length];
    setLighting(next).then(applyConfig).catch(() => {});
  }, [lightMode, applyConfig]);

  const openAgent = useCallback((id: string) => {
    setSelectedId(id);
    setOpenAgents((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const decideReview = useCallback((id: string, decision: string) => {
    reviewRespond(id, decision).catch(() => {});
    setReviews((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const answerQuestion = useCallback((id: string, text: string) => {
    reviewRespond(id, text).catch(() => {});
    setQuestions((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (next[k].id === id) delete next[k];
      return next;
    });
  }, []);

  // Default to JARVIS once the roster loads.
  useEffect(() => {
    if (agents.length && openAgents.length === 0) openAgent("jarvis");
  }, [agents, openAgents.length, openAgent]);

  useEffect(() => {
    listAgents().then(setAgents).catch(() => {});
    getConfig().then(setConfig).catch(() => {});
    listProjects()
      .then((s) => {
        setProjects(s.projects);
        setActiveProject(s.active);
      })
      .catch(() => {});
  }, []);

  // Live config updates (e.g. from another window) refresh the roster.
  useEffect(() => {
    const unsub = onConfigChanged(applyConfig);
    return () => {
      unsub.then((f) => f());
    };
  }, [applyConfig]);

  // Guard the window close: if any agent session is live, confirm first.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((e) => {
      const running = agentsRef.current.filter((a) => a.status !== "offline").length;
      if (running > 0) {
        e.preventDefault();
        setClosePrompt(true);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Live status → sprites + roster.
  useEffect(() => {
    const unsub = onAgentStatus((e) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)),
      );
    });
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  // Assist beams on the floor.
  useEffect(() => {
    const unsub = onAssistLink(({ from, to }) => {
      const id = ++linkCounter.current;
      setAssistLinks((prev) => [...prev, { from, to, id }]);
      window.setTimeout(
        () => setAssistLinks((prev) => prev.filter((l) => l.id !== id)),
        7000,
      );
    });
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  // Human-in-the-loop review requests from agents (the lavish alternative).
  useEffect(() => {
    const unsub = onReviewRequest((r) => {
      if (r.kind === "questions") {
        // normal Q&A goes inline in the agent's chat, not the overlay
        setQuestions((prev) => ({ ...prev, [r.agentId]: r }));
        openAgent(r.agentId);
      } else {
        setReviews((prev) =>
          prev.some((x) => x.id === r.id) ? prev : [...prev, r],
        );
      }
    });
    return () => {
      unsub.then((f) => f());
    };
  }, [openAgent]);

  // Periodic reconcile.
  useEffect(() => {
    const iv = window.setInterval(() => {
      listAgents().then(setAgents).catch(() => {});
    }, 4000);
    return () => window.clearInterval(iv);
  }, []);

  const online = agents.filter((a) => a.status !== "offline").length;
  const active = agents.filter(
    (a) => a.status === "working" || a.status === "thinking",
  ).length;
  const load = agents.length ? Math.round((active / agents.length) * 100) : 0;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-core" />
          <span className="brand-name">STARK&nbsp;TOWER</span>
        </div>
        <ProjectsBar
          projects={projects}
          active={activeProject}
          onChange={(s) => {
            setProjects(s.projects);
            setActiveProject(s.active);
          }}
        />
        <div className="top-sp" />
        <UpdateBadge />
        <div className="telem">
          <div className="telem-u">
            <span className="telem-v">
              {online}
              <span className="dim">/{agents.length}</span>
            </span>
            <span className="telem-k">online</span>
          </div>
          <div className="telem-u">
            <span className="telem-v">{active}</span>
            <span className="telem-k">active</span>
          </div>
          <div className="telem-u">
            <span className="telem-v accent">{load}%</span>
            <span className="telem-k">reactor</span>
          </div>
        </div>
        <button
          className="gear"
          onClick={cycleLight}
          title={`Lighting: ${LIGHT_LABEL[lightMode] ?? "Auto"} · ${phase}`}
        >
          {lightIcon(lightMode)}
        </button>
        <button
          className="gear"
          onClick={() => setSettingsOpen(true)}
          title="Configuration"
        >
          <SettingsIcon size={16} strokeWidth={2} />
        </button>
      </header>

      <div className="main">
        <section className="floor-pane">
          <StarkFloor
            agents={agents}
            selectedId={selectedId}
            assistLinks={assistLinks}
            lighting={phase}
            onSelect={openAgent}
          />
          <div className={`ov ov-roster glass ${rosterOpen ? "open" : ""}`}>
            <button
              className="ov-roster-head"
              onClick={() => setRosterOpen((o) => !o)}
            >
              <span className="label">Roster</span>
              <span className="ov-roster-meta">
                <span className="label">
                  {online}/{agents.length}
                </span>
                <span className="chev">
                  {rosterOpen ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </span>
              </span>
            </button>
            {rosterOpen && (
              <Roster
                agents={agents}
                selectedId={selectedId}
                onSelect={openAgent}
              />
            )}
          </div>
          <TasksBoard />

          <CostHud />
          <div className="floortag">
            <span className="d" />
            <span className="label">
              stark lab · {agents.length} agents · live
            </span>
          </div>
          {booting && (
            <div className="boot-veil">
              <div className="boot-caption glass">
                <span className="boot-core" />
                <span className="boot-text">Bringing the lab online…</span>
              </div>
            </div>
          )}
          {reviews.length > 0 && (
            <ReviewPanel
              review={reviews[0]}
              agent={agents.find((a) => a.id === reviews[0].agentId)}
              pending={reviews.length}
              onDecide={decideReview}
            />
          )}
        </section>

        <aside className="chat-rail">
          {openAgents.map((id) => {
            const a = agents.find((x) => x.id === id);
            if (!a) return null;
            return (
              <Chat
                key={id}
                agent={a}
                active={id === selectedId}
                projects={projects}
                activeDir={activeProject}
                question={questions[a.id]}
                onAnswer={answerQuestion}
              />
            );
          })}
        </aside>
      </div>

      {settingsOpen && config && (
        <Settings
          config={config}
          onConfig={applyConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {config && !config.onboarded && (
        <Onboarding config={config} onDone={applyConfig} />
      )}

      {closePrompt && (
        <div className="settings-backdrop" onMouseDown={() => setClosePrompt(false)}>
          <div className="close-prompt glass" onMouseDown={(e) => e.stopPropagation()}>
            <div className="close-prompt-head">
              <span className="close-prompt-icon" />
              <div>
                <div className="close-prompt-title">
                  {online} agent{online === 1 ? "" : "s"} still running
                </div>
                <div className="close-prompt-sub">
                  Closing the tower ends their sessions. Any work they haven't
                  saved to disk is lost when the process exits.
                </div>
              </div>
            </div>
            <div className="close-prompt-actions">
              <button className="ob-ghost" onClick={() => setClosePrompt(false)}>
                Keep running
              </button>
              <span style={{ flex: 1 }} />
              <button
                className="btn-danger"
                onClick={async () => {
                  const w = getCurrentWindow();
                  try {
                    await w.destroy();
                  } catch {
                    await w.close().catch(() => {});
                  }
                }}
              >
                Shut down &amp; quit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
