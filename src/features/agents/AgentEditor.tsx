import { useState } from "react";
import { Check, MessageSquareText, Trash2, TriangleAlert } from "lucide-react";
import { portraitKey, Button, Dialog, Portrait, StatusPill, Tabs, Tag, TextArea, TextField, Toggle, cx, ICON_SIZE, ICON_STROKE, type TabItem } from "../../design";
import { removeAgent, updateAgent } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent, AgentConfig, AppConfig } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import { hasProblems, isDirty, validateAgent } from "./agentDraft";
import ContextPanel from "../context/ContextPanel";
import CharacterStudio from "../studio/CharacterStudio";
import AgentMemory from "./AgentMemory";
import AgentPermissions from "./AgentPermissions";
import AgentProviderFields from "./AgentProviderFields";
import { ACCENTS, FIGURES } from "./appearance";
import VoicePicker from "../voices/VoicePicker";
import { defaultVoice } from "../voices/voiceModel";
import ToneDials from "./ToneDials";

type EditorTab = "profile" | "provider" | "permissions" | "memory" | "context";

const TABS: readonly TabItem<EditorTab>[] = [
  { id: "profile", label: "Profile" },
  { id: "provider", label: "Provider" },
  { id: "permissions", label: "Permissions" },
  { id: "memory", label: "Memory" },
  { id: "context", label: "Context" },
];

const SAVED_NOTICE_MS = 1800;

interface AgentEditorProps {
  saved: AgentConfig;
  config: AppConfig;
  /** The live roster entry; absent while the agent is turned off. */
  live: Agent | undefined;
  /** After removal, select someone else. */
  onRemoved: () => void;
}

