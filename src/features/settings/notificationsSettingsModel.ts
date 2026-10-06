import type { MacNotifications, NotificationPermission } from "../../lib/types";

/** The backend's defaults (system_notifications.rs), for fields an older configuration doesn't have yet. */
export const MAC_NOTIFICATION_DEFAULTS: Required<MacNotifications> = {
  enabled: true,
  in_front: true,
  reminders: true,
  requests: true,
  work: true,
  code_review: true,
  automations: true,
  budget: true,
  checks: false,
  claims: false,
};

export function permissionLine(state: NotificationPermission["state"]): string {
  switch (state) {
    case "allowed":
      return "Starkline can show notifications on this Mac.";
    case "denied":
      return "Notifications are turned off for Starkline in System Settings.";
    case "not_asked":
      return "macOS hasn't asked yet.";
    case "provisional":
      return "macOS delivers them quietly to Notification Centre.";
    case "system":
      return "This build uses the system's notification settings.";
  }
}
