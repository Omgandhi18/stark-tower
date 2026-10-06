import { describe, expect, it } from "vitest";
import { MAC_NOTIFICATION_DEFAULTS, permissionLine } from "./notificationsSettingsModel";

describe("notification permission wording", () => {
  it("describes each system permission without claiming it was granted", () => {
    expect(permissionLine("allowed")).toBe("Starkline can show notifications on this Mac.");
    expect(permissionLine("denied")).toBe("Notifications are turned off for Starkline in System Settings.");
    expect(permissionLine("not_asked")).toBe("macOS hasn't asked yet.");
    expect(permissionLine("provisional")).toBe("macOS delivers them quietly to Notification Centre.");
    expect(permissionLine("system")).toBe("This build uses the system's notification settings.");
  });
  it("starts with everything on except agents' own checks and file claims", () => {
    const off = Object.entries(MAC_NOTIFICATION_DEFAULTS).filter(([, on]) => !on);
    expect(off.map(([key]) => key)).toEqual(["checks", "claims"]);
  });
});
