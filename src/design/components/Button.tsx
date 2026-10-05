import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "attention" | "review";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Icon after the label (e.g. a chevron). */
  trailingIcon?: LucideIcon;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, trailingIcon: Trailing, children, className, type = "button", ...rest },
  ref,
) {
  const iconSize = size === "sm" ? ICON_SIZE.sm : ICON_SIZE.md;
  return (
    <button ref={ref} type={type} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)} {...rest}>
      {Icon && <Icon aria-hidden size={iconSize} strokeWidth={ICON_STROKE} />}
      {children && <span className="btn-label">{children}</span>}
      {Trailing && <Trailing aria-hidden size={iconSize} strokeWidth={ICON_STROKE} />}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Required: an icon-only control needs a spoken name. */
  label: string;
  size?: ButtonSize;
  variant?: "ghost" | "secondary";
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = "md", variant = "ghost", pressed, className, type = "button", title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      className={cx("icon-btn", `icon-btn-${variant}`, `icon-btn-${size}`, className)}
      {...rest}
    >
      <Icon aria-hidden size={size === "sm" ? ICON_SIZE.sm : ICON_SIZE.lg} strokeWidth={ICON_STROKE} />
    </button>
  );
});
