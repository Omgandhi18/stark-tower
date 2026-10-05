import { Moon } from "lucide-react";
import { Toggle, ICON_SIZE, ICON_STROKE } from "../../design";
import { useSystem } from "../../stores/system";

/** Keep Awake: what it does, and what it is doing right now. */
export default function PowerSettings() {
  const power = useSystem((s) => s.power);
  const toggleKeepAwake = useSystem((s) => s.toggleKeepAwake);

  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">Power</h1>
        <p className="screen-subtitle">Long tasks shouldn't stop because your Mac went to sleep.</p>
      </header>
      <section className="settings-card">
        <Toggle
          label="Keep this Mac awake while agents work"
          checked={power?.enabled ?? false}
          disabled={!power?.supported}
          description={power?.supported === false ? "Keep Awake isn't available on this system." : undefined}
          onChange={(on) => {
            toggleKeepAwake(on).catch((e) => console.error("[power] couldn't change Keep Awake", e));
          }}
        />
        {power && (
          <p className="power-now" role="status">
            <Moon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            {power.reason}
          </p>
        )}
      </section>
      <section className="settings-card">
        <h2 className="settings-card-title">How it works</h2>
        <ul className="settings-facts">
          <li>The Mac stays awake only while at least one agent is working or thinking.</li>
          <li>If an agent stops to wait for you, it stays awake for up to 10 more minutes, then the Mac may sleep.</li>
          <li>Your display can still turn off, and closing the lid still puts the Mac to sleep.</li>
          <li>Agent sessions run inside Starkline, so quitting the app ends them whatever this setting is.</li>
        </ul>
      </section>
    </div>
  );
}
