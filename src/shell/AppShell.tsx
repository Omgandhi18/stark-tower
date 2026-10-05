import type { ReactNode } from "react";
import { cx } from "../design";
import { HAS_LEFT_WINDOW_CONTROLS } from "../lib/platform";
import SideNav from "./SideNav";
import TopBar from "./TopBar";
import "./shell.css";

/** Top bar across the window, sidebar on the left, the current screen beside it. */
export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={cx("app-shell", HAS_LEFT_WINDOW_CONTROLS && "has-window-controls")}>
      <TopBar />
      <SideNav />
      <main className="app-main" id="main">
        {children}
      </main>
    </div>
  );
}
