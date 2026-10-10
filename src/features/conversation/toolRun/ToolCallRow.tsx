import { useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE, Tag } from "../../../design";
import { presentTool } from "../../../lib/tools";
import type { ChatMessage } from "../../../stores/chats";
import { AttachmentGallery } from "../../attachments/AttachmentView";
import CodeBlock from "./CodeBlock";
import { callInput, callLabel, callState, droppedImages, droppedImagesNote, hasDetails, outputText, type CallLabel } from "./toolRunModel";

/** A call in words: the verb in the reading font, what it worked on as code. */
export function CallText({ label, className }: { label: CallLabel; className?: string }) {
  return (
    <span className={cx("tool-call-text", className)} title={label.full}>
      {label.lead}
      {label.code && (
        <>
          {" "}
          <code className="tool-call-code">{label.code}</code>
        </>
      )}
    </span>
  );
}

/** One tool call: what it was, whether it failed, and (opened) what it was given and what came back. */
export default function ToolCallRow({ call, live }: { call: ChatMessage; live: boolean }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon } = presentTool(call.tool);
  const state = callState(call, live);
  const openable = hasDetails(call);
  const dropped = droppedImages(call);
  const head = (
    <>
      <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="tool-call-icon" />
      <CallText label={callLabel(call, state)} />
      {state === "failed" && <Tag tone="danger">Failed</Tag>}
      {state === "noresult" && <Tag>No result</Tag>}
      {dropped > 0 && <Tag tone="attention">{droppedImagesNote(dropped)}</Tag>}
      {state === "running" && <LoaderCircle aria-label="Running" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="tool-call-running spin-slow" />}
      {openable && <ChevronRight aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="tool-call-chevron" />}
    </>
  );
  return (
    <li className={cx("tool-call", `is-${state}`, open && "is-open")}>
      {openable ? (
        <button type="button" className="tool-call-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="tool-call-head">{head}</div>
      )}
      {open && <ToolCallBody call={call} />}
    </li>
  );
}

function ToolCallBody({ call }: { call: ChatMessage }) {
  const input = callInput(call);
  const output = outputText(call);
  const images = (call.attachments ?? []).filter((f) => f.kind === "image");
  const finished = Boolean(call.result);
  const dropped = droppedImages(call);
  return (
    <div className="tool-call-body">
      {input.command && <Section title="Command"><CodeBlock text={input.command} label="Command" /></Section>}
      {input.path && (
        <Section title="Path">
          <p className="tool-call-path mono selectable">{input.path}</p>
        </Section>
      )}
      {input.args && <Section title="Arguments"><CodeBlock text={input.args} label="Arguments" /></Section>}
      {output && <Section title="Output"><CodeBlock text={output} label="Output" /></Section>}
      {images.length > 0 && (
        <Section title={images.length === 1 ? "Image" : "Images"}>
          <AttachmentGallery files={images} compact />
        </Section>
      )}
      {dropped > 0 && <p className="tool-call-empty" role="note">{droppedImagesNote(dropped)}.</p>}
      {finished && !output && images.length === 0 && dropped === 0 && <p className="tool-call-empty">No output.</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="tool-call-section">
      <h4 className="tool-call-section-title">{title}</h4>
      {children}
    </section>
  );
}
