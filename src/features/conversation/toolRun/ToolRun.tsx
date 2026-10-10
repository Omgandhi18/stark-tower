import { useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../../design";
import type { ChatMessage } from "../../../stores/chats";
import ToolCallRow, { CallText } from "./ToolCallRow";
import { callLabel, callState, summarizeCalls } from "./toolRunModel";
import "./toolRun.css";

/**
 * A run of consecutive tool calls under one summary line. Closed, the call in progress stays
 * in view; opened, every call is a row that opens to what it was given and what came back.
 */
export default function ToolRun({ calls, live }: { calls: readonly ChatMessage[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = live ? calls.filter((c) => callState(c, true) === "running") : [];
  const current = running[running.length - 1];
  return (
    <div className={cx("tool-run", open && "is-open")}>
      <button type="button" className="tool-run-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tool-run-summary">{summarizeCalls(calls, live)}</span>
        <ChevronRight aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="tool-run-chevron" />
      </button>
      {current && !open && (
        <p className="tool-run-now" role="status">
          <LoaderCircle aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="spin-slow" />
          <CallText label={callLabel(current, "running")} />
        </p>
      )}
      {open && (
        <ul className="tool-run-list">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} live={live} />
          ))}
        </ul>
      )}
    </div>
  );
}
