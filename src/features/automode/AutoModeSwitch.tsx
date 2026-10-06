import { useState } from "react";
import { Toggle, cx } from "../../design";
import { errorMessage } from "../../lib/errors";
import { useAutoMode } from "../../stores/autoMode";
import { AUTO_MODE_GOES_AHEAD, AUTO_MODE_REACH, AUTO_MODE_STILL_ASKS, useAutoModeOf } from "./autoMode";
import "./autoMode.css";

interface AutoModeSwitchProps {
  conversationId: number;
  className?: string;
}

/** Auto mode on or off for a conversation, with what it lets go ahead and what still asks. */
export default function AutoModeSwitch({ conversationId, className }: AutoModeSwitchProps) {
  const on = useAutoModeOf(conversationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: boolean) => {
    setBusy(true);
    setError(null);
    useAutoMode
      .getState()
      .set(conversationId, next)
      .catch((e) => setError(errorMessage(e, "Auto mode couldn't be changed.")))
      .finally(() => setBusy(false));
  };

  return (
    <div className={cx("auto-mode", on && "is-on", className)}>
      <Toggle label="Auto mode" checked={on === true} disabled={busy || on === undefined} onChange={change} description={AUTO_MODE_GOES_AHEAD} />
      <p className="auto-mode-note">
        {AUTO_MODE_STILL_ASKS} {AUTO_MODE_REACH}
      </p>
      {error && (
        <p className="auto-mode-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
