import { useState } from "react";
import { CalendarCog, CalendarPlus } from "lucide-react";
import { Button, Dialog, SelectField, TextArea, TextField, Toggle } from "../../design";
import { pickFolder, saveAutomation } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Agent, Automation, AutomationInput, ProjectInfo, Schedule } from "../../lib/types";
import { folderName } from "../../stores/workspace";
import {
  formatMinutes,
  HOUR_CHOICES,
  MISSED_OPTIONS,
  NOTIFY_OPTIONS,
  runtimeChoices,
  SCHEDULE_KINDS,
  WEEKDAYS,
  withKind,
  type ScheduleKind,
} from "./automationModel";

/** The project picker's last choice opens the macOS folder picker. */
const CHOOSE_FOLDER = "__choose_folder__";

interface AutomationEditorProps {
  /** Where the form starts: an automation as it is, or a new one. */
  draft: AutomationInput;
  agents: readonly Agent[];
  projects: readonly ProjectInfo[];
  onClose: () => void;
  onSaved: (automation: Automation) => void;
}

function ScheduleFields({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  return (
    <div className="automation-editor-row">
      <SelectField label="Repeats" value={schedule.kind} options={SCHEDULE_KINDS} onChange={(kind) => onChange(withKind(schedule, kind as ScheduleKind))} />
      {schedule.kind === "weekly" && (
        <SelectField
          label="On"
          value={String(schedule.day)}
          options={WEEKDAYS.map((day, i) => ({ value: String(i), label: day }))}
          onChange={(day) => onChange({ ...schedule, day: Number(day) })}
        />
      )}
      {schedule.kind === "everyHours" ? (
        <SelectField
          label="Every"
          value={String(schedule.hours)}
          options={HOUR_CHOICES.map((h) => ({ value: String(h), label: h === 1 ? "1 hour" : `${h} hours` }))}
          onChange={(hours) => onChange({ ...schedule, hours: Number(hours) })}
        />
      ) : (
        <TextField label="At" type="time" required value={schedule.time} onChange={(e) => onChange({ ...schedule, time: e.target.value })} />
      )}
    </div>
  );
}

/** Create or change an automation (open while mounted). The backend checks it before it's saved and says what's missing. */
export default function AutomationEditor({ draft, agents, projects, onClose, onSaved }: AutomationEditorProps) {
  const [form, setForm] = useState<AutomationInput>(draft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const creating = draft.id === null;

  const set = <K extends keyof AutomationInput>(key: K, value: AutomationInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const folders = projects.some((p) => p.path === form.cwd) || !form.cwd ? projects : [...projects, { path: form.cwd, name: folderName(form.cwd) }];
  const projectOptions = [
    ...folders.map((p) => ({ value: p.path, label: p.name || folderName(p.path) })),
    { value: CHOOSE_FOLDER, label: "Choose another folder…" },
  ];
  const owners = agents.filter((a) => a.kind !== "maintenance" || a.id === form.agent_id);

  const chooseProject = async (value: string) => {
    if (value !== CHOOSE_FOLDER) return set("cwd", value);
    try {
      const chosen = await pickFolder("Choose the project folder this automation works in");
      if (chosen) set("cwd", chosen);
    } catch (e) {
      setError(errorMessage(e, "The folder picker couldn't open."));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveAutomation({ ...form, name: form.name.trim(), instruction: form.instruction.trim() }));
    } catch (e) {
      setError(errorMessage(e, "The automation couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={creating ? CalendarPlus : CalendarCog}
      title={creating ? "New automation" : `Edit ${draft.name}`}
      description="An agent does this on a schedule, in its own task, within the limits you set here."
      dismissible={!saving}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : creating ? "Create automation" : "Save changes"}
          </Button>
        </>
      }
    >
      <form
        className="automation-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label="Name" value={form.name} placeholder="Nightly code review" onChange={(e) => set("name", e.target.value)} autoFocus />
        <div className="automation-editor-row">
          <SelectField
            label="Owner"
            value={form.agent_id}
            options={owners.map((a) => ({ value: a.id, label: a.role ? `${a.name}, ${a.role}` : a.name }))}
            onChange={(id) => set("agent_id", id)}
          />
          <SelectField label="Project" value={form.cwd} options={projectOptions} onChange={(value) => void chooseProject(value)} />
        </div>
        <TextArea
          label="Each run"
          value={form.instruction}
          rows={4}
          placeholder="Pull the latest changes, run the checks, and summarise anything that needs attention."
          helper="What the owner is asked to do every time. It works in its own task you can open from Work."
          onChange={(e) => set("instruction", e.target.value)}
        />
        <ScheduleFields schedule={form.schedule} onChange={(schedule) => set("schedule", schedule)} />
        <div className="automation-editor-row">
          <SelectField label="If a run is missed" value={form.missed} options={MISSED_OPTIONS} onChange={(missed) => set("missed", missed)} />
          <SelectField label="Tell me" value={form.notify} options={NOTIFY_OPTIONS} onChange={(notify) => set("notify", notify)} />
        </div>
        <div className="automation-editor-row">
          <SelectField
            label="Stop a run after"
            value={String(form.max_minutes)}
            options={runtimeChoices(form.max_minutes).map((m) => ({ value: String(m), label: formatMinutes(m) }))}
            onChange={(minutes) => set("max_minutes", Number(minutes))}
          />
          <Toggle
            label="Run on its schedule"
            description={form.enabled ? "On. Turn it off to keep it paused." : "Paused until you turn it on."}
            checked={form.enabled}
            onChange={(enabled) => set("enabled", enabled)}
            className="automation-editor-toggle"
          />
        </div>
        {error && (
          <p className="automation-editor-error" role="alert">
            {error}
          </p>
        )}
        {/* Enter in a field saves, as the primary action does. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
