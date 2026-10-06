import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmptyState, IconButton, covered, cx, onOverlaysChanged } from "../../design";
import { browserGo, browserHide, browserNavigate, browserShow } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { usePreview } from "../../stores/preview";

/** How often the browser checks it's still over its panel (things move without resizing it). */
const TRACK_MS = 400;

const report = (what: string) => (e: unknown) => console.error(`[browser] couldn't ${what}`, e);

/**
 * The built-in browser: an address bar over a real browser view, which the backend lays over
 * this panel. It follows the panel as it moves and steps aside while anything is drawn over it.
 */
export default function BrowserView({ active }: { active: boolean }) {
  const page = usePreview((s) => s.page);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasPage = page.url !== "";

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !active || !hasPage) {
      browserHide().catch(report("hide"));
      return;
    }
    let last = "";
    const sync = () => {
      const r = el.getBoundingClientRect();
      const away = r.width < 2 || r.height < 2 || covered(r);
      const key = away ? "away" : `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key === last) return;
      last = key;
      if (away) browserHide().catch(report("hide"));
      else browserShow({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(report("show"));
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(el);
    const stopOverlays = onOverlaysChanged(sync);
    const timer = window.setInterval(sync, TRACK_MS);
    window.addEventListener("resize", sync);
    return () => {
      observer?.disconnect();
      stopOverlays();
      window.clearInterval(timer);
      window.removeEventListener("resize", sync);
      browserHide().catch(report("hide"));
    };
  }, [active, hasPage]);

  const open = (address: string) => {
    setError(null);
    browserNavigate(address)
      .then(() => setTyped(null))
      .catch((e) => setError(errorMessage(e, "That page couldn't be opened.")));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && typed?.trim()) {
      e.preventDefault();
      open(typed);
    } else if (e.key === "Escape") {
      setTyped(null);
    }
  };

  return (
    <div className="browser-view">
      <div className="browser-toolbar">
        <IconButton icon={ArrowLeft} label="Back" size="sm" disabled={!hasPage} onClick={() => browserGo("back").catch(report("go back"))} />
        <IconButton icon={ArrowRight} label="Forward" size="sm" disabled={!hasPage} onClick={() => browserGo("forward").catch(report("go forward"))} />
        {page.loading ? (
          <IconButton icon={X} label="Stop loading" size="sm" onClick={() => browserGo("stop").catch(report("stop"))} />
        ) : (
          <IconButton icon={RotateCw} label="Reload" size="sm" disabled={!hasPage} onClick={() => browserGo("reload").catch(report("reload"))} />
        )}
        <input
          className="input browser-address"
          aria-label="Address"
          placeholder="Type an address, or localhost:5173"
          spellCheck={false}
          autoComplete="off"
          value={typed ?? page.url}
          onChange={(e) => setTyped(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={onKeyDown}
        />
        <IconButton icon={ExternalLink} label="Open in your browser" size="sm" disabled={!hasPage} onClick={() => openUrl(page.url).catch(report("open the page outside"))} />
        <span className={cx("browser-progress", page.loading && "is-loading")} aria-hidden />
      </div>
      {error && (
        <p className="field-error browser-error" role="alert">
          {error}
        </p>
      )}
      <div ref={viewportRef} className="browser-viewport" aria-label={page.title || page.url || "Browser"} role="region">
        {!hasPage && (
          <EmptyState
            compact
            icon={Globe}
            title="Open a page"
            body="Type an address above, or ask an agent to open your app: “open localhost:5173 in the browser and check the settings page.”"
          />
        )}
      </div>
    </div>
  );
}
