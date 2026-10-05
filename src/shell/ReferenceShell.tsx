// Starkline application shell for the After Hours R&D theme: the mockup's top
// bar and sidebar around whichever screen is active.
import type { ReactNode } from "react";
import type { NavItemId } from "../environment/reference/referenceAssets";
import type { SupervisorHealth } from "../environment/reference/referenceState";
import SideNav from "./SideNav";
import TopBar from "./TopBar";
import "./shell.css";

interface Props {
  supervisor: SupervisorHealth;
  notifications: number;
  keepAwake: boolean;
  activeNav: NavItemId;
  onToggleKeepAwake: () => void;
  onNavigate: (id: NavItemId) => void;
  children: ReactNode;
}

export default function ReferenceShell({
  supervisor,
  notifications,
  keepAwake,
  activeNav,
  onToggleKeepAwake,
  onNavigate,
  children,
}: Props) {
  return (
    <div className="rnd-shell">
      <TopBar
        supervisor={supervisor}
        notifications={notifications}
        keepAwake={keepAwake}
        onToggleKeepAwake={onToggleKeepAwake}
        onOpenNotifications={() => onNavigate("notifications")}
      />
      <div className="rnd-shell-body">
        <SideNav active={activeNav} notifications={notifications} onNavigate={onNavigate} />
        <main className="rnd-shell-content">{children}</main>
      </div>
    </div>
  );
}
