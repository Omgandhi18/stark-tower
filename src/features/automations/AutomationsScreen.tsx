import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Plus, Trash2 } from "lucide-react";
import { Button, Dialog, EmptyState } from "../../design";
import { deleteAutomation, runAutomationNow, setAutomationEnabled } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Automation, AutomationInput } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useAutomations } from "../../stores/automations";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import { useSystem } from "../../stores/system";
import { useWorkspace } from "../../stores/workspace";
import AutomationDetail from "./AutomationDetail";
import AutomationEditor from "./AutomationEditor";
import AutomationList from "./AutomationList";
import AutomationRail from "./AutomationRail";
import MaintenanceAutomation from "./MaintenanceAutomation";
import StandupAutomation from "./StandupAutomation";
import { draftFor, visibleAutomations, type AutomationFilter } from "./automationModel";
import { builtIns, isBuiltIn, type BuiltInId } from "./builtIns";
import "./automations.css";

const CLOCK_MS = 30_000;

/** Work agents do on a schedule: the list, one automation in full, and how its runs went. */
export default function AutomationsScreen() {
  const items = useAutomations((s) => s.items);
  const loaded = useAutomations((s) => s.loaded);
  const allRuns = useAutomations((s) => s.runs);
  const apply = useAutomations((s) => s.apply);
  const agents = useAgents((s) => s.agents);
  const projects = useWorkspace((s) => s.projects);
  const activeProject = useWorkspace((s) => s.activeProject);
  const bugs = useWorkspace((s) => s.bugs);
  const standupMinutes = useConfig((s) => s.config?.standup_minutes ?? 0);
  const power = useSystem((s) => s.power);
  const automationId = useNavigation((s) => s.automationId);
  const openAutomation = useNavigation((s) => s.openAutomation);
  const openTask = useNavigation((s) => s.openTask);
  const openSettings = useNavigation((s) => s.openSettings);
  const [builtIn, setBuiltIn] = useState<BuiltInId | null>(null);
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AutomationInput | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(CLOCK_MS);

  const visible = useMemo(() => visibleAutomations(items, filter, query), [items, filter, query]);
  const selectedAutomation = builtIn ? undefined : (items.find((a) => a.id === automationId) ?? visible[0]);
  const selected = builtIn ?? selectedAutomation?.id ?? null;
  const runs = selectedAutomation ? allRuns[selectedAutomation.id] : undefined;
  const builtInRows = builtIns(standupMinutes, bugs);

  // A link from elsewhere (a notification) picks that automation over a built-in.
  const [linked, setLinked] = useState(automationId);
  if (linked !== automationId) {
    setLinked(automationId);
    if (automationId !== null) setBuiltIn(null);
  }

  const selectedId = selectedAutomation?.id;
  useEffect(() => {
    if (selectedId !== undefined)
      useAutomations
        .getState()
        .refreshRuns(selectedId)
        .catch(() => undefined);
  }, [selectedId]);

  const act = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (a: Automation, enabled: boolean) =>
    act(async () => apply(await setAutomationEnabled(a.id, enabled)), enabled ? "The automation couldn't be turned on." : "The automation couldn't be paused.");

  const runNow = (a: Automation) =>
    act(async () => {
      await runAutomationNow(a.id);
      await useAutomations.getState().refreshRuns(a.id);
    }, "The run couldn't start.");

  const select = (id: number | BuiltInId) => {
    setError(null);
    if (isBuiltIn(id)) {
      setBuiltIn(id);
    } else {
      setBuiltIn(null);
      openAutomation(id);
    }
  };

  const defaultOwner = agents.find((a) => a.kind === "orchestrator") ?? agents.find((a) => a.kind !== "maintenance");
  const create = () => setEditing(draftFor(undefined, { agentId: defaultOwner?.id ?? "", cwd: activeProject }));

  return (
    <div className="automations-screen">
      <AutomationList
        items={visible}
        total={items.length}
        loaded={loaded}
        agents={agents}
        builtIns={builtInRows}
        selected={selected}
        onSelect={select}
        onToggle={(a, on) => void toggle(a, on)}
        onCreate={create}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        now={now}
      />

      <main className="automation-main" aria-label="Automation">
        {error && (
          <p className="automation-banner" role="alert">
            {error}
          </p>
        )}
        {builtIn === "standup" ? (
          <StandupAutomation />
        ) : builtIn === "maintenance" ? (
          <MaintenanceAutomation />
        ) : selectedAutomation ? (
          <AutomationDetail
            automation={selectedAutomation}
            agent={agents.find((a) => a.id === selectedAutomation.agent_id)}
            onToggle={(on) => void toggle(selectedAutomation, on)}
            onEdit={() => setEditing(draftFor(selectedAutomation, { agentId: "", cwd: "" }))}
            onRunNow={() => void runNow(selectedAutomation)}
            onDelete={() => setDeleting(selectedAutomation)}
            running={busy || selectedAutomation.last_status === "running"}
          />
        ) : (
          loaded && (
            <EmptyState
              icon={CalendarPlus}
              title={items.length ? "Pick an automation" : "Put recurring work on a schedule"}
              body={
                items.length
                  ? "Its schedule, limits and recent runs appear here."
                  : "An automation asks an agent to do the same job on a schedule: review last night's changes, brief you each morning, audit dependencies every week. Each run is a task you can open and review."
              }
              action={
                !items.length && (
                  <Button variant="primary" icon={Plus} onClick={create}>
                    New automation
                  </Button>
                )
              }
            />
          )
        )}
      </main>

      {selectedAutomation && !builtIn && (
        <AutomationRail
          automation={selectedAutomation}
          runs={runs}
          power={power}
          now={now}
          onOpenTask={openTask}
          onOpenPower={() => openSettings("power")}
          onRunNow={() => void runNow(selectedAutomation)}
          onToggle={(on) => void toggle(selectedAutomation, on)}
          busy={busy}
        />
      )}

      {editing && (
        <AutomationEditor
          key={editing.id ?? "new"}
          draft={editing}
          agents={agents}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            apply(saved);
            setEditing(null);
            setBuiltIn(null);
            openAutomation(saved.id);
          }}
        />
      )}

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        icon={Trash2}
        title={deleting ? `Delete ${deleting.name}?` : "Delete automation?"}
        description="Its schedule and run history go with it. Tasks it already started stay on Work."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              disabled={busy}
              onClick={() => {
                const target = deleting;
                if (!target) return;
                setDeleting(null);
                void act(async () => {
                  await deleteAutomation(target.id);
                  openAutomation(null);
                  await useAutomations.getState().refresh();
                }, "The automation couldn't be deleted.");
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
