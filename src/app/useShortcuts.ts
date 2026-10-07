import { useEffect } from "react";
import { useNavigation } from "../stores/navigation";
import { usePanels } from "../stores/panels";
import { useTerminal } from "../stores/terminal";
import { panelFor } from "./panelShortcuts";
import { NAV_ITEMS } from "./routes";

/** ⌘1 to ⌘7 jump between the destinations from anywhere; ⌘B (and on a task ⇧⌘B, ⌥⌘B) collapse the side panels. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`")) {
        if (useNavigation.getState().route === "task") { e.preventDefault(); useTerminal.getState().toggle(); }
        return;
      }
      const panel = panelFor(e, useNavigation.getState().route);
      if (panel) {
        e.preventDefault();
        usePanels.getState().toggle(panel);
        return;
      }
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
      const item = NAV_ITEMS.find((n) => n.shortcut === e.key);
      if (!item) return;
      e.preventDefault();
      useNavigation.getState().navigate(item.route);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
