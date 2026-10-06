import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, SkeletonRows, Toggle } from "../../design";
import { macNotificationStatus, requestMacNotifications, setMacNotifications, testMacNotification } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { MacNotifications, NotificationPermission } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { MAC_NOTIFICATION_DEFAULTS, permissionLine } from "./notificationsSettingsModel";

const CATEGORIES: ReadonlyArray<{ key: keyof MacNotifications; label: string }> = [
  { key: "reminders", label: "Reminders" },
  { key: "requests", label: "Approvals, questions and reviews" },
  { key: "work", label: "Work that's ready or blocked" },
  { key: "code_review", label: "Your pull and merge requests" },
  { key: "automations", label: "Automations that missed or couldn't start" },
  { key: "budget", label: "Budget warnings" },
  { key: "checks", label: "Checks agents run while they work" },
  { key: "claims", label: "Files agents couldn't claim" },
];

export default function NotificationsSettings() {
  const config = useConfig((s) => s.config);
  const apply = useConfig((s) => s.apply);
  const settings = config ? { ...MAC_NOTIFICATION_DEFAULTS, ...config.mac_notifications } : null;
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  // Read the permission again on returning to Starkline, as the developer may have changed it in System Settings.
  useEffect(() => {
    let active = true;
    const refresh = () => {
      macNotificationStatus()
        .then((p) => {
          if (active) setPermission(p);
        })
        .catch((e) => {
          if (active) setError(errorMessage(e, "Notification settings couldn't be read. Reopen this section to try again."));
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const change = async (key: keyof MacNotifications, value: boolean) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      apply(await setMacNotifications({ ...settings, [key]: value }));
    } catch (e) {
      setError(errorMessage(e, "Notification settings couldn't be saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  };

  const settingsUrl = permission?.settings_url;
  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">Notifications</h1>
        <p className="screen-subtitle">Choose what also reaches you on this Mac. Everything stays in Starkline's Notification Centre.</p>
      </header>
      <section className="settings-card" aria-labelledby="mac-notification-permission">
        <h2 className="settings-card-title" id="mac-notification-permission">
          On this Mac
        </h2>
        <p className="settings-card-text" role="status">
          {permission ? permissionLine(permission.state) : "Checking notification permission…"}
        </p>
        <div className="settings-card-actions">
          {permission?.state === "not_asked" && (
            <Button
              disabled={busy}
              onClick={() => run(async () => setPermission(await requestMacNotifications()), "Notification permission couldn't be requested. Try again.")}
            >
              Allow notifications
            </Button>
          )}
          {(permission?.state === "denied" || permission?.state === "provisional") && settingsUrl && (
            <Button
              disabled={busy}
              onClick={() => run(() => openUrl(settingsUrl), "System Settings couldn't be opened. Open Notifications in System Settings.")}
            >
              Open System Settings
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await testMacNotification();
                setSent(true);
              }, "The test notification couldn't be sent. Check Notifications in System Settings, then try again.")
            }
          >
            Send a test notification
          </Button>
        </div>
        {sent && (
          <p className="settings-card-text" role="status">
            Test notification sent.
          </p>
        )}
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="settings-card" aria-labelledby="mac-notification-kinds">
        <h2 className="settings-card-title" id="mac-notification-kinds">
          What notifies you
        </h2>
        {settings ? (
          <>
            <Toggle label="Show notifications on this Mac" checked={settings.enabled} disabled={saving} onChange={(v) => change("enabled", v)} />
            <Toggle
              label="Also while Starkline is in front"
              checked={settings.in_front}
              disabled={saving || !settings.enabled}
              onChange={(v) => change("in_front", v)}
            />
            {CATEGORIES.map(({ key, label }) => (
              <Toggle key={key} label={label} checked={settings[key]} disabled={saving || !settings.enabled} onChange={(v) => change(key, v)} />
            ))}
          </>
        ) : (
          <SkeletonRows rows={3} label="Loading notification settings" />
        )}
      </section>
    </div>
  );
}
