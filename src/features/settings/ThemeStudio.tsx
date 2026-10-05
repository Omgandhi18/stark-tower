import { useState } from "react";
import { Check, Eye, Info, Palette, X } from "lucide-react";
import { Button, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { setTheme } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import rndPreview from "../../assets/themes/after-hours-rnd/preview.webp";
import officePreview from "../../assets/themes/studio-office/preview.webp";
import moriPreview from "../../assets/themes/mori-cafe/preview.webp";
import { THEMES, asTheme, themeInfo, useActiveTheme, useThemePreview, type ThemeId } from "../../app/theme";
import { useConfig } from "../../stores/config";

const PREVIEWS: Record<ThemeId, string> = { rnd: rndPreview, office: officePreview, mori: moriPreview };

/** Each theme's own swatches, so a card shows its palette whatever theme is on. */
const SWATCHES: Record<ThemeId, readonly string[]> = {
  rnd: ["#10161d", "#2cc6d9", "#f3b03e"],
  office: ["#f1eadf", "#2b201a", "#3b7558"],
  mori: ["#111f25", "#3cbd78", "#f1a43a"],
};

/** Change how the whole app looks. Work, permissions and providers stay as they are. */
export default function ThemeStudio() {
  const config = useConfig((s) => s.config);
  const apply = useConfig((s) => s.apply);
  const preview = useThemePreview((s) => s.preview);
  const setPreview = useThemePreview((s) => s.setPreview);
  const active = useActiveTheme();
  const saved = asTheme(config?.theme);
  const [chosen, setChosen] = useState<ThemeId>(active);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (id: ThemeId) => {
    setChosen(id);
    setError(null);
    // While previewing, the preview follows the selection.
    if (preview) setPreview(id === saved ? null : id);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      apply(await setTheme(chosen));
      setPreview(null);
    } catch (e) {
      setError(errorMessage(e, "The theme couldn't be applied."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section theme-studio">
      <header className="screen-header theme-studio-head">
        <div>
          <h1 className="screen-title">Theme Studio</h1>
          <p className="screen-subtitle">Change how Starkline looks, from navigation to every screen.</p>
        </div>
        <p className="theme-studio-note">
          <Info aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          Tasks, permissions and providers don't change. Only how Starkline looks does.
        </p>
      </header>

      {preview && (
        <div className="theme-preview-bar" role="status">
          <Eye aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          <span>
            Previewing {themeInfo(preview).name}. Starkline goes back to {themeInfo(saved).name} unless you apply it.
          </span>
          <Button size="sm" variant="ghost" icon={X} onClick={() => setPreview(null)}>
            Stop previewing
          </Button>
        </div>
      )}

      <div className="theme-cards" role="radiogroup" aria-label="Themes">
        {THEMES.map((theme) => {
          const selected = theme.id === chosen;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cx("theme-card", selected && "is-selected")}
              onClick={() => choose(theme.id)}
            >
              <span className="theme-card-head">
                <span className="theme-card-name">{theme.name}</span>
                {theme.id === saved ? <Tag tone="accent">In use</Tag> : selected && <Check aria-hidden size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />}
              </span>
              <span className="theme-card-palette">
                <span className="theme-swatches" aria-hidden>
                  {SWATCHES[theme.id].map((c) => (
                    <span key={c} className="theme-swatch" style={{ background: c }} />
                  ))}
                </span>
                {theme.palette}
              </span>
              <span className="theme-card-description">{theme.description}</span>
              <span className="theme-card-preview">
                <img src={PREVIEWS[theme.id]} alt="" loading="lazy" />
              </span>
              <span className="theme-card-room">
                {theme.roomBuilt ? "Its room is the one on Environment." : "Its room isn't built yet: the team keeps working in After Hours R&D."}
              </span>
            </button>
          );
        })}
      </div>

      <section className="settings-card theme-appearance" aria-labelledby="theme-appearance-title">
        <h2 id="theme-appearance-title" className="settings-card-title">
          Agent appearance
        </h2>
        <p className="settings-card-text">
          Agents keep their own look in every theme. Outfits made for each theme come with its room. You can change an agent's look on Agents.
        </p>
      </section>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <footer className="theme-studio-actions">
        <Button icon={Eye} disabled={chosen === active} onClick={() => setPreview(chosen === saved ? null : chosen)}>
          Preview theme
        </Button>
        <Button variant="primary" icon={Palette} disabled={saving || chosen === saved} onClick={() => void save()}>
          {chosen === saved ? "Applied" : "Apply theme"}
        </Button>
      </footer>
    </div>
  );
}
