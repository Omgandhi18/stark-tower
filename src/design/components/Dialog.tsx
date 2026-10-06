import { useEffect, useId, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import { registerOverlay } from "../overlays";

interface DialogProps {
  open: boolean;
  /** Called on Escape or a click outside, when the dialog may be dismissed. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: "neutral" | "danger" | "attention";
  /** Buttons, right-aligned; put the safe choice first. */
  actions: ReactNode;
  children?: ReactNode;
  dismissible?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** A modal on the native <dialog>: focus stays inside, Escape closes, the page behind is inert. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = "neutral",
  actions,
  children,
  dismissible = true,
  size = "sm",
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    // A modal dims the whole window: a native view laid over it steps aside.
    return open ? registerOverlay(dialog, true) : undefined;
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx("dialog", `dialog-${size}`, `dialog-${tone}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-surface">
          <header className="dialog-head">
            {Icon && (
              <span className="dialog-icon" aria-hidden>
                <Icon size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />
              </span>
            )}
            <div className="dialog-heading">
              <h2 id={titleId} className="dialog-title">
                {title}
              </h2>
              {description && (
                <div id={descriptionId} className="dialog-description">
                  {description}
                </div>
              )}
            </div>
          </header>
          {children && <div className="dialog-content">{children}</div>}
          <footer className="dialog-actions">{actions}</footer>
        </div>
      )}
    </dialog>
  );
}
