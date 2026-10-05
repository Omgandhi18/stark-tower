// The floating status card (mockup 04 shows it over FRIDAY). The panel is the
// mockup's own pixels with its text cleared; name, status and task are live.
import { assetUrl, reference, rectHeight, rectWidth, relativeTo } from "./referenceAssets";
import type { CardContent } from "./referenceState";
import { textStyle } from "./typography";

const PANEL = reference.panels.agentCard;
const TEXT = reference.text;
const inCard = (r: (typeof TEXT)[keyof typeof TEXT]["rect"]) => relativeTo(r, PANEL.rect);
const DOT = relativeTo(reference.sprites.cardDot.rect, PANEL.rect);
const TASK = inCard(TEXT.cardTask.rect);
const CHEVRON_CLEARANCE = 30;

export const CARD_SIZE = { width: rectWidth(PANEL.rect), height: rectHeight(PANEL.rect) } as const;

interface Props {
  content: CardContent;
  left: number;
  top: number;
}

export default function AgentCard({ content, left, top }: Props) {
  return (
    <div
      className="rnd-card"
      role="status"
      aria-label={`${content.name}: ${content.status}. ${content.task}`}
      style={{ left, top, ...CARD_SIZE, backgroundImage: `url(${assetUrl(PANEL.file)})` }}
    >
      <img
        className="rnd-card-dot"
        src={assetUrl(reference.sprites.cardDot.file)}
        alt=""
        style={{ left: DOT[0], top: DOT[1], width: rectWidth(DOT), height: rectHeight(DOT), filter: content.dotFilter }}
      />
      <span style={textStyle("cardName", inCard(TEXT.cardName.rect), reference.colors.cardName)}>
        {content.name}
      </span>
      <span style={textStyle("cardStatus", inCard(TEXT.cardStatus.rect), content.statusColor)}>
        {content.status}
      </span>
      <span
        className="rnd-card-task"
        style={{
          ...textStyle("cardTask", TASK, reference.colors.cardTask),
          maxWidth: CARD_SIZE.width - TASK[0] - CHEVRON_CLEARANCE,
        }}
      >
        {content.task}
      </span>
    </div>
  );
}
