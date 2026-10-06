import { useState } from "react";
import CharacterStudio from "../studio/CharacterStudio";
import { UserRound } from "lucide-react";
import { THEMES, outfitTheme, themeInfo, type Outfits, type ThemeId } from "../../app/theme";
import { portraitKey, Button, Portrait, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { AgentConfig } from "../../lib/types";

type Mode = "own" | "theme" | "other";

const MODES: ReadonlyArray<{ mode: Mode; label: string; detail: string }> = [
  { mode: "own", label: "Keep current appearance", detail: "Agents keep their own outfits in every theme." },
  { mode: "theme", label: "Use theme outfits", detail: "Agents wear the outfits designed for this theme." },
  { mode: "other", label: "Choose other outfits", detail: "Agents wear the outfits from another theme." },
];

/** How many of the team each theme's outfits are shown on. */
const SHOWN = 3;

const modeOf = (outfits: Outfits): Mode => (outfits === "own" || outfits === "theme" ? outfits : "other");

interface OutfitChooserProps {
  /** The theme being chosen: "theme outfits" means its outfits. */
  theme: ThemeId;
  outfits: Outfits;
  agents: readonly AgentConfig[];
  onChange: (outfits: Outfits) => void;
}

/** What the agents wear, shown on the first few of the team in each theme's outfits. */
export default function OutfitChooser({ theme, outfits, agents, onChange }: OutfitChooserProps) {
  const [studioAgent, setStudioAgent] = useState<AgentConfig | null>(null);
  const mode = modeOf(outfits);
  // The theme whose outfits are worn; the agents' own look is After Hours R&D's.
  const worn = outfitTheme(outfits, theme) ?? THEMES[0].id;
  const shown = agents.filter((a) => a.kind !== "maintenance" && a.enabled !== false).slice(0, SHOWN);

  const chooseMode = (next: Mode) => {
    if (next === "other") onChange(THEMES.find((t) => t.id !== theme)?.id ?? THEMES[0].id);
    else onChange(next);
  };

  return (
    <section className="settings-card theme-appearance" aria-labelledby="theme-appearance-title">
      <div className="theme-appearance-head">
        <span className="theme-appearance-icon" aria-hidden>
          <UserRound size={ICON_SIZE.xl} strokeWidth={ICON_STROKE} />
        </span>
        <div className="theme-appearance-title">
          <h2 id="theme-appearance-title" className="settings-card-title">
            Agent appearance
          </h2>
          <p className="settings-card-text">How agents look in this theme.</p>
        </div>
        <div className="outfit-modes" role="radiogroup" aria-label="Agent appearance">
          {MODES.map(({ mode: option, label, detail }) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={cx("outfit-mode", mode === option && "is-selected")}
              onClick={() => chooseMode(option)}
            >
              <span className="outfit-mode-mark" aria-hidden />
              <span className="outfit-mode-text">
                <span className="outfit-mode-label">{label}</span>
                <span className="outfit-mode-detail">{detail}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="outfit-sets" role={mode === "other" ? "radiogroup" : undefined} aria-label={mode === "other" ? "Outfits" : undefined}>
        {THEMES.map((set) => {
          const wearing = set.id === worn;
          const folder = outfitTheme(set.id, set.id) ? set.folder : null;
          const people = shown.map((a) => (
            <span key={a.id} className="outfit-person">
              <Portrait name={a.name} figure={portraitKey(a)} accent={a.accent} size={64} outfits={folder} />
              <span className="outfit-person-name">{a.name}</span>
            </span>
          ));
          return mode === "other" ? (
            <button
              key={set.id}
              type="button"
              role="radio"
              aria-checked={wearing}
              disabled={set.id === theme}
              title={set.id === theme ? `${set.name}'s own outfits are "Use theme outfits".` : undefined}
              className={cx("outfit-set", wearing && "is-selected")}
              onClick={() => onChange(set.id)}
            >
              <span className="outfit-set-name">{set.name}</span>
              <span className="outfit-people">{people}</span>
            </button>
          ) : (
            <div
              key={set.id}
              className={cx("outfit-set", wearing && "is-selected")}
              aria-label={wearing ? `Wearing ${themeInfo(worn).name}'s outfits` : undefined}
            >
              <span className="outfit-set-name">{set.name}</span>
              <span className="outfit-people">{people}</span>
            </div>
          );
        })}
      </div>
      <div className="studio-chips">{agents.map((a) => <Button key={a.id} onClick={() => setStudioAgent(a)}>Open Character Studio · {a.name}</Button>)}</div>
      {studioAgent && <CharacterStudio agent={studioAgent} onClose={() => setStudioAgent(null)} />}
    </section>
  );
}
