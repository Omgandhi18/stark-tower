import { MousePointerClick, Quote, X, type LucideIcon } from "lucide-react";
import { IconButton, ICON_SIZE, ICON_STROKE } from "../../../design";
import { selectThread, useChats, type ChatKey, type ComposerReference } from "../../../stores/chats";
import { fileUrl } from "../../attachments/fileUrl";
import { describeReference } from "./referenceModel";
import "./references.css";

interface ReferenceChipProps {
  icon: LucideIcon;
  /** A picture that stands for it (a point's marked screenshot). */
  thumb?: string;
  title: string;
  meta?: string[];
  removeLabel: string;
  onRemove: () => void;
}

/** One thing attached to the message being written: what it is, in a line or two, and a way to take it off. */
function ReferenceChip({ icon: Icon, thumb, title, meta = [], removeLabel, onRemove }: ReferenceChipProps) {
  return (
    <li className="reference-chip">
      {thumb ? (
        <img className="reference-chip-thumb" src={thumb} alt="" />
      ) : (
        <span className="reference-chip-icon" aria-hidden>
          <Icon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
        </span>
      )}
      <span className="reference-chip-text">
        <span className="reference-chip-title" title={title}>{title}</span>
        {meta.length > 0 && <span className="reference-chip-meta">{meta.join(" · ")}</span>}
      </span>
      <IconButton icon={X} label={removeLabel} size="sm" onClick={onRemove} />
    </li>
  );
}

const ICON: Record<ComposerReference["kind"], LucideIcon> = { quote: Quote, point: MousePointerClick };

/** The quotes and points attached to the message being written, each removable. */
export function ReferenceTray({ chatKey }: { chatKey: ChatKey }) {
  const references = useChats((s) => selectThread(chatKey)(s).references);
  const remove = useChats((s) => s.removeReference);
  if (!references.length) return null;
  return (
    <ul className="reference-tray" aria-label="Quoted and pointed-at">
      {references.map((ref) => {
        const look = describeReference(ref);
        return (
          <ReferenceChip
            key={ref.id}
            icon={ICON[ref.kind]}
            thumb={ref.kind === "point" && ref.image?.kind === "image" ? fileUrl(ref.image.path) : undefined}
            title={look.title}
            meta={look.meta}
            removeLabel={ref.kind === "quote" ? "Remove quote" : `Remove ${look.title}`}
            onRemove={() => remove(chatKey, ref.id)}
          />
        );
      })}
    </ul>
  );
}
