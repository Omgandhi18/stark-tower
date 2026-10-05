import { Building2 } from "lucide-react";
import { themeInfo } from "../../app/theme";
import { ICON_SIZE, ICON_STROKE } from "../../design";
import type { Room } from "../../environment/reference/rooms";

interface RoomHeaderProps {
  room: Room;
  motto: readonly string[];
}

/** The title bar a room's mockup draws above it (Studio Office): its name, what it's like, and its motto. */
export default function RoomHeader({ room, motto }: RoomHeaderProps) {
  const theme = themeInfo(room.id);
  return (
    <header className="room-header">
      <span className="room-header-icon" aria-hidden>
        <Building2 size={ICON_SIZE.xl} strokeWidth={ICON_STROKE} />
      </span>
      <span className="room-header-text">
        <h1 className="room-header-title">{theme.name}</h1>
        <span className="room-header-description">{theme.description}</span>
      </span>
      <span className="room-header-motto" aria-hidden>
        {motto.map((line) => (
          <span key={line} className="room-header-motto-line">
            {line}
          </span>
        ))}
      </span>
    </header>
  );
}
