import { useState } from "react";
import { Check, ShieldCheck, Trash2 } from "lucide-react";
import { Button, InlineCode, SelectField, Tag, TextField, Toggle, ICON_SIZE, ICON_STROKE } from "../../design";
import { providerCapabilities, removeEngine, updateEngine } from "../../lib/api";
import { apiKeyNameFor, signInCommandFor } from "../../lib/engines";
import { errorMessage } from "../../lib/errors";
import type { AppConfig, EngineConfig, EngineHealth } from "../../lib/types";
import { useOnce } from "../../lib/useOnce";
import { useConfig } from "../../stores/config";
import { useSystem } from "../../stores/system";
import {
  AUTH_METHODS,
  apiKeyOf,
  canRemoveProvider,
  installSummary,
  isProviderDirty,
  signInSummary,
  validateProvider,
  withApiKey,
  withAuthMethod,
} from "./providerDraft";

const SAVED_NOTICE_MS = 1800;

interface ProviderEditorProps {
  saved: EngineConfig;
  config: AppConfig;
  health: EngineHealth | undefined;
}

/** How Starkline starts one provider's CLI and signs it in. */
export default function ProviderEditor({ saved, config, health }: ProviderEditorProps) {
  const [draft, setDraft] = useState<EngineConfig>(saved);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = useConfig((s) => s.apply);
  const recheckHealth = useSystem((s) => s.recheckHealth);
  const problems = validateProvider(draft);
  const dirty = isProviderDirty(draft, saved);
  const users = config.agents.filter((a) => a.engine === saved.id);
  const usesCliSignIn = (draft.auth?.method ?? "cli-login") === "cli-login";
  const signedOut = health?.installed === true && health.signIn?.signedIn === false;
  const signInCommand = signInCommandFor(saved.kind);
  const caps = useOnce("provider-capabilities", providerCapabilities)?.find((c) => c.kind === draft.kind);
  const set = <K extends keyof EngineConfig>(key: K, value: EngineConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      apply(await updateEngine({ ...draft, label: draft.label.trim(), command: draft.command.trim() }));
      recheckHealth().catch((e) => console.error("[settings] couldn't re-check providers", e));
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    } catch (e) {
      setError(errorMessage(e, "The provider couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      apply(await removeEngine(saved.id));
    } catch (e) {
      setError(errorMessage(e, "The provider couldn't be removed."));
    }
  };

  return (
    <form
      className="provider-editor"
      aria-label={`${saved.label} settings`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <header className="provider-editor-head">
        <div>
          <h2 className="provider-editor-title">{saved.label}</h2>
          <p className="provider-editor-meta">
            {installSummary(health)}
            {health?.path && <span className="mono"> at {health.path}</span>}
            {signInSummary(health) && <> · {signInSummary(health)}</>}
          </p>
          {usesCliSignIn && signedOut && signInCommand && (
            <p className="provider-editor-signin" role="status">
              <InlineCode text={`Agents on ${saved.label} can't work until it's signed in. Run \`${signInCommand}\` in Terminal, then come back.`} />
            </p>
          )}
        </div>
        {caps && (caps.approvals.support === "yes" ? <Tag tone="success">Full support</Tag> : <Tag>Chat only</Tag>)}
      </header>
      {caps && (
        <p className="provider-editor-capability">
          <ShieldCheck aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          {caps.approvals.support === "yes"
            ? `${caps.approvals.note} Agents on it can delegate, ask you questions and message teammates.`
            : "Agents on a generic CLI can chat, but Starkline can't see or approve what they do."}
        </p>
      )}

      <div className="form-grid">
        <TextField label="Name" value={draft.label} error={problems.label} onChange={(e) => set("label", e.target.value)} />
        <TextField
          label="Command"
          value={draft.command}
          error={problems.command}
          spellCheck={false}
          className="mono-field"
          onChange={(e) => set("command", e.target.value)}
        />
        <SelectField
          label="Sign-in"
          value={draft.auth?.method ?? "cli-login"}
          options={AUTH_METHODS}
          onChange={(method) => setDraft((d) => withAuthMethod(d, method))}
        />
        <TextField
          label="Default model"
          value={draft.model ?? ""}
          placeholder="The CLI's own default"
          spellCheck={false}
          onChange={(e) => set("model", e.target.value)}
        />
        {draft.auth?.method === "api-key-env" && (
          <TextField
            label={apiKeyNameFor(draft.kind)}
            type="password"
            value={apiKeyOf(draft)}
            autoComplete="off"
            spellCheck={false}
            helper="Kept in this Mac's local Starkline data, and passed only to this provider."
            onChange={(e) => setDraft((d) => withApiKey(d, e.target.value))}
          />
        )}
      </div>

      <Toggle
        label="Enabled"
        checked={draft.enabled ?? true}
        description={users.length ? `Used by ${users.map((a) => a.name).join(", ")}.` : "No agent uses this provider yet."}
        onChange={(value) => set("enabled", value)}
      />

      <footer className="provider-editor-foot">
        <Button type="submit" variant="primary" icon={justSaved ? Check : undefined} disabled={!dirty || saving || Object.keys(problems).length > 0}>
          {justSaved ? "Saved" : "Save provider"}
        </Button>
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
          Discard
        </Button>
        {error && (
          <span className="settings-error" role="alert">
            {error}
          </span>
        )}
        {canRemoveProvider(saved, config) && (
          <Button variant="ghost" icon={Trash2} className="settings-remove" onClick={remove}>
            Remove
          </Button>
        )}
      </footer>
    </form>
  );
}
