import { useEffect } from "react";
import { useNavigation } from "../stores/navigation";
import { useTerminal } from "../stores/terminal";
import { NAV_ITEMS } from "./routes";

/** ⌘1 to ⌘7 jump between the destinations from anywhere. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`")) {
        const route = useNavigation.getState().route;
        if (route === "conversation" || route === "task") { e.preventDefault(); useTerminal.getState().toggle(); }
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