/** Edit one agent: who they are, how they look, what runs them, how they think. */
export default function AgentEditor({ saved, config, live, onRemoved }: AgentEditorProps) {
  const [edits, setEdits] = useState<Partial<AgentConfig>>({});
  const draft: AgentConfig = { ...saved, ...edits, look: saved.look };
  const [tab, setTab] = useState<EditorTab>("profile");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const openConversation = useNavigation((s) => s.openConversation);
  const apply = useConfig((s) => s.apply);

  const problems = validateAgent(draft, config);
  const dirty = isDirty(draft, saved);
  const orchestrator = draft.kind === "orchestrator";
  const status = live ? AGENT_STATUS[live.status] : null;
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => setEdits((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (hasProblems(problems)) return;
    setSaving(true);
    setError(null);
    try {
      apply(
        await updateAgent({
          ...draft,
          name: draft.name.trim(),
          role: draft.role.trim(),
        }),
      );
      setEdits((current) => Object.fromEntries(
        Object.entries(current).filter(([key, value]) => value !== draft[key as keyof AgentConfig]),
      ));
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    } catch (e) {
      setError(errorMessage(e, "The changes couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    try {
      apply(await removeAgent(saved.id));
      onRemoved();
    } catch (e) {
      setError(errorMessage(e, `${saved.name} couldn't be removed.`));
    }
  };

  return (
    <section className="agent-editor" aria-label={`${saved.name} settings`}>
      <header className="agent-editor-head">
        <Portrait name={draft.name || saved.name} figure={portraitKey(draft)} accent={draft.accent} size={64} status={live?.status} />
        <div className="agent-editor-who">
          <h1 className="agent-editor-name">{draft.name.trim() || "Unnamed agent"}</h1>
          <p className="agent-editor-role">{draft.role.trim() || "No role yet"}</p>
          <div className="agent-editor-tags">
            {orchestrator && <Tag tone="accent">Orchestrator</Tag>}
            {draft.kind === "maintenance" && <Tag tone="accent">Maintenance</Tag>}
            {status ? <StatusPill label={status.label} tone={status.tone} icon={status.icon} live={status.busy} /> : <Tag>Turned off</Tag>}
          </div>
        </div>
        <Button icon={MessageSquareText} disabled={!live} onClick={() => openConversation(saved.id)}>
          Open conversation
        </Button>
      </header>

      <Tabs tabs={TABS} value={tab} onChange={setTab} label={`${saved.name} sections`} idPrefix={`agent-${saved.id}`} className="agent-editor-tabs" />

      {tab === "context" ? (
        <div role="tabpanel" id={`agent-${saved.id}-panel-context`} aria-labelledby={`agent-${saved.id}-tab-context`} className="agent-editor-body">
          <ContextPanel agentId={saved.id} name={saved.name} />
        </div>
      ) : tab === "memory" ? (
        <div role="tabpanel" id={`agent-${saved.id}-panel-memory`} aria-labelledby={`agent-${saved.id}-tab-memory`} className="agent-editor-body">
          <AgentMemory agentId={saved.id} name={saved.name} />
        </div>
      ) : tab === "permissions" ? (
        <div role="tabpanel" id={`agent-${saved.id}-panel-permissions`} aria-labelledby={`agent-${saved.id}-tab-permissions`} className="agent-editor-body">
          <AgentPermissions name={saved.name} />
        </div>
      ) : (
        <form
          role="tabpanel"
          id={`agent-${saved.id}-panel-${tab}`}
          aria-labelledby={`agent-${saved.id}-tab-${tab}`}
          className="agent-editor-body"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {tab === "provider" && <AgentProviderFields draft={draft} saved={saved} config={config} problems={problems} set={set} />}
          {tab === "profile" && (
            <>
              <fieldset className="form-section">
                <legend className="form-section-title">Identity</legend>
                <div className="form-grid">
                  <TextField label="Name" value={draft.name} error={problems.name} onChange={(e) => set("name", e.target.value)} />
                  <TextField label="Role" value={draft.role} placeholder="What they're for" onChange={(e) => set("role", e.target.value)} />
                </div>
              </fieldset>

              <fieldset className="form-section">
                <legend className="form-section-title">Appearance</legend>
                <p className="form-section-note">The look also decides where {draft.name.trim() || "they"} sits in the room.</p>
                <Button onClick={() => setStudioOpen(true)}>Open Character Studio</Button>
                <div className="figure-grid" role="radiogroup" aria-label="Look">
                  {FIGURES.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="radio"
                      aria-checked={draft.figure === f.id}
                      className={cx("figure-option", draft.figure === f.id && "is-selected")}
                      onClick={() => set("figure", f.id)}
                    >
                      <Portrait name={f.label} figure={f.id} size={48} />
                      <span>{f.label}</span>
                    </button>
                  ))}
                </div>
                <div className="accent-row" role="radiogroup" aria-label="Colour">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={draft.accent?.toLowerCase() === c}
                      aria-label={c}
                      title={c}
                      className="accent-swatch"
                      style={{ background: c }}
                      onClick={() => set("accent", c)}
                    >
                      {draft.accent?.toLowerCase() === c && <Check aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />}
                    </button>
                  ))}
                  <TextField
                    label="Colour"
                    hideLabel
                    className="accent-hex"
                    value={draft.accent ?? ""}
                    error={problems.accent}
                    spellCheck={false}
                    onChange={(e) => set("accent", e.target.value)}
                  />
                </div>
              </fieldset>

              <fieldset className="form-section">
                <legend className="form-section-title">Personality</legend>
                <TextArea
                  label="Instructions"
                  hideLabel
                  className="personality-field"
                  value={draft.personality ?? ""}
                  spellCheck={false}
                  placeholder="How this agent works, what it cares about, how it talks."
                  helper="Starkline adds its own rules for delegating, messaging teammates and asking you."
                  onChange={(e) => set("personality", e.target.value)}
                />
              </fieldset>

              <fieldset className="form-section">
                <legend className="form-section-title">Voice</legend>
                <VoicePicker agentId={saved.id} name={draft.name.trim() || saved.name} voice={draft.voice ?? defaultVoice(saved.id)} onChange={(voice) => set("voice", voice)} />
              </fieldset>

              <fieldset className="form-section">
                <legend className="form-section-title">Tone</legend>
                <ToneDials agentId={saved.id} name={draft.name.trim() || saved.name} tone={draft.tone} onChange={(tone) => set("tone", tone)} />
              </fieldset>

              <fieldset className="form-section">
                <legend className="form-section-title">Availability</legend>
                <Toggle
                  label="Available"
                  checked={draft.enabled ?? true}
                  disabled={orchestrator}
                  description={
                    orchestrator
                      ? "The orchestrator is always available."
                      : "When off, they leave the roster and the room and their session ends. Chats are kept."
                  }
                  onChange={(value) => set("enabled", value)}
                />
              </fieldset>
            </>
          )}

          <footer className="agent-editor-foot">
            <Button type="submit" variant="primary" icon={justSaved ? Check : undefined} disabled={!dirty || saving || hasProblems(problems)}>
              {justSaved ? "Saved" : "Save changes"}
            </Button>
            <Button variant="ghost" disabled={!dirty || saving} onClick={() => setEdits({})}>
              Discard
            </Button>
            {error && (
              <span className="agent-editor-error" role="alert">
                {error}
              </span>
            )}
            {!orchestrator && (
              <Button variant="ghost" icon={Trash2} className="agent-remove" onClick={() => setConfirmRemove(true)}>
                Remove agent
              </Button>
            )}
          </footer>
        </form>
      )}

      {studioOpen && <CharacterStudio agent={saved} onClose={() => setStudioOpen(false)} onApplied={() => setEdits((d) => { const next = { ...d }; delete next.figure; delete next.accent; return next; })} />}
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        tone="danger"
        icon={TriangleAlert}
        title={`Remove ${saved.name}?`}
        description="Their live session ends and they leave the roster. Saved chats stay in the history."
        actions={
          <>
            <Button onClick={() => setConfirmRemove(false)}>Keep {saved.name}</Button>
            <Button variant="danger" icon={Trash2} onClick={remove}>
              Remove
            </Button>
          </>
        }
      />
    </section>
  );
}
