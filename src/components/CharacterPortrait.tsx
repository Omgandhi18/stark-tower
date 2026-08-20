import { useEffect, useMemo, useRef } from "react";
import { PORTRAIT_H, PORTRAIT_W, paintPortrait, resolveRecipe, type Recipe } from "../lib/charArt";

/** Renders a character's procedural portrait bust to a pixel-scaled canvas.
 *  Accepts either a resolved Recipe or an agent `figure` string. */
export default function CharacterPortrait({
  figure,
  recipe,
  size = 72,
}: {
  figure?: string;
  recipe?: Recipe;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const r = useMemo(() => recipe ?? resolveRecipe(figure), [recipe, figure]);
  const scale = Math.max(1, Math.round(size / PORTRAIT_H));
  const key = useMemo(() => JSON.stringify(r), [r]);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (ctx) paintPortrait(ctx, r, scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scale]);

  const px = { width: PORTRAIT_W * scale, height: PORTRAIT_H * scale };
  return (
    <canvas
      ref={ref}
      width={PORTRAIT_W * scale}
      height={PORTRAIT_H * scale}
      style={{ ...px, imageRendering: "pixelated", display: "block" }}
    />
  );
}
