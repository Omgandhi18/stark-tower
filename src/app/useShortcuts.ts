import { useEffect } from "react";
import { useNavigation } from "../stores/navigation";
import { NAV_ITEMS } from "./routes";

/** ⌘1 to ⌘6 jump between the six destinations from anywhere. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
