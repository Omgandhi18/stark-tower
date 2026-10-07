import type { ReactNode } from "react";
import { cx } from "../design";
import ReminderToasts from "../features/reminders/ReminderToasts";
import { HAS_LEFT_WINDOW_CONTROLS } from "../lib/platform";
import { usePanels } from "../stores/panels";
import SideNav from "./SideNav";
import TopBar from "./TopBar";
import "./shell.css";

/** Top bar across the window, sidebar on the left, the current screen beside it. */
export default function AppShell({ children }: { children: ReactNode }) {
  const navCollapsed = usePanels((s) => s.collapsed.sidebar);
  return (
    <div className={cx("app-shell", HAS_LEFT_WINDOW_CONTROLS && "has-window-controls", navCollapsed && "is-nav-collapsed")}>
      <TopBar />
      <SideNav />
      <main className="app-main" id="main">
        {children}
      </main>
      <ReminderToasts />
    </div>
  );
}
