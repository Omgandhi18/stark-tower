import { cx } from "../../design";
import { worldToScreen, type Camera, type Size } from "../../environment/reference/camera";
import type { Rect } from "../../environment/reference/referenceAssets";
import type { BoardJson } from "../../environment/reference/rooms";

export interface BoardCounts {
  running: number;
  awaitingReview: number;
  blocked: number;
}

interface TodayBoardProps {
  board: BoardJson;
  /** The room's rect in its mockup, to place the board in the world. */
  roomRect: Rect;
  counts: BoardCounts;
  camera: Camera;
  view: Size;
}

/** The cafe's "Starkline Today" board, written with the real numbers and moving with the room. */
export default function TodayBoard({ board, roomRect, counts, camera, view }: TodayBoardProps) {
  const anchor = worldToScreen({ x: board.at[0] - roomRect[0], y: board.at[1] - roomRect[1] }, camera, view);
  // Dots in the board's own paint: green, orange, and grey until something is blocked.
  const lines: ReadonlyArray<{ id: string; dot: string; text: string }> = [
    { id: "running", dot: "is-running", text: `${counts.running} ${counts.running === 1 ? "agent" : "agents"} running` },
    { id: "review", dot: "is-waiting", text: `${counts.awaitingReview} awaiting review` },
    { id: "blocked", dot: counts.blocked ? "is-blocked" : "is-clear", text: `${counts.blocked} blocked` },
  ];
  return (
    <ul
      className="today-board"
      aria-label="Starkline today"
      style={{
        left: anchor.x,
        top: anchor.y,
        fontSize: board.fontSize,
        // Painted on: scaled with the room and slanted like the board, its first line centred on the anchor.
        transform: `scale(${camera.zoom}) skewY(${-board.slant}deg) translateY(${-board.lineHeight / 2}px)`,
      }}
    >
      {lines.map(({ id, dot, text }) => (
        <li key={id} className="today-board-line" style={{ height: board.lineHeight }}>
          <span className={cx("today-board-dot", dot)} aria-hidden />
          {text}
        </li>
      ))}
    </ul>
  );
}
