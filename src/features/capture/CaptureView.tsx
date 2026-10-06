import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, SelectField, Tabs, TextArea, TextField } from "../../design";
import { hideCapture, onCaptureShown, openCaptureTask, rememberCapture, resizeCapture, saveReminder, startTask } from "../../lib/api";
import { IS_TAURI } from "../../lib/platform";
import { errorMessage } from "../../lib/errors";
import { useNow } from "../../lib/useNow";
import { useThemeSync } from "../../app/theme";
import { selectOrchestrator, useAgents } from "../../stores/agents";
import { useConfig } from "../../stores/config";
import { folderName, useWorkspace } from "../../stores/workspace";
import { findAgent, routeMessage } from "../work/mentions";
import { fromLocalInput, toLocalInput, whenChoices } from "../reminders/reminderModel";
import { captureText, reminderPhrase, toggleMode, type CaptureMode } from "./captureModel";
import { useCaptureSync } from "./useCaptureSync";
import "./capture.css";

type When = { choice: string } | { custom: string };
type Notice = { text: string; taskId?: string };

export default function CaptureView() {
  const loadError = useCaptureSync();
  useThemeSync();
  const config = useConfig((s) => s.config);
  const roster = useAgents((s) => s.agents);
  const orchestrator = useAgents(selectOrchestrator);
  const projects = useWorkspace((s) => s.projects);
  const activeProject = useWorkspace((s) => s.activeProject);
  const loaded = useWorkspace((s) => s.loaded.projects);
  const agents = roster.filter((a) => a.kind !== "maintenance");
  const [mode, setMode] = useState<CaptureMode>("task");
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [reminderAgent, setReminderAgent] = useState<string | null>(null);
  const [when, setWhen] = useState<When>({ choice: "1h" });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const now = useNow(30_000);
  const prefs = config?.quick_capture;
  const availableAgent = (id: string | null | undefined) => (agents.some((a) => a.id === id) ? id! : (orchestrator?.id ?? agents[0]?.id ?? ""));
  const agentId = availableAgent(agent ?? prefs?.last_agent);
  const reminderId = availableAgent(reminderAgent ?? prefs?.last_reminder_agent);
  const savedProject = project ?? prefs?.last_project;
  const projectPath = projects.some((p) => p.path === savedProject) ? savedProject! : activeProject;
  const choices = whenChoices(now);
  const phrase = reminderPhrase(text, now);
  const choice = phrase.choice ?? ("choice" in when ? when.choice : null);

  const focusInput = () => form.current?.querySelector("textarea")?.focus();
  const hide = () => IS_TAURI && void hideCapture().catch((e) => setError(errorMessage(e, "Quick capture couldn't be hidden. Try again.")));

  useEffect(() => {
    if (!IS_TAURI) return;
    const subscription = onCaptureShown(focusInput);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void hideCapture().catch(() => {});
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      void subscription.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      hideCapture()
        .then(() => {
          setText("");
          setNotice(null);
          setMode("task");
          setWhen({ choice: "1h" });
        })
        .catch((e) => setError(errorMessage(e, "Quick capture couldn't be hidden. Try again.")));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!IS_TAURI) return;
    const node = form.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      void resizeCapture(node.scrollHeight).catch(() => {});
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (sending || notice || !config || !loaded) return;
    setError(null);
    setSending(true);
    try {
      if (mode === "task") {
        const routing = routeMessage(text, agents, agentId);
        if (!routing.ok) throw new Error(routing.reason);
        const task = await startTask(routing.agentId, routing.message, projectPath || undefined);
        setAgent(routing.agentId);
        setProject(projectPath);
        setNotice({
          text: `Sent to ${agents.find((a) => a.id === routing.agentId)?.name ?? "your agent"}${projectPath ? ` in ${folderName(projectPath)}` : ""}`,
          taskId: task.id,
        });
        void rememberCapture(routing.agentId, projectPath || null, false)
          .then(useConfig.getState().apply)
          .catch(() => {});
      } else {
        const due = choice ? whenChoices(Date.now()).find((c) => c.id === choice)?.at : "custom" in when ? fromLocalInput(when.custom) : null;
        if (!due || due <= Date.now()) throw new Error("Pick a time that hasn't passed.");
        if (!reminderId) throw new Error("Add an agent in Starkline to remind you.");
        const saved = await saveReminder({ id: null, text: phrase.text, agent_id: reminderId, task_id: null, due, repeat: null });
        setReminderAgent(reminderId);
        setNotice({
          text: `${agents.find((a) => a.id === reminderId)?.name ?? "Your agent"} will remind you at ${new Date(saved.due).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        });
        void rememberCapture(reminderId, null, true)
          .then(useConfig.getState().apply)
          .catch(() => {});
      }
    } catch (e) {
      setError(errorMessage(e, mode === "task" ? "The task couldn't be sent. Try again." : "The reminder couldn't be saved. Try again."));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="quick-capture" aria-label="Quick capture">
      <form ref={form} onSubmit={(e) => void submit(e)}>
        <div className="capture-header">
          <Tabs
            className="capture-modes"
            label="Capture mode"
            idPrefix="capture"
            tabs={[
              { id: "task", label: "Task" },
              { id: "reminder", label: "Reminder" },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Button variant="ghost" onClick={hide}>
            Close
          </Button>
        </div>
        <TextArea
          label="Ask an agent, or start with “remind me…”"
          hideLabel
          autoFocus
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          value={text}
          disabled={sending || Boolean(notice)}
          placeholder="Ask an agent, or start with “remind me…”"
          onChange={(e) => {
            const next = captureText(e.target.value, mode);
            setText(next.text);
            setMode(next.mode);
            const mention = /^@(\S+)/.exec(next.text.trim());
            const mentionedAgent = mention && findAgent(agents, mention[1]);
            if (mentionedAgent) setAgent(mentionedAgent.id);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              setMode(toggleMode(mode));
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div role="tabpanel" id={`capture-panel-${mode}`} aria-labelledby={`capture-tab-${mode}`}>
          {mode === "reminder" && (
            <div className="capture-times" role="radiogroup" aria-label="When">
              {choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={choice === c.id}
                  onClick={() => {
                    setText(phrase.text);
                    setWhen({ choice: c.id });
                  }}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={!choice}
                onClick={() => {
                  setText(phrase.text);
                  setWhen({ custom: toLocalInput(now + 3_600_000) });
                }}
              >
                Pick a time…
              </button>
              {"custom" in when && !choice && (
                <TextField label="Date and time" type="datetime-local" value={when.custom} onChange={(e) => setWhen({ custom: e.target.value })} />
              )}
            </div>
          )}
          <div className="capture-controls">
            <SelectField
              label={mode === "task" ? "Agent" : "Who reminds you"}
              hideLabel
              value={mode === "task" ? agentId : reminderId}
              options={agents.length ? agents.map((a) => ({ value: a.id, label: a.name })) : [{ value: "", label: "Add an agent in Starkline" }]}
              onChange={mode === "task" ? setAgent : setReminderAgent}
            />
            {mode === "task" && (
              <SelectField
                label="Project"
                hideLabel
                value={projectPath}
                options={
                  projects.length
                    ? projects.map((p) => ({ value: p.path, label: p.name }))
                    : [{ value: activeProject, label: activeProject ? folderName(activeProject) : "Add a project in Starkline" }]
                }
                onChange={setProject}
              />
            )}
            <Button type="submit" variant="primary" disabled={sending || Boolean(notice) || !text.trim() || !config || !loaded || !agents.length}>
              {mode === "task" ? "Send task" : "Set reminder"}
            </Button>
          </div>
        </div>
        {(error || loadError) && (
          <p className="field-error" role="alert">
            {error || loadError}
          </p>
        )}
        {notice && (
          <div className="capture-confirmation" role="status">
            {notice.text}
            {notice.taskId && (
              <Button
                variant="ghost"
                onClick={() => void openCaptureTask(notice.taskId!).catch((e) => setError(errorMessage(e, "The task couldn't be opened. Open it from Work.")))}
              >
                Open
              </Button>
            )}
          </div>
        )}
      </form>
    </main>
  );
}
