// The cafe's own corners: the local time with where the room is, and a pill
// naming the room. Both sit over the scene and never take clicks.
import { useEffect, useState } from "react";
import { Sprout } from "lucide-react";
import { ICON_SIZE, ICON_STROKE } from "../../design";
import type { FrameJson } from "../../environment/reference/rooms";

const MS_PER_MINUTE = 60_000;
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The current time, updated on the minute. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        MS_PER_MINUTE - (Date.now() % MS_PER_MINUTE),
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

export function RoomClock({ place }: { place: readonly string[] }) {
  const now = useMinuteClock();
  return (
    <div className="room-clock">
      <time className="room-clock-time tabular" dateTime={now.toISOString()}>
        {TIME.format(now)}
      </time>
      <span className="room-clock-place">{place.join(" • ")}</span>
    </div>
  );
}

export function RoomCaption({ caption }: { caption: NonNullable<FrameJson["caption"]> }) {
  return (
    <div className="room-caption">
      <Sprout className="room-caption-icon" aria-hidden size={ICON_SIZE.xl} strokeWidth={ICON_STROKE} />
      <span className="room-caption-name">
        <span className="room-caption-title">{caption.title}</span>
        <span className="room-caption-subtitle">{caption.subtitle}</span>
      </span>
      <span className="room-caption-divider" aria-hidden />
      <span className="room-caption-note">
        {caption.note.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </div>
  );
}
